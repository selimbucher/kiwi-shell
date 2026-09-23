import { logger } from "../../log"
const log = logger("dock")
import { createState, createComputed, createBinding } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf } from "../config"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import { mapVersion } from "../desktopEntries"
import { entryForClient } from "../appIcon"
import { clientSelector, focusWindow, moveWindowToWorkspace, raiseWindow, toggleSpecialWorkspace } from "../../hypr"

// How much of the bottom edge the dock is covering right now. Zero in
// "default" mode, where it reserves its space and nothing else can be under
// it; the dock's own height while it is shown in auto-hide, so that anything
// else anchored to that edge — the volume and brightness indicator — can step
// out of the way.
export const [dockOverlap, setDockOverlap] = createState(0)

export const DOCK_HIDE_TIMEOUT = 200
export const DOCK_SLIDE_DURATION = 400
// hiding takes longer: the dock slides further than it did coming in, at the
// same speed
export const DOCK_SLIDE_OUT_DURATION = 600

// How far the pill travels on its way out: more than its own height at any
// icon size, so no sliver is left behind. Anything that moves with the dock
// (the indicator) travels the same distance, or the two drift apart.
export const dockSlideDistance = (iconSize: number) => iconSize + 68

export const hyprland = Hyprland.get_default()

// ─── Launch bounce ────────────────────────────────────────────────────────────
// macOS's: an icon clicked to start its app hops, whole hop after whole hop,
// until the app's first window opens, so a slow start still shows that the
// click landed. The hop under way always finishes on the dock, and one small
// rebound settles it there. An app that never opens a window (one that only
// starts a service) stops it at the cap.
export const HOP_MS = 600
// the rebound's height as a share of a hop's; a throw's time goes with the
// square root of its height
export const SETTLE = 0.2
export const SETTLE_MS = Math.round(HOP_MS * Math.sqrt(SETTLE))
const LAUNCH_BOUNCE_MAX_MS = 10_000

// The same hop under two names (style/dock.scss): GTK runs a CSS animation
// once per name, so the next hop starts by switching to the other one.
export type Hop = "" | "hop" | "hop-again" | "hop-settle"

const bouncing = new Set<(hop: Hop) => void>()

export function launchBounce(setHop: (hop: Hop) => void) {
    if (bouncing.has(setHop)) return
    bouncing.add(setHop)
    let opened = false
    const addedId = hyprland.connect("client-added", () => { opened = true })
    const began = GLib.get_monotonic_time()
    let hops = 0
    const next = () => {
        setHop(hops++ % 2 === 0 ? "hop" : "hop-again")
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOP_MS, () => {
            if (opened || GLib.get_monotonic_time() - began >= LAUNCH_BOUNCE_MAX_MS * 1000) {
                hyprland.disconnect(addedId)
                setHop("hop-settle")
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                    bouncing.delete(setHop)
                    setHop("")
                    return GLib.SOURCE_REMOVE
                })
            } else {
                next()
            }
            return GLib.SOURCE_REMOVE
        })
    }
    next()
}

export const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/kiwi-shell/dock-apps.json`

export const isNixManaged = !!conf().dock_apps

const initialAppList: string[] = conf().dock_apps ?? (() => {
    try {
        return JSON.parse(readFile(APPLIST_FILE))
    } catch {
        return []
    }
})()

export const [list, setList] = createState<string[]>(initialAppList)

export async function saveList() {
    if (isNixManaged) return
    try {
        await writeFileAsync(APPLIST_FILE, JSON.stringify(list(), null, 2))
    } catch (error) {
        log.error("Failed to save dock apps:", error)
    }
}

export function isValidClient(client: any): boolean {
    const cls = (client["initial-class"] ?? "").trim()
    const title = (client.title ?? "").trim()
    return cls !== "" || title !== ""
}

// ─── Minimize (special-workspace scratchpad) ──────────────────────────────────

export const MINIMIZED_WS = "special:minimized"

const addr = clientSelector

export function isMinimized(client: Hyprland.Client): boolean {
    return client.workspace?.name === MINIMIZED_WS
}

// visible = on the active workspace of some monitor
export function isClientVisible(client: Hyprland.Client): boolean {
    const wsId = client.workspace?.id
    if (wsId === undefined) return false
    return hyprland.get_monitors().some(m => m.activeWorkspace?.id === wsId)
}

export function minimizeClient(client: Hyprland.Client) {
    moveWindowToWorkspace(MINIMIZED_WS, addr(client), { follow: false })
}

// Hyprland keeps focus and stacking separate: focusing a floating window
// does not raise it above overlapping siblings, so every activation path
// raises explicitly.
export function focusClient(client: Hyprland.Client) {
    focusWindow(addr(client))
    raiseWindow(addr(client))
}

export function restoreClient(client: Hyprland.Client) {
    // a following move also focuses the window, so it lands on the current
    // workspace ready to use
    moveWindowToWorkspace(hyprland.focusedWorkspace.id, addr(client))
    raiseWindow(addr(client))
}

// ─── Focus-steal guard ────────────────────────────────────────────────────────
// With focus_on_activate, external activations (xdg-open behind the dock's
// home/trash buttons, single-instance file managers, links opening in a
// minimized browser, …) can focus a minimized window, which drags the whole
// special workspace into view. Treat any focus landing on a minimized window
// as "restore it": pull it to the last real workspace, then close the
// overlay that is left showing the remaining minimized windows.

let lastNormalWs = hyprland.focusedWorkspace?.id ?? 1
hyprland.connect("notify::focused-workspace", () => {
    const id = hyprland.focusedWorkspace?.id
    if (id !== undefined && id > 0) lastNormalWs = id
})

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.focusedClient
    if (!client || !isMinimized(client)) return
    moveWindowToWorkspace(lastNormalWs, addr(client))
    raiseWindow(addr(client))
    // the overlay state settles asynchronously (socket events), so check
    // slightly later whether it is still open — it auto-closes only when
    // the restored window was the last one minimized
    setTimeout(() => {
        for (const m of hyprland.get_monitors()) {
            if (m.specialWorkspace?.name === MINIMIZED_WS)
                toggleSpecialWorkspace("minimized")
        }
    }, 150)
})

export const unpinnedList = createComputed(get => {
    get(mapVersion) // reactive dependency — re-runs when maps rebuild
    const clients = get(createBinding(hyprland, "clients"))
    const pinned = new Set(get(list))

    const seen = new Set<string>()
    return clients.reduce((acc, client) => {
        if (!isValidClient(client)) return acc
        const entry = entryForClient(client)
        if (pinned.has(entry) || seen.has(entry)) return acc
        seen.add(entry)
        acc.push(entry)
        return acc
    }, [] as string[])
})