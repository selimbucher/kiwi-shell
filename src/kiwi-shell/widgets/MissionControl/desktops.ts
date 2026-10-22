import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

import { logger } from "../../log"
import { focusWorkspace, moveWindowToWorkspace, keepDesktops, pluginsReady, evalLua, dialect, registerBindSetup } from "../../hypr"
import { isValidClient } from "../Dock/dock-state"

const log = logger("desktops")
const hyprland = Hyprland.get_default()

// ─── Desktops ─────────────────────────────────────────────────────────────────
// What macOS calls Spaces: each display has its own row of desktops, in
// order, and a desktop stays until it is closed, empty or not — across
// logins too. Here a desktop is a Hyprland workspace, and a display's desktops
// are the workspaces on its monitor, by id. Every workspace that turns up on a
// monitor becomes one of its desktops; one goes when it is closed in Mission
// Control. The list is saved, and kiwi's plugin keeps each desktop as a
// workspace even while it is empty (src/hyprland-plugin/desktops.cpp), so
// Hyprland's workspace swipe goes through exactly these. Without the plugin
// the empty ones are only the shell's.

export type Monitor = {
    name: string
    // where it is in the layout and its logical size, which client
    // coordinates are measured in
    x: number
    y: number
    width: number
    height: number
    scale: number
    active: number
}

export type Window = {
    address: string // with the 0x
    client: Hyprland.Client
    title: string
    x: number
    y: number
    width: number
    height: number
    floating: boolean
    focusHistory: number
    // where it is in its desktop's stack, 0 at the bottom
    stack: number
}

function query(what: string): any[] {
    try {
        return JSON.parse(hyprland.message(`j/${what}`))
    } catch (e) {
        log.error(`reading ${what}:`, e as Error)
        return []
    }
}

export function monitors(): Monitor[] {
    return query("monitors").map(m => {
        const rotated = m.transform % 2 === 1
        const scale = m.scale || 1
        return {
            name: m.name,
            x: m.x,
            y: m.y,
            width: (rotated ? m.height : m.width) / scale,
            height: (rotated ? m.width : m.height) / scale,
            scale,
            active: m.activeWorkspace?.id ?? 0,
        }
    })
}

export const monitorNamed = (name: string) => monitors().find(m => m.name === name) ?? null

export function focusedMonitor(): Monitor | null {
    const name = hyprland.get_focused_monitor()?.get_name()
    const all = monitors()
    return all.find(m => m.name === name) ?? all[0] ?? null
}

// the desktops by monitor name, in order, as saved
const STATE_FILE = `${GLib.get_user_state_dir()}/kiwi-shell/desktops.json`
const desktops = new Map<string, number[]>(load())

function load(): [string, number[]][] {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE)
        const saved = JSON.parse(new TextDecoder().decode(bytes))
        return Object.entries(saved).filter(([, ids]) => Array.isArray(ids))
            .map(([name, ids]) => [name, (ids as unknown[]).filter((id): id is number => Number.isInteger(id) && (id as number) > 0)])
    } catch {
        return []
    }
}

let saved = JSON.stringify(Object.fromEntries(desktops))
function save() {
    const text = JSON.stringify(Object.fromEntries(desktops))
    if (text === saved) return
    saved = text
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o755)
        GLib.file_set_contents(STATE_FILE, text)
    } catch (e) {
        log.error("saving the desktops:", e as Error)
    }
}

// desktops being closed: still workspaces until Hyprland lets them go, and
// not to be taken back in meanwhile
const closing = new Set<number>()

// What Hyprland has now brought into the list: a workspace on a monitor is
// that monitor's desktop, and no other's.
function reconcile() {
    const workspaces = query("workspaces").filter(w => w.id > 0)
    for (const id of closing)
        if (!workspaces.some(w => w.id === id)) closing.delete(id)
    for (const [name, ids] of desktops) {
        const elsewhere = new Set(workspaces.filter(w => w.monitor !== name).map(w => w.id))
        desktops.set(name, ids.filter(id => !elsewhere.has(id)))
    }
    for (const w of workspaces) {
        if (closing.has(w.id)) continue
        const ids = desktops.get(w.monitor) ?? []
        if (!ids.includes(w.id)) desktops.set(w.monitor, [...ids, w.id].sort((a, b) => a - b))
    }
}

