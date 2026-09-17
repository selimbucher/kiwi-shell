import { logger } from "../../log"
const log = logger("workspaces")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, onCleanup } from "ags"
import Hyprland from "gi://AstalHyprland"
import { isValidClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { conf } from "../config"
import { themeClasses, LAYER_NAMESPACE } from "../services/theme"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { captureWindowToTexture, getCachedTexture, reservePreviewSize } from "../AppSwitcher/clientCachingService"
import { wallpaperPath, loadThumbnail } from "../services/wallpaper"
import { applyBinds, currentBinds, registerBindSetup, isKiwiBind, describeBind, focusWorkspace, type BindOp } from "../../hypr"
import { shortcut, combo, heldModifierKey, type Shortcut } from "../../shortcuts"

const hyprland = Hyprland.get_default()

// the canvas height cards start at; with many workspaces they shrink until
// the rows fit on screen
const CARD_HEIGHT = 140
const MIN_CARD_HEIGHT = 64
const CARD_HEIGHT_STEP = 8
const CARD_SPACING = 8
// what a card adds around its canvas (.window-preview padding and border,
// the title bar) and the panel's padding, see appSwitcher.scss
const CARD_CHROME_WIDTH = 12
const CARD_CHROME_HEIGHT = 36
const PANEL_PADDING = 24

// cards draw windows at card height / monitor height, so for any window no
// taller than its monitor a frame of card height is sharp enough
reservePreviewSize(0, CARD_HEIGHT)

// A window as the switcher draws it, in layout coordinates, snapshotted when
// the switcher opens. Later windows are drawn over earlier ones.
interface MiniWindow {
    client: Hyprland.Client
    x: number
    y: number
    width: number
    height: number
}

export const [isVisible, setVisibility] = createState(false)
const [selectedId, setSelectedId] = createState(1)
const [displayedIds, setDisplayedIds] = createState<number[]>([])
const [wsWindows, setWsWindows] = createState<Map<number, MiniWindow[]>>(new Map())

// ─── Workspace switcher keybinds (shortcuts.workspace_switcher, default Super+Tab)
// Same architecture as the app switcher, all in the root submap: binde for
// cycling (Shift goes backwards), a release bind on the modifier to confirm
// (fires on every plain release — the shell no-ops it while the switcher is
// closed), and modifier+escape to abort. A launcher tap on the same modifier
// is unrelated to our release bind and keeps working — outside rebindAll we
// never unbind the modifier key.

let registered: Shortcut | null = null

async function registerSuperTabBinds() {
    const s = shortcut("workspace_switcher")
    const mod = s.mods[0]
    const next = combo(s)
    const previous = combo(s, "SHIFT")
    const confirm = `${mod} + ${heldModifierKey(s)}`
    const escape = `${mod} + escape`
    let haveConfirm = false
    let haveEscape = false
    try {
        const binds = await currentBinds()
        // any kiwi-described bind counts as ours: the launcher registers its
        // own release bind (tap-to-open) which must not read as foreign
        const foreign = binds.find((b: any) =>
            b.submap === "" && !isKiwiBind(b) && (
                (b.key === s.key && (b.modmask === s.modmask || b.modmask === (s.modmask | 1))) ||
                // a foreign *release* bind on the modifier itself (a press
                // bind, like tap-to-launch, is fine)
                (b.key === heldModifierKey(s) && b.modmask === s.modmask && b.release)
            ))
        if (foreign) {
            log.warn("foreign workspace switcher bind found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
        const onCombo = (b: any, description: string, c: string) =>
            b.description === description && `${b.modmask}` === `${s.modmask}` &&
            b.key === c.split(" + ").pop()
        haveConfirm = binds.some((b: any) => onCombo(b, "kiwi: workspaces confirm", confirm))
        haveEscape = binds.some((b: any) => onCombo(b, "kiwi: workspaces escape", escape))
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }

    const ops: BindOp[] = [
        { unbind: next },
        { unbind: previous },
        { bind: next, action: { exec: "kiwictl workspaces open-next" },
            description: "kiwi: workspaces next", flags: { repeating: true } },
        { bind: previous, action: { exec: "kiwictl workspaces previous" },
            description: "kiwi: workspaces prev", flags: { repeating: true } },
    ]
    // never unbind the modifier key here (would take tap-to-launch binds with
    // it), so only add ours when it isn't registered yet
    if (!haveConfirm)
        ops.push({ bind: confirm, action: { exec: "kiwictl workspaces confirm" },
            description: "kiwi: workspaces confirm", flags: { release: true, transparent: true } })
    if (!haveEscape)
        ops.push({ bind: escape, action: { exec: "kiwictl workspaces close" },
            description: "kiwi: workspaces escape", flags: { release: true } })

    if (await applyBinds(ops, "workspace switcher binds")) {
        registered = s
        log.info(`registered workspace switcher binds on ${next}`)
    }
}

registerBindSetup("workspaces", registerSuperTabBinds, () => {
    if (!registered) return []
    const mod = registered.mods[0]
    return [
        { unbind: combo(registered) },
        { unbind: combo(registered, "SHIFT") },
        { unbind: `${mod} + ${heldModifierKey(registered)}` },
        { unbind: `${mod} + escape` },
    ]
})

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleWorkspaceSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showSwitcher()
            break
        case "open-next":
            if (!isVisible()) showSwitcher()
            cycle(1)
            break
        case "close":
            setVisibility(false)
            break
        case "toggle":
            if (isVisible()) setVisibility(false)
            else showSwitcher()
            break
        case "next":
            cycle(1)
            break
        case "previous":
            if (!isVisible()) showSwitcher()
            cycle(-1)
            break
        case "confirm":
            confirmAndClose()
            break
    }
}

// Geometry and stacking straight from the compositor: Astal's client
// geometry goes stale after moves and resizes, and it has no stacking order.
// Floating windows sit above tiled ones, the most recently focused on top.
function snapshotWindows(): Map<number, MiniWindow[]> {
    let raw: any[] = []
    try {
        raw = JSON.parse(hyprland.message("j/clients"))
    } catch (e) {
        log.error("failed to read clients:", e)
    }
    const stacked = raw
        .filter(c => c.mapped && !c.hidden && (c.workspace?.id ?? 0) > 0)
        .sort((a, b) => (Number(a.floating) - Number(b.floating)) || (b.focusHistoryID - a.focusHistoryID))
    const byWs = new Map<number, MiniWindow[]>()
    for (const c of stacked) {
        // Astal strips the 0x prefix from addresses
        const client = hyprland.get_client(String(c.address).replace("0x", ""))
        if (!client || !isValidClient(client)) continue
        const id = c.workspace.id
        byWs.set(id, [...(byWs.get(id) ?? []), {
            client, x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1],
        }])
    }
    return byWs
}