// what wants to know when a display's row changes: the bar's desktops
const watchers = new Set<() => void>()

/** Call `changed` whenever a display's desktops change; returns the stop. */
export function watchDesktops(changed: () => void): () => void {
    watchers.add(changed)
    return () => void watchers.delete(changed)
}

let lastKept = ""
function sync() {
    reconcile()
    save()
    const kept = JSON.stringify([...desktops])
    if (kept === lastKept) return
    lastKept = kept
    void keepDesktops(desktops)
    for (const changed of watchers) changed()
}

let syncSource = 0
function syncSoon() {
    if (syncSource) return
    syncSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        syncSource = 0
        sync()
        return GLib.SOURCE_REMOVE
    })
}

// ─── Going from desktop to desktop ────────────────────────────────────────────
// The slide is macOS's, measured off a 60 fps recording of Control+arrow
// switches on a Mac (docs/macos-differences.md has how): the whole screen
// moves sideways as one, with a gap of about 3.3% of its width between the
// desktops, on a spring that is 50% there after about 140 ms, 90% after
// 300 ms and still 99% after 450 ms — ω ≈ 12/s, damping ratio ≈ 0.9, so no
// overshoot to speak of. Hyprland runs springs in real time (hyprutils
// Spring.cpp): mass 1, stiffness ω² = 144, damping 2ζω = 21.6.
//
// The shell sets it rather than the user's config, as it does the blur, and
// again after every config reload, which brings the config's own back.
const DESKTOP_SPRING = { mass: 1, stiffness: 144, dampening: 21.6 }
// at 1440 logical pixels wide, 3.3% of the width
const DESKTOP_GAP = 48
// the workspaces' animations, and the two the config may split them into
const DESKTOP_LEAVES = ["workspaces", "workspacesIn", "workspacesOut"]

async function applyDesktopMotion() {
    if (await dialect() !== "lua") {
        log.warn("the macOS desktop slide needs Hyprland's lua config (spring curves)")
        return
    }
    const spring = Object.entries(DESKTOP_SPRING).map(([k, v]) => `${k} = ${v}`).join(", ")
    await evalLua([
        `hl.curve("kiwiDesktop", { type = "spring", ${spring} })`,
        ...DESKTOP_LEAVES.map(leaf =>
            `hl.animation({ leaf = "${leaf}", enabled = true, speed = 1, spring = "kiwiDesktop", style = "slide" })`),
        `hl.config({ general = { gaps_workspaces = ${DESKTOP_GAP} } })`,
    ].join("\n"), "desktop slide")
}

registerBindSetup("desktop slide", applyDesktopMotion)

// workspaces made, moved and gone; the plugin keeps the set by itself
// across config reloads and monitors coming back
void pluginsReady.then(sync)
hyprland.connect("workspace-added", syncSoon)
hyprland.connect("workspace-removed", syncSoon)
hyprland.connect("event", (_h: unknown, event: string) => {
    if (event === "moveworkspacev2" || event === "renameworkspace") syncSoon()
})

/** The monitor's desktops, as workspace ids in order. */
export function desktopsOn(monitor: string): number[] {
    reconcile()
    return [...(desktops.get(monitor) ?? [])]
}

/**
 * Every desktop's windows, bottom to top: floating ones over tiled ones,
 * the most recently focused on top. Geometry and stacking come from the
 * compositor, since Astal's client geometry goes stale after moves and
 * resizes and it has no stacking order.
 */
export function windowsByDesktop(): Map<number, Window[]> {
    const stacked = query("clients")
        .filter(c => c.mapped && !c.hidden && (c.workspace?.id ?? 0) > 0)
        .sort((a, b) => (Number(a.floating) - Number(b.floating)) || (b.focusHistoryID - a.focusHistoryID))
    const byDesktop = new Map<number, Window[]>()
    for (const c of stacked) {
        // Astal strips the 0x prefix from addresses
        const client = hyprland.get_client(String(c.address).replace("0x", ""))
        if (!client || !isValidClient(client)) continue
        const id = c.workspace.id
        const below = byDesktop.get(id) ?? []
        byDesktop.set(id, [...below, {
            address: c.address,
            client,
            title: c.title || c.class || "",
            x: c.at[0],
            y: c.at[1],
            width: c.size[0],
            height: c.size[1],
            floating: c.floating,
            focusHistory: c.focusHistoryID,
            stack: below.length,
        }])
    }
    return byDesktop
}