function showSwitcher() {
    const byWs = snapshotWindows()
    const last = Math.max(0, ...byWs.keys())
    const current = hyprland.focusedWorkspace?.id ?? 1
    // the first workspace through the empty one just after the last
    // occupied one, so there is always a fresh workspace to jump to
    const count = Math.max(last + 1, current)
    setWsWindows(byWs)
    setDisplayedIds(Array.from({ length: count }, (_, i) => i + 1))
    setSelectedId(current)
    setVisibility(true)
}

function cycle(dir: 1 | -1) {
    if (!isVisible()) return
    const ids = displayedIds()
    if (ids.length === 0) return
    const idx = ids.indexOf(selectedId())
    setSelectedId(ids[(idx + dir + ids.length) % ids.length])
}

function confirmAndClose() {
    if (!isVisible()) return
    focusWorkspace(selectedId())
    setVisibility(false)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function WorkspaceSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // cards wrap into rows instead of running off screen, like the app
    // switcher, and shrink when the rows would be too tall. Built only while
    // open: every open gets a fresh snapshot, and closed cards let go of
    // their frames.
    const layout = createComputed(get => get(isVisible)
        ? layoutCards(get(displayedIds), get(popupGdkMonitor) ?? gdkmonitor)
        : { height: CARD_HEIGHT, rows: [] })

    return (
        <window
            namespace={LAYER_NAMESPACE}
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-workspace-switcher"
            class={themeClasses(t => `WorkspaceSwitcher ${t}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => onCleanup(() => destroyWindow(self))}
        >
            <centerbox class="ws-switch-menu">
                <box
                    $type="center"
                    class="app-switch-container"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={CARD_SPACING}
                    halign={Gtk.Align.CENTER}
                >
                    <For each={layout.as(l => l.rows)}>
                        {(row) => (
                            <box spacing={CARD_SPACING} halign={Gtk.Align.CENTER}>
                                {row.map(id => <WorkspaceCard id={id} height={layout.get().height} />)}
                            </box>
                        )}
                    </For>
                </box>
            </centerbox>
        </window>
    )
}

// A workspace's own monitor in Hyprland layout terms: logical size (physical
// divided by scale, dimensions swapped on rotated transforms) plus the layout
// offset. Client coordinates are global layout coordinates, so miniatures must
// subtract the offset and scale by the logical size — the popup's monitor is
// the wrong frame of reference for workspaces living on another screen.
// Workspaces that don't exist yet fall back to the focused monitor.
function workspaceGeometry(id: number) {
    const mon = hyprland.get_workspace(id)?.get_monitor()
        ?? hyprland.get_focused_monitor()
    const rotated = mon.get_transform() % 2 === 1
    const scale = mon.get_scale() || 1
    return {
        x: mon.get_x(),
        y: mon.get_y(),
        width: (rotated ? mon.get_height() : mon.get_width()) / scale,
        height: (rotated ? mon.get_width() : mon.get_height()) / scale,
    }
}

function canvasWidth(id: number, height: number): number {
    const geo = workspaceGeometry(id)
    return Math.round(height * geo.width / geo.height)
}

// Rows within 85% of the monitor, like the app switcher, from the largest
// card height whose rows also fit its height. Rows hold equally many cards
// where the widths allow it, so 7 cards read as 4 + 3 rather than 6 + 1.
function layoutCards(ids: number[], monitor: Gdk.Monitor): { height: number, rows: number[][] } {
    const area = monitor.get_geometry()
    const maxWidth = area.width * 0.85 - 2 * PANEL_PADDING
    const maxHeight = area.height * 0.85 - 2 * PANEL_PADDING
    const cardWidth = (id: number, height: number) =>
        canvasWidth(id, height) + CARD_CHROME_WIDTH + CARD_SPACING
    const fits = (row: number[], height: number) =>
        row.reduce((sum, id) => sum + cardWidth(id, height), -CARD_SPACING) <= maxWidth

    for (let height = CARD_HEIGHT; ; height -= CARD_HEIGHT_STEP) {
        const greedy: number[][] = []
        for (const id of ids) {
            const row = greedy[greedy.length - 1]
            if (row && fits([...row, id], height)) row.push(id)
            else greedy.push([id])
        }
        const perRow = Math.ceil(ids.length / Math.max(1, greedy.length))
        const even = Array.from({ length: greedy.length }, (_, i) => ids.slice(i * perRow, (i + 1) * perRow))
            .filter(row => row.length > 0)
        const rows = even.length === greedy.length && even.every(row => fits(row, height)) ? even : greedy
        const total = rows.length * (height + CARD_CHROME_HEIGHT) + (rows.length - 1) * CARD_SPACING
        if (total <= maxHeight || height - CARD_HEIGHT_STEP < MIN_CARD_HEIGHT)
            return { height, rows }
    }
}

// A workspace preview: the wallpaper with the workspace's windows at their
// positions, each showing its latest capture (an app icon until there is one).
function WorkspaceCard({ id, height }: { id: number, height: number }) {
    const geo = workspaceGeometry(id)
    const width = canvasWidth(id, height)
    const scale = height / geo.height
    const windows = wsWindows.get().get(id) ?? []
    const entries = [...new Set(windows.map(w => entryForClient(w.client)))]

    const wallpaper = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER, canShrink: true })
    const path = wallpaperPath.get()
    if (path) loadThumbnail(path, width, height).then(t => wallpaper.set_paintable(t))

    const canvas = new Gtk.Fixed()
    for (const win of windows) {
        const w = Math.max(6, Math.round(win.width * scale))
        const h = Math.max(6, Math.round(win.height * scale))
        canvas.put(
            <MiniWindowView client={win.client} width={w} height={h} /> as Gtk.Widget,
            Math.round((win.x - geo.x) * scale),
            Math.round((win.y - geo.y) * scale),
        )
    }

    const card = (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} class="window-preview">
            <box class="preview-title-bar" spacing={5}>
                <label class="ws-number" label={`${id}`} xalign={0} />
                {entries.map(entry => <AppIconImage entry={entry} pixelSize={13} cssClass="ws-app-icon" />)}
            </box>
            {/* a Picture's natural size is the whole image — the scroll-less
                viewport holds the canvas at its computed size */}
            <Gtk.ScrolledWindow
                class="ws-canvas"
                overflow={Gtk.Overflow.HIDDEN}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
                widthRequest={width}
                heightRequest={height}
            >
                <overlay>
                    {wallpaper}
                    <box $type="overlay">{canvas}</box>
                    {/* a theme icon, not a "＋" label: the fullwidth plus glyph
                        only exists in CJK fonts and renders as tofu without one */}
                    <Gtk.Image
                        $type="overlay"
                        class="ws-plus"
                        iconName="list-add-symbolic"
                        pixelSize={Math.round(24 * height / CARD_HEIGHT)}
                        visible={windows.length === 0}
                        halign={Gtk.Align.CENTER}
                        valign={Gtk.Align.CENTER}
                    />
                </overlay>
            </Gtk.ScrolledWindow>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedId() === id && isVisible()) {
            card.add_css_class("selected")
        } else {
            card.remove_css_class("selected")
        }
    })

    return card
}

function MiniWindowView({ client, width, height }: { client: Hyprland.Client, width: number, height: number }) {
    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(getCachedTexture(address))
    // fresh captures come straight from the cache; stale ones are retaken
    captureWindowToTexture(address).then(t => {
        if (t) setTexture(t)
    })
    const icon = Math.max(8, Math.min(20, Math.round(Math.min(width, height) * 0.55)))

    return (
        <Gtk.ScrolledWindow
            class="ws-mini-window"
            overflow={Gtk.Overflow.HIDDEN}
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.NEVER}
            widthRequest={width}
            heightRequest={height}
        >
            <overlay>
                <Gtk.Picture canShrink contentFit={Gtk.ContentFit.COVER} paintable={texture} />
                <box
                    $type="overlay"
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.CENTER}
                    visible={texture(t => !t)}
                >
                    <AppIconImage entry={entryForClient(client)} pixelSize={icon} cssClass="ws-mini-icon" />
                </box>
            </overlay>
        </Gtk.ScrolledWindow>
    )
}