/** A new empty desktop at the end of the monitor's row; its id. */
export function addDesktop(monitor: string): number {
    reconcile()
    const taken = [...query("workspaces").map(w => w.id), ...[...desktops.values()].flat()]
    const id = Math.max(0, ...taken) + 1
    desktops.set(monitor, [...(desktops.get(monitor) ?? []), id])
    sync()
    log.info(`desktop ${id} added on ${monitor}`)
    return id
}

/**
 * Close a desktop: its windows go to the one before it (after it, for the
 * first), which is also where the display goes if it was showing it. A
 * display keeps at least one desktop.
 */
export async function removeDesktop(monitor: string, id: number) {
    const ids = desktopsOn(monitor)
    const index = ids.indexOf(id)
    if (index < 0 || ids.length < 2) return
    const target = ids[index > 0 ? index - 1 : 1]
    if (monitorNamed(monitor)?.active === id) await focusWorkspace(target)
    for (const window of windowsByDesktop().get(id) ?? [])
        await moveWindowToWorkspace(target, `address:${window.address}`, { follow: false })
    closing.add(id)
    desktops.set(monitor, (desktops.get(monitor) ?? []).filter(other => other !== id))
    sync()
    log.info(`desktop ${id} on ${monitor} closed, its windows went to ${target}`)
}

/**
 * Move the desktop at `from` in the monitor's row to `to`. A row is in the
 * order of its workspaces' ids (Hyprland's swipe goes by them), so the
 * workspaces are renumbered: the one now at each place takes the id that
 * place had. Through spare ids, as no two workspaces may share one, and all
 * in one go, before Hyprland's refresh after a renumbering lets the empty
 * ones lapse (the plugin keeps them again right after). The ids the desktops
 * had and have now, or null when nothing moved.
 */
export async function moveDesktop(monitor: string, from: number, to: number): Promise<Map<number, number> | null> {
    const ids = desktopsOn(monitor)
    if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return null
    const order = [...ids]
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)

    const existing = new Set(query("workspaces").map(w => w.id))
    const spare = Math.max(0, ...existing, ...ids) + 1000
    const renames = order
        .map((workspace, place) => ({ workspace, id: ids[place] }))
        .filter(({ workspace, id }) => workspace !== id && existing.has(workspace))
    if (renames.length && await dialect() !== "lua") {
        log.warn("reordering desktops needs Hyprland's lua config (hl.workspace.change_id)")
        return null
    }
    const changeId = (workspace: number, id: number) =>
        `hl.dispatch(hl.dsp.workspace.change_id({ workspace = "${workspace}", id = ${id} }))`
    if (renames.length && !await evalLua([
        ...renames.map(({ workspace }, i) => changeId(workspace, spare + i)),
        ...renames.map(({ id }, i) => changeId(spare + i, id)),
    ].join("\n"), "reorder desktops")) return null
    log.info(`desktop ${from + 1} on ${monitor} moved to ${to + 1}`)
    return new Map(order.map((workspace, place) => [workspace, ids[place]]))
}

/**
 * The focused display's desktop `step` places along its row, if there is one
 * there: like macOS, going past either end goes nowhere.
 */
export function neighbour(step: 1 | -1): number | null {
    const monitor = focusedMonitor()
    if (!monitor) return null
    const ids = desktopsOn(monitor.name)
    const index = ids.indexOf(monitor.active)
    return ids[index + step] ?? null
}

export async function goToDesktop(id: number) {
    await focusWorkspace(id)
}

/**
 * Go to a desktop without the slide: Mission Control has zoomed into its
 * picture, which is all the way there is to show.
 */
export async function goToDesktopAtOnce(id: number) {
    if (await dialect() !== "lua") return void await focusWorkspace(id)
    await evalLua([
        ...DESKTOP_LEAVES.map(leaf => `hl.animation({ leaf = "${leaf}", enabled = false })`),
        `hl.dispatch(hl.dsp.focus({ workspace = "${id}" }))`,
    ].join("\n"), "desktop at once")
    // the slide back for the next time
    void applyDesktopMotion()
}
