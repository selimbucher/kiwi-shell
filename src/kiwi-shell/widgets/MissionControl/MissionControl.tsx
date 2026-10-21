import { logger } from "../../log"
const log = logger("mission-control")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Pango from "gi://Pango"
import { createState, createComputed, createRoot, onCleanup, type Accessor } from "ags"
import Hyprland from "gi://AstalHyprland"
import { entryForClient, AppIconImage } from "../appIcon"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { livePreviews, LiveTiles, PreviewPane, raisePreview, type Rect } from "../services/previews"
import { captureWindowToTexture, getCachedTexture, reservePreviewSize } from "../AppSwitcher/clientCachingService"
import { wallpaperPath, loadThumbnail } from "../services/wallpaper"
import { focusClient } from "../Dock/dock-state"
import { applyBinds, currentBinds, registerBindSetup, moveWindowToWorkspace, type BindOp } from "../../hypr"
import { shortcut, combo, type Shortcut, type ShortcutName, type OptionalShortcutName } from "../../shortcuts"
import { globalShortcut } from "../services/globalShortcuts"
import { spread, type Box, type Slot } from "./spread"
import {
    Tween, Spring, lerp, easeOutCubic, FLIGHT, BAR_OPENING, CLOSING_UP, ARRIVING, PEEKING, NAMES_COMING, type Timing,
} from "./motion"
import {
    monitorNamed, desktopsOn, windowsByDesktop, addDesktop, removeDesktop, moveDesktop, neighbour, goToDesktop, goToDesktopAtOnce,
    type Monitor, type Window,
} from "./desktops"

const hyprland = Hyprland.get_default()

// ─── Mission Control ──────────────────────────────────────────────────────────
// macOS's overview of a display: its desktops in a bar along the top, and
// the windows of the desktop it shows spread out below, none covering
// another. Click a window to go to it, a desktop to go there, anything else
// to leave. The bar starts as a row of names and opens into pictures of the
// desktops once the pointer goes up to it; there, + adds an empty desktop
// and a desktop's × closes it.
//
// It covers the whole display, wallpaper included, so the windows it spreads
// out are the only ones in sight; the compositor draws them into their
// places (services/previews.ts).

// the bar: the desktops' pictures are this share of the display's width at
// most, smaller when there are many
const THUMB_SHARE = 0.11
const THUMB_GAP = 24
// room above the pictures, for the × on their corners too: a popup the
// compositor has to squeeze to keep on screen is one GTK takes down again
const BAR_TOP = 22
const BAR_SIDE = 48
const NAME_GAP = 6
const NAME_HEIGHT = 18
const BAR_BOTTOM = 14
// room around a desktop's picture for its ring (style/missionControl.scss)
const RING = 4
// + at the bar's right end, a bare glyph as on macOS, with room to point at
const PLUS_WIDTH = 44
const PLUS_MARGIN = 14
// the × that closes a desktop, centred on its picture's top-left corner, and
// the room around it for its shadow (style/missionControl.scss)
const CLOSE_SIZE = 22
const CLOSE_PAD = 3
// the pointer may cross from the picture onto the × and back without it going
const CLOSE_LINGER_MS = 80

// the windows, below the bar
const AREA_MARGIN = 48
// between the bar and the windows below it: macOS leaves them room
const AREA_TOP_GAP = 32
const WINDOW_RADIUS = 10
// a window's frame: its highlight's border plus the gap inside it
const FRAME = 5
const TITLE_WIDTH_EXTRA = 120
// an average character of the title's 12px font, for how many fit
const TITLE_CHAR_WIDTH = 7
const SPREAD = { columnSpacing: 36, rowSpacing: 48, maxScale: 0.9 }

// the compositor's name for the windows' pictures
const WINDOWS_SET = "mission-control"

// without the plugin the shell captures the windows itself, at this height
// at least
reservePreviewSize(0, 240)

type Desktop = { id: number; windows: Window[] }

type View = {
    monitor: Monitor
    desktops: Desktop[]
    slots: Slot<Window>[]
}

export const [isOpen, setOpen] = createState(false)
const [view, setView] = createState<View | null>(null)
const [expanded, setExpanded] = createState(false)
const [selected, setSelected] = createState<string | null>(null)

// ─── Geometry ─────────────────────────────────────────────────────────────────

function thumbSize(monitor: Monitor, count: number) {
    const room = monitor.width - 2 * BAR_SIDE - PLUS_WIDTH - THUMB_GAP
    const width = Math.floor(Math.min(
        monitor.width * THUMB_SHARE,
        (room - (count - 1) * THUMB_GAP) / Math.max(1, count),
    ))
    return { width, height: Math.round(width * monitor.height / monitor.width) }
}

// The bar is as tall as its largest pictures, however many desktops there
// are, so the windows below never move when it opens.
const barHeight = (monitor: Monitor) =>
    BAR_TOP + thumbSize(monitor, 1).height + NAME_GAP + NAME_HEIGHT + BAR_BOTTOM

function snapshot(monitorName: string): View | null {
    const monitor = monitorNamed(monitorName)
    if (!monitor) return null
    const byDesktop = windowsByDesktop()
    const ids = desktopsOn(monitor.name)
    if (!ids.includes(monitor.active)) ids.push(monitor.active)
    ids.sort((a, b) => a - b)

    const top = barHeight(monitor)
    const area = {
        x: AREA_MARGIN,
        y: top + AREA_TOP_GAP,
        width: monitor.width - 2 * AREA_MARGIN,
        height: monitor.height - top - AREA_TOP_GAP - AREA_MARGIN,
    }
    const windows = byDesktop.get(monitor.active) ?? []
    const slots = spread(
        windows.map(w => ({ item: w, box: { x: w.x - monitor.x, y: w.y - monitor.y, width: w.width, height: w.height } })),
        area, monitor, SPREAD)
    return { monitor, desktops: ids.map(id => ({ id, windows: byDesktop.get(id) ?? [] })), slots }
}

// ─── Opening, closing ─────────────────────────────────────────────────────────

function shownMonitor(): string | null {
    return popupGdkMonitor.get()?.get_connector() ?? hyprland.get_focused_monitor()?.get_name() ?? null
}

function refresh() {
    // not under a window being dragged, whose drop refreshes; nor while a
    // desktop is zoomed into, which is where everything goes next, or the
    // desktops are being renumbered (moveDesktop)
    if (drag || renumbering || scene?.isZooming()) return
    const name = view.get()?.monitor.name ?? shownMonitor()
    const next = name ? snapshot(name) : null
    if (!next) return
    setView(next)
    // whatever had the focus was in what has just been rebuilt
    mcWindow?.set_focus(null)
}

let mcWindow: Gtk.Window | null = null
// what Mission Control shows while open (Scene)
let scene: Scene | null = null

export function openMissionControl() {
    if (isOpen.get()) return
    const name = shownMonitor()
    const next = name ? snapshot(name) : null
    if (!next) return
    setSelected(null)
    setExpanded(false)
    setView(next)
    setOpen(true)
}

// Closing: with kiwi's plugin the windows fly home first (previews.ts, fly),
// and Mission Control stays up, taking no input, until the plugin says they
// have landed — or a little after they should have. Then it goes, and what
// it was closed for happens: a window focused, a desktop gone to.
export const [closing, setClosing] = createState(false)
let afterLanding: (() => void) | null = null
let landingSource = 0
let closedAt = 0
const LANDED_ANYWAY_MS = 700

function landed(heard: boolean) {
    if (!closing.get()) return
    log.debug(`landed ${Date.now() - closedAt} ms after closing${heard ? "" : " (not heard from the plugin)"}`)
    if (landingSource) GLib.source_remove(landingSource)
    landingSource = 0
    setClosing(false)
    setOpen(false)
    setView(null)
    const then = afterLanding
    afterLanding = null
    then?.()
}

// The plugin's gesture (previews.cpp): three fingers up ask for Mission
// Control, and fingers that take the windows home close it without the shell
// having asked.
hyprland.connect("event", (_h: unknown, event: string, args: string) => {
    if (event === "kiwigesture" && args === `open,${WINDOWS_SET}`) {
        if (!isOpen.get()) openMissionControl()
    } else if (event === "kiwipreviews" && args === `flown,${WINDOWS_SET}`) {
        if (isOpen.get() && !closing.get()) {
            closedAt = Date.now()
            setClosing(true)
        }
        landed(true)
    }
})

export function closeMissionControl(then?: () => void) {
    if (!isOpen.get() || closing.get()) return
    setSelected(null)
    afterLanding = then ?? null
    closedAt = Date.now()
    setClosing(true)
    if (!livePreviews() || windowTiles.tiles.size === 0) {
        landed(false)
        return
    }
    windowTiles.hidden()
    landingSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LANDED_ANYWAY_MS, () => {
        landingSource = 0
        landed(false)
        return GLib.SOURCE_REMOVE
    })
}

export const toggleMissionControl = () =>
    isOpen.get() ? closeMissionControl() : openMissionControl()

// The window comes forward at once: it flies home over the others, and is on
// top when it lands, where the rest of the windows find it.
function goToWindow(window: Window) {
    if (closing.get()) return
    raisePreview(WINDOWS_SET, window.client.get_address())
    focusClient(window.client)
    closeMissionControl()
}

// Into a desktop: its picture grows to fill the display over everything, as
// on macOS, and that desktop is there. The one in view is already there: its
// windows just go home.
function goTo(id: number) {
    if (closing.get()) return
    const v = view.get()
    if (!v || id === v.monitor.active) return closeMissionControl()
    if (!scene?.zoomInto(id)) closeMissionControl(() => void goToDesktop(id))
}

// Gone without the windows flying home: zoomed into a desktop, its windows
// are where they belong already.
function closeAtOnce() {
    if (!isOpen.get() || closing.get()) return
    setSelected(null)
    closedAt = Date.now()
    setClosing(true)
    windowTiles.giveBack(() => landed(true))
}

// Desktops and windows coming and going while it is open, and the desktop
// switched with the keyboard: laid out again once the burst is over.
let refreshSource = 0
function refreshSoon() {
    if (!isOpen.get() || closing.get() || refreshSource) return
    refreshSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        refreshSource = 0
        if (isOpen.get() && !closing.get()) refresh()
        return GLib.SOURCE_REMOVE
    })
}
hyprland.connect("client-added", refreshSoon)
hyprland.connect("client-removed", refreshSoon)
hyprland.connect("notify::focused-workspace", refreshSoon)

// ─── Shortcuts ────────────────────────────────────────────────────────────────
// Mission Control's own (shortcuts.mission_control, Ctrl+Super+Up, macOS's
// Control+Up) opens and closes it; the desktop ones (Ctrl+Super+Left/Right,
// macOS's Control+Left/Right) go to the desktop next to this one, also while
// Mission Control is open, which then shows that desktop's windows.

async function step(direction: 1 | -1) {
    const id = neighbour(direction)
    if (id !== null) await goToDesktop(id)
}

const TOGGLE = globalShortcut("mission-control", "Mission Control: open or close", "press", toggleMissionControl)
const LEFT = globalShortcut("desktop-left", "Go to the desktop on the left", "press", () => void step(-1))
const RIGHT = globalShortcut("desktop-right", "Go to the desktop on the right", "press", () => void step(1))

const BINDS: { name: Exclude<ShortcutName, OptionalShortcutName>; action: ReturnType<typeof globalShortcut>; description: string }[] = [
    { name: "mission_control", action: TOGGLE, description: "kiwi: mission control" },
    { name: "desktop_left", action: LEFT, description: "kiwi: desktop left" },
    { name: "desktop_right", action: RIGHT, description: "kiwi: desktop right" },
]
let registered: Shortcut[] = []

async function registerBinds() {
    registered = []
    let binds: any[]
    try {
        binds = await currentBinds()
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }
    const ops: BindOp[] = []
    const wanted: Shortcut[] = []
    // a bind of the Hyprland config on these keys is gone by now (shortcuts.ts)
    for (const { name, action, description } of BINDS) {
        const s = shortcut(name)
        const on = (b: any) => b.submap === "" && b.key === s.key && b.modmask === s.modmask
        wanted.push(s)
        if (binds.some(b => on(b) && b.description === description)) continue
        ops.push({ unbind: combo(s) }, { bind: combo(s), action, description })
    }
    if (ops.length === 0 || await applyBinds(ops, "mission control binds")) {
        registered = wanted
        log.info(`registered mission control binds on ${wanted.map(s => combo(s)).join(", ")}`)
    }
}

registerBindSetup("mission control", registerBinds,
    () => registered.map(s => ({ unbind: combo(s) })))

// ─── The windows' pictures ────────────────────────────────────────────────────

// What of a tile is left to draw beside something of the shell's over it:
// the largest part of `rect` that `cover` leaves, or nothing. The compositor
// draws the windows over the shell's surface, the shell's own pictures over
// them included.
function uncovered(rect: Rect, cover: Rect | null): Rect {
    if (!cover) return rect
    const right = rect.x + rect.width, bottom = rect.y + rect.height
    const coverRight = cover.x + cover.width, coverBottom = cover.y + cover.height
    if (cover.x >= right || coverRight <= rect.x || cover.y >= bottom || coverBottom <= rect.y) return rect
    const parts: Rect[] = [
        { ...rect, width: Math.max(0, cover.x - rect.x) },
        { ...rect, x: Math.max(rect.x, coverRight), width: Math.max(0, right - Math.max(rect.x, coverRight)) },
        { ...rect, height: Math.max(0, cover.y - rect.y) },
        { ...rect, y: Math.max(rect.y, coverBottom), height: Math.max(0, bottom - Math.max(rect.y, coverBottom)) },
    ]
    return parts.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b)
}

// the desktop being zoomed into, if one is, unless `tile` is in it
function zoomOver(tile: Gtk.Widget): Gtk.Widget | null {
    const zoom = scene?.zoomBox() ?? null
    return zoom && !tile.is_ancestor(zoom) ? zoom : null
}

// the windows of the desktop shown, live: a playing video plays on
const windowTiles = new LiveTiles({
    set: WINDOWS_SET,
    namespace: LAYER.missionControl,
    motion: "live",
    radius: WINDOW_RADIUS,
    fly: true,
    // the windows of a desktop being zoomed into, cut off at its picture
    clipOf: tile => {
        let picture = tile.get_parent()
        while (picture && !picture.has_css_class("mc-zoom")) picture = picture.get_parent()
        return picture
    },
    // and the others give way to it as it grows over them
    narrowClip: (tile, clip, onSurface) => {
        const zoom = zoomOver(tile)
        return zoom ? uncovered(clip, onSurface(zoom)) : clip
    },
})

// the windows in the desktops' pictures, cut off at the picture's edge
const desktopTiles = new LiveTiles({
    set: "mission-control-desktops",
    namespace: LAYER.missionControl,
    motion: "still",
    radius: 3,
    clipOf: canvasOf,
    // The windows in the desktops the dragged one passes over give way to
    // its picture, and all of them to a desktop being zoomed into.
    narrowClip: (tile, clip, onSurface) => {
        const dragged = reorderedCanvas
        if (dragged && canvasOf(tile) !== dragged) clip = uncovered(clip, onSurface(dragged))
        const zoom = zoomOver(tile)
        return zoom ? uncovered(clip, onSurface(zoom)) : clip
    },
})

// the desktop's picture a window in it is cut off at
function canvasOf(tile: Gtk.Widget): Gtk.Widget | null {
    let canvas: Gtk.Widget | null = tile.get_parent()
    while (canvas && !canvas.has_css_class("mc-thumb-canvas")) canvas = canvas.get_parent()
    return canvas
}

// the picture of the desktop being dragged along the bar, if one is
let reorderedCanvas: Gtk.Widget | null = null

isOpen.subscribe(() => {
    if (isOpen.get()) {
        windowTiles.shown()
        desktopTiles.shown()
    } else {
        // the windows' have flown home by now (closeMissionControl)
        windowTiles.hidden()
        desktopTiles.hidden()
    }
})

// A window as a picture of `width` × `height`: an empty box the compositor
// draws the window into, or, without kiwi's plugin, the shell's own capture.
function WindowPicture({ window, width, height, tiles }: {
    window: Window, width: number, height: number, tiles: LiveTiles,
}) {
    const address = window.client.get_address()
    if (livePreviews()) {
        return (
            <box
                class="mc-picture"
                widthRequest={width}
                heightRequest={height}
                $={(self: Gtk.Widget) => {
                    // drawn in the order registered: re-registered at the end
                    tiles.tiles.delete(address)
                    tiles.tiles.set(address, self)
                    onCleanup(() => { if (tiles.tiles.get(address) === self) tiles.tiles.delete(address) })
                }}
            />
        )
    }

    const [texture, setTexture] = createState<Gdk.Texture | null>(getCachedTexture(address))
    captureWindowToTexture(address).then(t => { if (t) setTexture(t) })
    const icon = Math.max(8, Math.min(64, Math.round(Math.min(width, height) * 0.4)))
    // a Picture's natural size is the whole image; the scroll-less viewport
    // holds it at the picture's size
    return (
        <Gtk.ScrolledWindow
            class="mc-picture"
            overflow={Gtk.Overflow.HIDDEN}
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.NEVER}
            widthRequest={width}
            heightRequest={height}
        >
            <overlay>
                <Gtk.Picture canShrink contentFit={Gtk.ContentFit.COVER} paintable={texture} />
                <box $type="overlay" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} visible={texture(t => !t)}>
                    <AppIconImage entry={entryForClient(window.client)} pixelSize={icon} cssClass="mc-icon" />
                </box>
            </overlay>
        </Gtk.ScrolledWindow>
    )
}

const click = (widget: Gtk.Widget, run: () => void) => {
    const gesture = new Gtk.GestureClick()
    gesture.connect("released", () => run())
    widget.add_controller(gesture)
}

// ─── Canvases ─────────────────────────────────────────────────────────────────

// A Gtk.Fixed that, unless `solid`, isn't there for the pointer between the
// things it holds: the bar lies over the windows.
const Canvas = GObject.registerClass(
    { GTypeName: "KiwiMissionControlCanvas" },
    class Canvas extends Gtk.Fixed {
        solid = true

        vfunc_contains(x: number, y: number): boolean {
            return this.solid && super.vfunc_contains(x, y)
        }
    },
)
type Canvas = InstanceType<typeof Canvas>

// What a canvas is put in: it asks no room for what it holds, and gives it
// all it has. A canvas asks for room to the end of everything on it, a
// desktop sliding in from the side included — the whole window asked to be
// twice as wide, and the compositor squeezed it back into the display.
// (A Fixed is measured by its layout manager, so the canvas itself can't
// be told otherwise.)
const Holder = GObject.registerClass(
    { GTypeName: "KiwiMissionControlHolder" },
    class Holder extends Gtk.Widget {
        vfunc_measure(): [number, number, number, number] {
            return [0, 0, -1, -1]
        }

        // at least as large as the canvas needs: what hangs off the edges
        // is still where it is, just out of sight
        vfunc_size_allocate(width: number, height: number, baseline: number): void {
            for (let child = this.get_first_child(); child; child = child.get_next_sibling()) {
                const [wide] = child.measure(Gtk.Orientation.HORIZONTAL, -1)
                const [tall] = child.measure(Gtk.Orientation.VERTICAL, -1)
                child.allocate(Math.max(width, wide), Math.max(height, tall), baseline, null)
            }
        }
    },
)

const lerpBox = (from: Box, to: Box, t: number): Box => ({
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
})

// ─── Dragging a window ────────────────────────────────────────────────────────
// As on macOS: a window picked up follows the pointer, the bar opens, and the
// window shrinks to a desktop picture's scale as it comes up to the bar.
// Dropped on a desktop it moves there, on + it gets a desktop of its own,
// anywhere else it goes back to its place.

// the pointer moves this far before a press on a window is a drag
const DRAG_THRESHOLD = 8
// how far below the bar the window starts shrinking
const SHRINK_ZONE = 140

// the bar's desktops and its +, where a window can be dropped
const dropTargets = new Map<number, Gtk.Widget>()
let addTarget: Gtk.Widget | null = null

type Drag = {
    frame: Frame
    // where in the window, as a share of its size, the pointer holds it
    grab: { x: number; y: number }
    target: number | "add" | null
}
let drag: Drag | null = null

// the desktop (or +) under a point of the windows' canvas
function dropTargetAt(canvas: Gtk.Widget, x: number, y: number): number | "add" | null {
    const inside = (widget: Gtk.Widget) => {
        const [ok, b] = widget.compute_bounds(canvas)
        return ok && x >= b.get_x() && x < b.get_x() + b.get_width() && y >= b.get_y() && y < b.get_y() + b.get_height()
    }
    for (const [id, widget] of dropTargets) if (inside(widget)) return id
    return addTarget && inside(addTarget) ? "add" : null
}

function markDropTarget(target: number | "add" | null) {
    for (const [id, widget] of dropTargets)
        id === target ? widget.add_css_class("drop") : widget.remove_css_class("drop")
    if (addTarget) target === "add" ? addTarget.add_css_class("drop") : addTarget.remove_css_class("drop")
}

function dragTo(scene: Scene, x: number, y: number) {
    if (!drag) return
    const { frame, grab } = drag
    const v = scene.v
    // a desktop picture's scale at the bar, the window's own further down
    const bar = barHeight(v.monitor)
    const small = thumbSize(v.monitor, v.desktops.length).width / v.monitor.width
    const towards = Math.min(1, Math.max(0, (bar + SHRINK_ZONE - y) / SHRINK_ZONE))
    // at the bar the window is as large as in a desktop's picture
    const atBar = frame.slot.item.width * small / frame.slot.width
    const scale = 1 + (atBar - 1) * towards
    const width = Math.max(8, Math.round(frame.slot.width * scale))
    const height = Math.max(8, Math.round(frame.slot.height * scale))
    frame.at = { x: x - grab.x * width, y: y - grab.y * height + scene.fold(), width, height }
    scene.place()
    const target = dropTargetAt(scene.stage, x, y)
    if (target !== drag.target) {
        drag.target = target
        markDropTarget(target)
    }
}

async function dropWindow(scene: Scene) {
    if (!drag) return
    const { frame, target } = drag
    drag = null
    markDropTarget(null)
    frame.held = false
    const v = scene.v
    if (target === null || target === v.monitor.active) {
        // back where it was
        scene.sendHome(frame)
        return
    }
    const address = `address:0x${frame.slot.item.client.get_address()}`
    const desktop = target === "add" ? (arriving = addDesktop(v.monitor.name)) : target
    await moveWindowToWorkspace(desktop, address, { follow: false })
    refresh()
}

// one drag at a time, on the windows' canvas: the windows move under the
// pointer, so their own coordinates would move with them
function dragWindows(scene: Scene) {
    const canvas = scene.stage
    const gesture = new Gtk.GestureDrag()
    gesture.connect("drag-update", (_g, dx, dy) => {
        if (closing.get()) return
        const [, sx, sy] = gesture.get_start_point()
        if (!drag) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
            let widget: Gtk.Widget | null = canvas.pick(sx, sy, Gtk.PickFlags.DEFAULT)
            while (widget && widget.get_parent() !== canvas) widget = widget.get_parent()
            const frame = widget && frameOf.get(widget)
            if (!frame || frame.leaving) return
            // the press is a drag now: no click on the window, nor on the
            // background behind it
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
            const fold = scene.fold()
            drag = {
                frame, target: null,
                grab: { x: (sx - frame.at.x) / frame.at.width, y: (sy - (frame.at.y - fold)) / frame.at.height },
            }
            frame.held = true
            setSelected(null)
            setExpanded(true)
            raisePreview(WINDOWS_SET, frame.slot.item.client.get_address())
            frame.widget.insert_before(canvas, null)
        }
        dragTo(scene, sx + dx, sy + dy)
    })
    gesture.connect("drag-end", () => { if (drag) void dropWindow(scene) })
    canvas.add_controller(gesture)
}

// ─── The scene ────────────────────────────────────────────────────────────────
// What Mission Control shows, kept from one change to the next so that
// everything goes from where it is to where it now belongs, as macOS moves it
// (motion.ts has the timings):
// - the bar opening: its band grows, the desktops' pictures come down from
//   above the screen, the names go down to be their captions, and the
//   windows move down by as much, keeping their size;
// - going to another desktop while open: the wallpaper and the windows slide
//   sideways as one, on the desktops' own spring;
// - a desktop added with +: it slides in from where it peeked at the bar's
//   end, the others making room; closed with ×: it goes at once, the others
//   close up, and its windows, if they come to this desktop, fly out of its
//   picture into their places;
// - a window dropped on another desktop flies into that desktop's picture;
// - the windows going to new places as others come and go.
// The windows' pictures are the compositor's (services/previews.ts),
// measured from the widgets every frame they move.

type Frame = {
    slot: Slot<Window>
    // the highlight's box, the window's picture in it
    widget: Gtk.Widget
    picture: Gtk.Widget
    title: Gtk.Widget
    // where it is drawn, in the open bar's terms: the slots are laid out
    // below the open bar, and with it folded everything is drawn higher
    at: Box
    from: Box
    // from `from` to the slot, or into a desktop's picture when leaving
    move: Tween
    leaving: Box | null
    held: boolean
    dispose: () => void
}

// a desktop's picture growing to fill the display (Scene, zoomInto)
type Zoom = {
    id: number
    box: Gtk.Widget
    canvas: Gtk.Fixed
    windows: { window: Window; picture: Gtk.Widget }[]
    from: Box
    growing: Tween
    done?: boolean
    dispose: () => void
}

// the frame a widget on the windows' canvas is, for the drag to find
const frameOf = new WeakMap<Gtk.Widget, Frame>()

// a desktop's windows and wallpaper, sliding past as one
type Page = { id: number; wallpaper: Gtk.Picture; frames: Map<string, Frame> }

// a desktop in the bar
type Item = {
    id: number
    // the desktop's picture, its windows inside it
    picture: Gtk.Widget
    content: string
    disposeContent: () => void
    // the name: a pill in the folded bar, the picture's caption in the open one
    name: Gtk.Widget
    label: Gtk.Label
    // the picture's left edge along the open bar
    x: Tween
}

// the bar folded: a strip of names, as tall as this
const FOLDED_BAR = 44
// between the names in the folded bar
const NAME_SPACING = 8
// how far the names come down from as Mission Control opens
const NAMES_DROP = 24
// the name's pill around its text (style/missionControl.scss)
const NAME_PAD = 4
// how much of the new desktop shows at the bar's end while + is pointed at
const PEEK_SHOWN = 63
// between desktops as they slide past in Mission Control
const SLIDE_GAP_SHARE = 0.05
// the desktops making room for one dragged along the bar
const MAKING_ROOM: Timing = { ms: 200, curve: easeOutCubic }

// the paintable every page's wallpaper shows (MissionControl, loadWallpaper)
const [wallpaperTexture, setWallpaperTexture] = createState<Gdk.Paintable | null>(null)

// a desktop added with + (or by dropping a window on it): it comes in from
// where it peeked
let arriving: number | null = null

// where each desktop's picture goes along the open bar, its left edge
function rowX(monitor: Monitor, count: number, size: { width: number }, index: number) {
    const row = count * size.width + (count - 1) * THUMB_GAP
    return Math.round((monitor.width - row) / 2) + index * (size.width + THUMB_GAP)
}

class Scene {
    v: View
    readonly stage = new Canvas()
    readonly bar = new Canvas()
    // over everything: a desktop being zoomed into
    readonly top = new Canvas()
    private readonly pages = new Map<number, Page>()
    private readonly items = new Map<number, Item>()
    // behind the wallpapers, for the gap between two sliding past
    private readonly backdrop = new Gtk.Box({ cssClasses: ["mc-backdrop"], canTarget: false })
    private readonly band = new Gtk.Box({ cssClasses: ["mc-band"], canTarget: false })
    private readonly plus: Gtk.Button
    private readonly peekBox: Gtk.Widget
    private readonly peekWallpaper = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER, canShrink: true })
    private size: { width: number; height: number }
    // which desktop is in view: its place in the row, between two while sliding
    private readonly camera = new Spring()
    // the bar: 0 folded, 1 open
    private readonly opening = new Tween()
    // the names: 0 up above the screen, 1 in place
    private readonly names = new Tween()
    // the new desktop at the bar's end: 0 out of sight, 1 peeking in
    private readonly peek = new Tween()
    private pointingAtPlus = false
    private zoom: Zoom | null = null
    private reordered: Item | null = null
    private tick = 0
    private readonly unsubscribe: (() => void)[] = []

    constructor(v: View) {
        this.v = v
        this.size = thumbSize(v.monitor, v.desktops.length)
        this.bar.solid = false

        this.stage.put(this.backdrop, 0, 0)
        this.bar.put(this.band, 0, 0)
        for (const [index, desktop] of v.desktops.entries()) this.addItem(desktop, index).x.jump(rowX(v.monitor, v.desktops.length, this.size, index))
        this.plus = this.makePlus()
        this.peekBox = this.makePeek()
        this.addPage(v.monitor.active, v.slots, new Map())
        this.camera.jump(this.indexOf(v.monitor.active))
        this.opening.jump(expanded.get() ? 1 : 0)
        this.names.to(1, NAMES_COMING)

        dragWindows(this)
        this.reorderOnDrag()
        this.unsubscribe.push(
            wallpaperTexture.subscribe(() => this.showWallpaper()),
            expanded.subscribe(() => this.go(this.opening, expanded.get() ? 1 : 0, BAR_OPENING)),
            closing.subscribe(() => { if (closing.get()) this.go(this.names, 0, NAMES_COMING) }),
            selected.subscribe(() => this.showSelected()),
        )
        this.showWallpaper()
        this.markCurrent()
        this.place()
        this.animate()
    }

    destroy() {
        if (this.tick) this.stage.remove_tick_callback(this.tick)
        this.tick = 0
        this.unsubscribe.forEach(u => u())
        for (const page of this.pages.values()) for (const frame of page.frames.values()) frame.dispose()
        for (const item of this.items.values()) this.dropItem(item)
        this.pages.clear()
        this.zoom?.dispose()
        this.zoom = null
        this.stage.unparent()
        this.bar.unparent()
        this.top.unparent()
    }

    // how much higher than its slot everything below the bar is drawn
    fold(): number {
        return (barHeight(this.v.monitor) - FOLDED_BAR) * (1 - this.opening.value)
    }

    /** The desktops by their new numbers (moveDesktop). */
    renumber(renames: Map<number, number>) {
        const id = (old: number) => renames.get(old) ?? old
        const items = [...this.items.values()]
        const pages = [...this.pages.values()]
        const targets = [...dropTargets]
        this.items.clear()
        this.pages.clear()
        dropTargets.clear()
        for (const item of items) this.items.set(item.id = id(item.id), item)
        for (const page of pages) this.pages.set(page.id = id(page.id), page)
        for (const [old, widget] of targets) dropTargets.set(id(old), widget)
        this.v = {
            ...this.v,
            monitor: { ...this.v.monitor, active: id(this.v.monitor.active) },
            desktops: this.v.desktops.map(d => ({ ...d, id: id(d.id) })),
        }
    }

    isZooming(): boolean {
        return this.zoom !== null
    }

    zoomBox(): Gtk.Widget | null {
        return this.zoom?.box ?? null
    }

    /** A desktop on its way along the bar: it shows no × until it is there. */
    isMoving(id: number): boolean {
        return this.items.get(id)?.x.running ?? false
    }

    /** The bar's own height now, folded to open: the pointer above it opens it. */
    barBottom(): number {
        return lerp(FOLDED_BAR, barHeight(this.v.monitor), this.opening.value)
    }

    private indexOf(id: number): number {
        return this.v.desktops.findIndex(d => d.id === id)
    }

    // ─── The windows ──────────────────────────────────────────────────────────

    private addPage(id: number, slots: Slot<Window>[], origins: Map<string, Box>): Page {
        const wallpaper = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER, canShrink: true, canTarget: false })
        wallpaper.set_paintable(wallpaperTexture.get())
        wallpaper.set_size_request(this.v.monitor.width, this.v.monitor.height)
        this.stage.put(wallpaper, 0, 0)
        wallpaper.insert_after(this.stage, this.backdrop)
        const page: Page = { id, wallpaper, frames: new Map() }
        this.pages.set(id, page)
        this.fill(page, slots, origins, new Map())
        return page
    }

    private dropPage(page: Page) {
        for (const frame of page.frames.values()) this.dropFrame(page, frame)
        this.stage.remove(page.wallpaper)
        this.pages.delete(page.id)
    }

    // The page's windows to their slots: the ones it had from where they are,
    // the ones coming from another desktop's picture (`origins`) from there,
    // and the ones leaving for another desktop's picture (`destinations`)
    // into it. Others come and go where they are.
    private fill(page: Page, slots: Slot<Window>[], origins: Map<string, Box>, destinations: Map<string, Box>) {
        const kept = new Set<string>()
        for (const slot of slots) {
            const address = slot.item.client.get_address()
            kept.add(address)
            const frame = page.frames.get(address)
            if (!frame) {
                page.frames.set(address, this.makeFrame(slot, origins.get(address)))
                continue
            }
            frame.slot = slot
            frame.leaving = null
            if (!frame.held) this.glide(frame, FLIGHT)
        }
        for (const [address, frame] of page.frames) {
            if (kept.has(address) || frame.leaving) continue
            const into = destinations.get(address)
            if (!into) {
                this.dropFrame(page, frame)
                continue
            }
            frame.held = false
            frame.leaving = into
            this.glide(frame, FLIGHT)
        }
        // bottom to top, as the windows overlap, the titles over them all;
        // the compositor draws the pictures in the order they are registered
        const stacked = [...page.frames.values()].filter(f => !f.leaving).sort((a, b) => a.slot.item.stack - b.slot.item.stack)
        for (const frame of stacked) {
            frame.widget.insert_before(this.stage, null)
            const address = frame.slot.item.client.get_address()
            if (windowTiles.tiles.get(address) === frame.picture) {
                windowTiles.tiles.delete(address)
                windowTiles.tiles.set(address, frame.picture)
            }
        }
        for (const frame of page.frames.values()) frame.title.insert_before(this.stage, null)
        this.animate()
    }

    private makeFrame(slot: Slot<Window>, from?: Box): Frame {
        const address = slot.item.client.get_address()
        return createRoot(dispose => {
            const picture = <WindowPicture window={slot.item} width={slot.width} height={slot.height} tiles={windowTiles} /> as Gtk.Widget
            const widget = new Gtk.Box({ cssClasses: ["mc-window", "mc-target"] })
            widget.append(picture)
            const motion = new Gtk.EventControllerMotion()
            motion.connect("enter", () => { if (!drag) setSelected(address) })
            motion.connect("leave", () => { if (selected.get() === address) setSelected(null) })
            widget.add_controller(motion)
            click(widget, () => goToWindow(slot.item))

            // as wide as the title, up to a little wider than the window
            const title = (
                <box widthRequest={slot.width + TITLE_WIDTH_EXTRA} canTarget={false} visible={false}>
                    <label
                        class="mc-title"
                        hexpand
                        halign={Gtk.Align.CENTER}
                        label={slot.item.title}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={Math.max(4, Math.floor((slot.width + TITLE_WIDTH_EXTRA) / TITLE_CHAR_WIDTH))}
                    />
                </box>
            ) as Gtk.Widget

            const start = from ?? slot
            const frame: Frame = {
                slot, widget, picture, title,
                at: { ...start }, from: { ...start },
                move: new Tween(from ? 0 : 1),
                leaving: null, held: false,
                dispose: () => {
                    this.stage.remove(widget)
                    this.stage.remove(title)
                    dispose()
                },
            }
            if (from) frame.move.to(1, FLIGHT)
            frameOf.set(widget, frame)
            this.stage.put(widget, 0, 0)
            this.stage.put(title, 0, 0)
            return frame
        })
    }

    private dropFrame(page: Page, frame: Frame) {
        if (drag?.frame === frame) drag = null
        frame.dispose()
        page.frames.delete(frame.slot.item.client.get_address())
    }

    // from where it is now to where it belongs
    private glide(frame: Frame, timing: Timing) {
        frame.from = { ...frame.at }
        frame.move.jump(0)
        frame.move.to(1, timing)
        this.animate()
    }

    /** A window dropped nowhere goes back to its place. */
    sendHome(frame: Frame) {
        this.glide(frame, FLIGHT)
    }

    private showSelected() {
        const address = selected.get()
        for (const page of this.pages.values()) for (const [a, frame] of page.frames) {
            const on = a === address && !frame.leaving
            on ? frame.widget.add_css_class("selected") : frame.widget.remove_css_class("selected")
            frame.title.set_visible(on)
        }
    }

    private showWallpaper() {
        const texture = wallpaperTexture.get()
        for (const page of this.pages.values()) page.wallpaper.set_paintable(texture)
    }

    // ─── The bar ──────────────────────────────────────────────────────────────

    private addItem(desktop: Desktop, index: number): Item {
        const picture = new Gtk.ScrolledWindow({
            cssClasses: ["mc-thumb-canvas", "mc-target"],
            overflow: Gtk.Overflow.HIDDEN,
            hscrollbarPolicy: Gtk.PolicyType.NEVER,
            vscrollbarPolicy: Gtk.PolicyType.NEVER,
        })
        picture.set_size_request(this.size.width, this.size.height)
        // where a window can be dropped, and whose × shows when the pointer
        // is near (closeHoverAt)
        dropTargets.set(desktop.id, picture)

        const label = new Gtk.Label({ label: `Desktop ${index + 1}` })
        const name = new Gtk.Box({ cssClasses: ["mc-name", "mc-target"] })
        name.append(label)

        const item: Item = { id: desktop.id, picture, content: "", disposeContent: () => {}, name, label, x: new Tween() }
        // by the number it has then: moving desktops renumbers them
        click(picture, () => goTo(item.id))
        click(name, () => goTo(item.id))
        this.items.set(desktop.id, item)
        this.fillItem(item, desktop)
        this.bar.put(picture, 0, 0)
        picture.insert_after(this.bar, this.band)
        this.bar.put(name, 0, 0)
        if (this.plus) name.insert_before(this.bar, this.plus)
        return item
    }

    private dropItem(item: Item) {
        item.disposeContent()
        if (dropTargets.get(item.id) === item.picture) dropTargets.delete(item.id)
        this.bar.remove(item.picture)
        this.bar.remove(item.name)
        this.items.delete(item.id)
    }

    // the wallpaper and the desktop's windows where they are, made again
    // only when they have changed
    private fillItem(item: Item, desktop: Desktop) {
        const { monitor } = this.v
        const size = this.size
        const content = JSON.stringify([size, desktop.windows.map(w => [w.address, w.x, w.y, w.width, w.height])])
        if (content === item.content) return
        item.disposeContent()
        item.content = content
        const scale = size.width / monitor.width
        createRoot(dispose => {
            item.disposeContent = dispose
            const wallpaper = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER, canShrink: true })
            const path = wallpaperPath.get()
            if (path) loadThumbnail(path, size.width, size.height).then(t => wallpaper.set_paintable(t))
            const canvas = new Gtk.Fixed()
            for (const w of desktop.windows) {
                const width = Math.max(4, Math.round(w.width * scale))
                const height = Math.max(4, Math.round(w.height * scale))
                canvas.put(
                    <WindowPicture window={w} width={width} height={height} tiles={desktopTiles} /> as Gtk.Widget,
                    Math.round((w.x - monitor.x) * scale),
                    Math.round((w.y - monitor.y) * scale),
                )
            }
            // a Picture's natural size is the whole image — the scroll-less
            // viewport holds it at the picture's size
            const overlay = new Gtk.Overlay({ child: wallpaper })
            overlay.add_overlay(canvas)
            ;(item.picture as Gtk.ScrolledWindow).set_child(overlay)
        })
    }

    // where a window is in a desktop's picture, on the windows' canvas in
    // the open bar's terms (the slots')
    private inPicture(item: Item, window: Window, x = item.x.value): Box {
        const { monitor } = this.v
        const scale = this.size.width / monitor.width
        return {
            x: x + (window.x - monitor.x) * scale,
            y: this.pictureTop() + (window.y - monitor.y) * scale + this.fold(),
            width: window.width * scale,
            height: window.height * scale,
        }
    }

    private pictureTop(): number {
        return lerp(-this.size.height - BAR_TOP, BAR_TOP, this.opening.value)
    }

    private makePlus(): Gtk.Button {
        const plus = new Gtk.Button({ cssClasses: ["mc-add", "mc-target"], focusable: false })
        plus.set_child(new Gtk.Image({ iconName: "list-add-symbolic", pixelSize: 22 }))
        plus.set_size_request(PEEK_SHOWN, this.size.height)
        plus.connect("clicked", () => {
            if (closing.get()) return
            arriving = addDesktop(this.v.monitor.name)
            refresh()
        })
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => { this.pointingAtPlus = true; this.go(this.peek, 1, PEEKING) })
        motion.connect("leave", () => { this.pointingAtPlus = false; this.go(this.peek, 0, PEEKING) })
        plus.add_controller(motion)
        // a window dropped here gets a desktop of its own
        addTarget = plus
        this.bar.put(plus, 0, 0)
        return plus
    }

    // the new desktop + would add: the wallpaper, and + on it
    private makePeek(): Gtk.Widget {
        const sign = new Gtk.Box({ cssClasses: ["mc-peek-sign"], halign: Gtk.Align.START, valign: Gtk.Align.CENTER })
        sign.append(new Gtk.Image({ iconName: "list-add-symbolic", pixelSize: 16 }))
        // in the middle of the part that shows
        sign.set_margin_start(Math.round(PEEK_SHOWN / 2 - 15))
        const overlay = new Gtk.Overlay({ child: this.peekWallpaper })
        overlay.add_overlay(sign)
        const peek = new Gtk.ScrolledWindow({
            cssClasses: ["mc-thumb-canvas", "mc-peek"],
            overflow: Gtk.Overflow.HIDDEN,
            hscrollbarPolicy: Gtk.PolicyType.NEVER,
            vscrollbarPolicy: Gtk.PolicyType.NEVER,
            canTarget: false,
            child: overlay,
        })
        peek.set_size_request(this.size.width, this.size.height)
        const path = wallpaperPath.get()
        if (path) loadThumbnail(path, this.size.width, this.size.height).then(t => this.peekWallpaper.set_paintable(t))
        this.bar.put(peek, 0, 0)
        return peek
    }

    // ─── Changes ──────────────────────────────────────────────────────────────

    update(v: View) {
        const old = this.v
        const W = v.monitor.width
        // where windows are in the desktops' pictures now, for any that come
        // out of one into the windows below
        const origins = new Map<string, Box>()
        if (this.opening.value > 0.5) {
            for (const desktop of old.desktops) {
                const item = this.items.get(desktop.id)
                if (!item || desktop.id === old.monitor.active) continue
                for (const w of desktop.windows) origins.set(w.client.get_address(), this.inPicture(item, w))
            }
        }

        this.v = v
        const added = arriving
        arriving = null
        const size = thumbSize(v.monitor, v.desktops.length)
        const resized = size.width !== this.size.width
        this.size = size

        // the bar: a closed desktop goes at once, the others move up
        for (const [id, item] of [...this.items]) if (!v.desktops.some(d => d.id === id)) this.dropItem(item)
        if (resized) for (const item of this.items.values()) {
            item.picture.set_size_request(size.width, size.height)
            item.content = ""
        }
        this.peekBox.set_size_request(size.width, size.height)
        this.plus.set_size_request(PEEK_SHOWN, size.height)
        for (const [index, desktop] of v.desktops.entries()) {
            const x = rowX(v.monitor, v.desktops.length, size, index)
            let item = this.items.get(desktop.id)
            if (!item) {
                item = this.addItem(desktop, index)
                if (desktop.id === added && this.opening.value > 0.5) {
                    // in from where it peeked; + peeks again once it is there
                    item.x.jump(W - PEEK_SHOWN)
                    this.peek.jump(0)
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARRIVING.ms, () => {
                        if (this.pointingAtPlus) this.go(this.peek, 1, PEEKING)
                        return GLib.SOURCE_REMOVE
                    })
                } else {
                    item.x.jump(x)
                }
            } else {
                this.fillItem(item, desktop)
                item.label.set_label(`Desktop ${index + 1}`)
            }
            item.x.to(x, added !== null ? ARRIVING : CLOSING_UP)
        }

        // the windows: those leaving this desktop for another one's picture
        // fly into it
        const destinations = new Map<string, Box>()
        if (this.opening.value > 0.5) {
            for (const desktop of v.desktops) {
                const item = this.items.get(desktop.id)
                if (!item || desktop.id === v.monitor.active) continue
                for (const w of desktop.windows) destinations.set(w.client.get_address(), this.inPicture(item, w, item.x.target))
            }
        }
        // pages whose desktop has been closed go
        for (const page of [...this.pages.values()]) if (this.indexOf(page.id) < 0) this.dropPage(page)

        const page = this.pages.get(v.monitor.active)
        if (page) {
            this.fill(page, v.slots, origins, destinations)
        } else if (this.pages.size > 0) {
            // another desktop: it slides in next to the one in view
            this.addPage(v.monitor.active, v.slots, new Map())
        } else {
            // the one in view was closed: the next one in its place, the
            // windows coming from the closed one flying out of its picture
            this.addPage(v.monitor.active, v.slots, origins)
            this.camera.jump(this.indexOf(v.monitor.active))
        }
        // The row may have changed around the desktop in view (one before it
        // closed, the desktops reordered): the view stays on it, a slide
        // going on as it was. Only going to another desktop slides.
        const before = old.desktops.findIndex(d => d.id === old.monitor.active)
        const after = v.desktops.findIndex(d => d.id === old.monitor.active)
        if (before >= 0 && after >= 0 && before !== after) this.camera.shift(after - before)
        const index = this.indexOf(v.monitor.active)
        if (this.camera.target !== index) {
            this.camera.to(index)
            this.animate()
        }
        this.markCurrent()
        this.showSelected()
        this.animate()
    }

    // the desktop in view, ringed and named in bold; it jumps there at once
    private markCurrent() {
        for (const item of this.items.values()) {
            const current = item.id === this.v.monitor.active
            for (const widget of [item.picture, item.name])
                current ? widget.add_css_class("current") : widget.remove_css_class("current")
        }
    }

    // ─── Going into a desktop ─────────────────────────────────────────────────
    // Its picture grows from its place in the bar to fill the display, over
    // Mission Control, which stays as it is underneath; once it fills it,
    // that desktop is there, without the slide, and Mission Control goes
    // without the windows flying home. Its windows are drawn by the
    // compositor with the ones spread out, over them.

    /** False when there is no picture to zoom out of. */
    zoomInto(id: number): boolean {
        const item = this.items.get(id)
        const desktop = this.v.desktops.find(d => d.id === id)
        if (this.zoom || !item || !desktop || this.opening.value < 1 || !livePreviews()) return false
        forgetClose()
        this.zoom = createRoot(dispose => {
            const wallpaper = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER, canShrink: true, paintable: wallpaperTexture.get() })
            const canvas = new Gtk.Fixed()
            const windows = desktop.windows.map(window => {
                const picture = <WindowPicture window={window} width={1} height={1} tiles={windowTiles} /> as Gtk.Widget
                canvas.put(picture, 0, 0)
                return { window, picture }
            })
            const overlay = new Gtk.Overlay({ child: wallpaper })
            overlay.add_overlay(canvas)
            // a Picture's natural size is the whole image — the scroll-less
            // viewport holds it at the zoom's size
            const box = new Gtk.ScrolledWindow({
                cssClasses: ["mc-zoom"],
                overflow: Gtk.Overflow.HIDDEN,
                hscrollbarPolicy: Gtk.PolicyType.NEVER,
                vscrollbarPolicy: Gtk.PolicyType.NEVER,
                child: overlay,
            })
            this.top.put(box, 0, 0)
            const zoom: Zoom = {
                id, box, canvas, windows,
                from: { x: item.x.value, y: this.pictureTop(), width: this.size.width, height: this.size.height },
                growing: new Tween(),
                dispose: () => {
                    this.top.remove(box)
                    dispose()
                },
            }
            return zoom
        })
        this.go(this.zoom.growing, 1, FLIGHT)
        return true
    }

    private async zoomed(zoom: Zoom) {
        if (zoom.done) return
        zoom.done = true
        await goToDesktopAtOnce(zoom.id)
        closeAtOnce()
    }

    // ─── Reordering the desktops ──────────────────────────────────────────────
    // A desktop dragged sideways along the bar follows the pointer, the others
    // closing up around the place it would go to, and dropped there it moves
    // (desktops.ts, moveDesktop).

    private reorderOnDrag() {
        const gesture = new Gtk.GestureDrag()
        let grab = 0
        let place = -1
        let from = -1
        const order = () => this.v.desktops.map(d => this.items.get(d.id)!).filter(Boolean)
        // the others in order, leaving a gap at `gap` for the one being dragged
        const lineUp = (skip: Item | null, gap: number) => {
            let slot = 0
            for (const item of order()) {
                if (item === skip) continue
                if (slot === gap) slot++
                item.x.to(rowX(this.v.monitor, this.v.desktops.length, this.size, slot), MAKING_ROOM)
                slot++
            }
            this.animate()
        }

        gesture.connect("drag-update", (_g, dx) => {
            if (closing.get() || this.opening.value < 1) return
            const [, sx, sy] = gesture.get_start_point()
            const items = order()
            if (!this.reordered) {
                if (Math.abs(dx) < DRAG_THRESHOLD) return
                const top = this.pictureTop()
                if (sy < top || sy > top + this.size.height) return
                const index = items.findIndex(i => sx >= i.x.value && sx < i.x.value + this.size.width)
                if (index < 0) return
                // the press is a drag now, not a click on the desktop
                gesture.set_state(Gtk.EventSequenceState.CLAIMED)
                const item = items[index]
                this.reordered = item
                from = place = index
                grab = sx - item.x.value
                reordering = true
                forgetClose()
                // over the others while it passes them: its picture, and the
                // windows in it, which the compositor draws in the order given
                let names = this.bar.get_first_child()
                while (names && !names.has_css_class("mc-name")) names = names.get_next_sibling()
                item.picture.insert_before(this.bar, names)
                reorderedCanvas = item.picture
                for (const w of this.v.desktops[index].windows) {
                    const address = w.client.get_address()
                    const tile = desktopTiles.tiles.get(address)
                    if (!tile) continue
                    desktopTiles.tiles.delete(address)
                    desktopTiles.tiles.set(address, tile)
                }
            }
            const item = this.reordered
            const first = rowX(this.v.monitor, items.length, this.size, 0)
            const last = rowX(this.v.monitor, items.length, this.size, items.length - 1)
            const x = Math.max(first, Math.min(last, sx + dx - grab))
            item.x.jump(x)
            const next = Math.round((x - first) / (this.size.width + THUMB_GAP))
            if (next !== place) {
                place = next
                lineUp(item, place)
            }
            this.place()
        })
        gesture.connect("drag-end", () => {
            const item = this.reordered
            if (!item) return
            this.reordered = null
            reordering = false
            reorderedCanvas = null
            if (place !== from) {
                // The desktops are renumbered as they move: the scene goes by
                // the new numbers before it hears of anything else.
                renumbering = true
                void moveDesktop(this.v.monitor.name, from, place).then(renames => {
                    renumbering = false
                    if (renames) scene?.renumber(renames)
                    refresh()
                })
            } else lineUp(null, -1)
            item.x.to(rowX(this.v.monitor, this.v.desktops.length, this.size, place), MAKING_ROOM)
            place = from = -1
            this.animate()
        })
        this.bar.add_controller(gesture)
    }

    // ─── Moving ───────────────────────────────────────────────────────────────

    private go(tween: Tween, target: number, timing: Timing) {
        tween.to(target, timing)
        this.animate()
    }

    private *moving(): Generator<Tween | Spring> {
        yield this.camera
        yield this.opening
        yield this.names
        yield this.peek
        if (this.zoom) yield this.zoom.growing
        for (const item of this.items.values()) yield item.x
        for (const page of this.pages.values()) for (const frame of page.frames.values()) yield frame.move
    }

    private animate() {
        if (this.tick) return
        this.tick = this.stage.add_tick_callback((_widget, clock) => {
            const now = clock.get_frame_time()
            let running = false
            for (const value of this.moving()) {
                value.step(now)
                if (value.running) running = true
            }
            // windows that have flown into a desktop's picture are there now
            for (const page of this.pages.values())
                for (const frame of [...page.frames.values()])
                    if (frame.leaving && !frame.move.running) this.dropFrame(page, frame)
            // grown to fill the display: that desktop is there
            if (this.zoom && !this.zoom.growing.running && this.zoom.growing.value === 1) void this.zoomed(this.zoom)
            // a desktop slid out of view is gone
            if (!this.camera.running)
                for (const page of [...this.pages.values()])
                    if (page.id !== this.v.monitor.active) this.dropPage(page)
            this.place()
            if (running) return GLib.SOURCE_CONTINUE
            this.tick = 0
            return GLib.SOURCE_REMOVE
        })
    }

    /** Everything where it is at this moment. */
    place() {
        const { monitor } = this.v
        const W = monitor.width
        const open = this.opening.value
        const fold = this.fold()
        const pitch = W + Math.round(W * SLIDE_GAP_SHARE)

        // the windows and the wallpaper, desktop by desktop
        this.backdrop.set_size_request(W, monitor.height)
        this.backdrop.set_visible(this.pages.size > 1)
        for (const page of this.pages.values()) {
            const offset = Math.round((this.indexOf(page.id) - this.camera.value) * pitch)
            this.stage.move(page.wallpaper, offset, 0)
            for (const frame of page.frames.values()) {
                if (!frame.held) frame.at = lerpBox(frame.from, frame.leaving ?? frame.slot, frame.move.value)
                const { x, y, width, height } = frame.at
                frame.picture.set_size_request(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
                this.stage.move(frame.widget, Math.round(x + offset) - FRAME, Math.round(y - fold) - FRAME)
                this.stage.move(frame.title, Math.round(x + offset + width / 2 - (frame.slot.width + TITLE_WIDTH_EXTRA) / 2),
                    Math.round(y - fold + height + FRAME + 6))
            }
        }

        // the bar
        const bottom = Math.round(this.barBottom())
        this.band.set_size_request(W, bottom)
        // the bar is as tall as its band, and the windows below it are
        // there for the pointer
        this.bar.get_parent()?.set_size_request(-1, bottom)
        const size = this.size
        const top = Math.round(this.pictureTop())
        const items = this.v.desktops.map(d => this.items.get(d.id)).filter((i): i is Item => !!i)
        for (const item of items) this.bar.move(item.picture, Math.round(item.x.value), top)

        // the names: a row of pills folded, the pictures' captions open
        const widths = items.map(item => item.name.measure(Gtk.Orientation.HORIZONTAL, -1)[1])
        const pill = items.length ? items[0].name.measure(Gtk.Orientation.VERTICAL, -1)[1] : 0
        let folded = (W - widths.reduce((a, b) => a + b, 0) - NAME_SPACING * (items.length - 1)) / 2
        const coming = (1 - this.names.value) * NAMES_DROP
        items.forEach((item, i) => {
            const caption = { x: item.x.value + (size.width - widths[i]) / 2, y: BAR_TOP + size.height + NAME_GAP - NAME_PAD }
            const x = lerp(folded, caption.x, open)
            const y = lerp((FOLDED_BAR - pill) / 2, caption.y, open) - coming
            this.bar.move(item.name, Math.round(x), Math.round(y))
            item.name.set_opacity(this.names.value)
            open > 0.5 ? item.name.add_css_class("open") : item.name.remove_css_class("open")
            folded += widths[i] + NAME_SPACING
        })

        // + at the bar's end, and the new desktop peeking in behind it
        this.bar.move(this.plus, W - PEEK_SHOWN, top)
        this.plus.set_opacity(open * (1 - this.peek.value))
        this.plus.set_can_target(open > 0.5)
        this.bar.move(this.peekBox, Math.round(W - PEEK_SHOWN * this.peek.value), top)
        this.peekBox.set_visible(this.peek.value > 0)

        // a desktop being zoomed into, its windows where they are on it
        if (this.zoom) {
            const { box, canvas, windows, from, growing } = this.zoom
            const at = lerpBox(from, { x: 0, y: 0, width: W, height: monitor.height }, growing.value)
            box.set_size_request(Math.round(at.width), Math.round(at.height))
            this.top.move(box, Math.round(at.x), Math.round(at.y))
            const scale = at.width / W
            for (const { window, picture } of windows) {
                picture.set_size_request(Math.max(1, Math.round(window.width * scale)), Math.max(1, Math.round(window.height * scale)))
                canvas.move(picture, Math.round((window.x - monitor.x) * scale), Math.round((window.y - monitor.y) * scale))
            }
        }
    }
}

// ─── The × that closes a desktop ──────────────────────────────────────────────
// On the top-left corner of the desktop's picture while the pointer is on the
// desktop, as macOS has it. The windows in the picture are drawn by the
// compositor over the shell's surface and would hide anything the shell put
// there, so the × is a little surface of its own above Mission Control. Not a
// popup: Hyprland gives a popup of a layer that takes the keyboard the
// keyboard too, once the pointer is on it, and doesn't give it back when the
// popup goes — Escape and the arrows did nothing until the pointer moved.

type CloseTarget = { desktop: number; x: number; y: number }
const [closeTarget, setCloseTarget] = createState<CloseTarget | null>(null)
const hovering: { desktop: CloseTarget | null; button: boolean } = { desktop: null, button: false }
let closeSource = 0

// It shows as soon as the pointer is on the desktop, as on macOS, and stays a
// moment after it has left: the pointer may cross from the picture onto the
// × and back without it going.
function settleClose() {
    if (closeSource) GLib.source_remove(closeSource)
    closeSource = 0
    const wanted = () => closing.get() || reordering ? null : hovering.button ? closeTarget.get() : hovering.desktop
    const apply = () => {
        const want = wanted()
        const now = closeTarget.get()
        if (want?.desktop !== now?.desktop || want?.x !== now?.x || want?.y !== now?.y) setCloseTarget(want)
    }
    if (wanted()) return apply()
    closeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_LINGER_MS, () => {
        closeSource = 0
        apply()
        return GLib.SOURCE_REMOVE
    })
}

function forgetClose() {
    hovering.desktop = null
    hovering.button = false
    if (closeTarget.get()) setCloseTarget(null)
}

// How far around a desktop's picture the pointer still counts as on it. The ×
// sits half outside the picture's corner, and on the way there the pointer
// leaves the picture: going by the picture alone, the × went before the
// pointer got to it.
const CLOSE_REACH = 16

// Which desktop the pointer is on, from wherever it is over Mission Control.
// Leaving Mission Control's surface is going onto the ×, the only thing over
// it: the × keeps itself up then (CloseButton).
function closeHoverAt(x: number, y: number) {
    const window = mcWindow
    const v = view.get()
    let found: CloseTarget | null = null
    // a display keeps at least one desktop; and not while dragging something
    if (window && v && v.desktops.length > 1 && !drag && !reordering && expanded.get()) {
        for (const [desktop, canvas] of dropTargets) {
            if (scene?.isMoving(desktop)) continue
            const [ok, b] = canvas.compute_bounds(window)
            if (!ok) continue
            const reach = CLOSE_REACH
            if (x < b.get_x() - reach || x >= b.get_x() + b.get_width() + reach ||
                y < b.get_y() - reach || y >= b.get_y() + b.get_height() + reach) continue
            // the × is placed on the window's surface, which starts outside
            // its CSS padding
            const [dx, dy] = window.get_surface_transform()
            found = { desktop, x: b.get_x() + dx, y: b.get_y() + dy }
            break
        }
    }
    if (found?.desktop === hovering.desktop?.desktop) return
    hovering.desktop = found
    settleClose()
}

function CloseButton({ monitor }: { monitor: Accessor<Gdk.Monitor> }) {
    const corner = (t: CloseTarget | null, axis: "x" | "y") =>
        t ? Math.max(0, Math.round(t[axis] - CLOSE_SIZE / 2 - CLOSE_PAD)) : 0
    return (
        <window
            namespace={LAYER.missionControlClose}
            name="ags-mission-control-close"
            class="MissionControlClose"
            visible={closeTarget(t => t !== null)}
            gdkmonitor={monitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT}
            marginLeft={closeTarget(t => corner(t, "x"))}
            marginTop={closeTarget(t => corner(t, "y"))}
            application={app}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.NONE}
            $={(self) => {
                onCleanup(() => destroyWindow(self))
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", () => { hovering.button = true; settleClose() })
                motion.connect("leave", () => { hovering.button = false; settleClose() })
                self.add_controller(motion)
            }}
        >
            <button
                class="mc-close"
                focusable={false}
                marginTop={CLOSE_PAD}
                marginBottom={CLOSE_PAD}
                marginStart={CLOSE_PAD}
                marginEnd={CLOSE_PAD}
                onClicked={() => {
                    const target = closeTarget.get()
                    const v = view.get()
                    forgetClose()
                    if (target && v && !closing.get())
                        void removeDesktop(v.monitor.name, target.desktop).then(refresh)
                }}
            >
                <Gtk.Image iconName="window-close-symbolic" pixelSize={11} />
            </button>
        </window>
    )
}

// gone with the view it was for, and before the windows fly home
view.subscribe(forgetClose)
closing.subscribe(() => { if (closing.get()) forgetClose() })

// a desktop is being dragged along the bar
let reordering = false
// and dropped: the desktops are being renumbered
let renumbering = false

// ─── Keys ─────────────────────────────────────────────────────────────────────

// the window the arrow keys go to from the selected one: the nearest whose
// middle lies that way, sideways distance counting double
function nextWindow(slots: Slot<Window>[], from: string | null, keyval: number): string | null {
    const middle = (s: Slot<Window>) => [s.x + s.width / 2, s.y + s.height / 2]
    const current = slots.find(s => s.item.client.get_address() === from)
    if (!current) {
        // the window last used, to start from
        const first = [...slots].sort((a, b) => a.item.focusHistory - b.item.focusHistory)[0]
        return first?.item.client.get_address() ?? null
    }
    const [x0, y0] = middle(current)
    const [dx, dy] = {
        [Gdk.KEY_Left]: [-1, 0], [Gdk.KEY_Right]: [1, 0], [Gdk.KEY_Up]: [0, -1], [Gdk.KEY_Down]: [0, 1],
    }[keyval] ?? [0, 0]
    let best: Slot<Window> | null = null
    let bestDistance = Infinity
    for (const s of slots) {
        if (s === current) continue
        const [x, y] = middle(s)
        const along = (x - x0) * dx + (y - y0) * dy
        if (along <= 0) continue
        const across = Math.abs((x - x0) * dy) + Math.abs((y - y0) * dx)
        const distance = along + 2 * across
        if (distance < bestDistance) {
            best = s
            bestDistance = distance
        }
    }
    return best?.item.client.get_address() ?? from
}

function onKey(keyval: number): boolean {
    const v = view.get()
    if (!v || closing.get()) return closing.get()
    switch (keyval) {
        case Gdk.KEY_Escape:
            closeMissionControl()
            return true
        case Gdk.KEY_Left:
        case Gdk.KEY_Right:
        case Gdk.KEY_Up:
        case Gdk.KEY_Down:
            setSelected(nextWindow(v.slots, selected.get(), keyval))
            return true
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
        case Gdk.KEY_space: {
            const slot = v.slots.find(s => s.item.client.get_address() === selected.get())
            if (slot) goToWindow(slot.item)
            else closeMissionControl()
            return true
        }
    }
    return false
}

// ─── The window ───────────────────────────────────────────────────────────────

export default function MissionControl({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const monitor = createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)

    // the wallpaper behind it all, at the display's own pixels
    const loadWallpaper = () => {
        const path = wallpaperPath.get()
        const m = monitor.get()
        if (!path) return setWallpaperTexture(null)
        const { width, height } = m.get_geometry()
        // loadThumbnail decodes at twice the size asked for
        const scale = m.get_scale() / 2
        loadThumbnail(path, Math.round(width * scale), Math.round(height * scale))
            .then(t => { if (wallpaperPath.get() === path) setWallpaperTexture(t) })
    }
    // Ready before it is first needed: decoding a 4K photo takes a while,
    // and opening without it, the wallpaper came in once the windows had
    // already flown.
    wallpaperPath.subscribe(loadWallpaper)
    monitor.subscribe(loadWallpaper)
    loadWallpaper()
    isOpen.subscribe(() => { if (isOpen.get()) loadWallpaper() })

    // the bar, over the windows: its desktops' windows are the compositor's
    const bar = new PreviewPane({ valign: Gtk.Align.START, vexpand: false })
    bar.onLayout = () => desktopTiles.measure()
    desktopTiles.pane = bar

    const stage = new Holder({ hexpand: true, vexpand: true })
    const barHolder = new Holder({ hexpand: true })
    bar.append(barHolder)
    // a desktop being zoomed into, over everything, for the eye only
    const topHolder = new Holder({ hexpand: true, vexpand: true, canTarget: false })
    const pane = new PreviewPane({ hexpand: true, vexpand: true })
    pane.append(
        <overlay hexpand vexpand>
            {stage}
            <box $type="overlay" valign={Gtk.Align.START}>{bar}</box>
            <box $type="overlay" canTarget={false}>{topHolder}</box>
        </overlay> as Gtk.Widget,
    )
    pane.onLayout = () => windowTiles.measure()
    windowTiles.pane = pane

    // what is shown, from one change to the next while open
    const unsubscribe = view.subscribe(() => {
        const v = view.get()
        if (!v) {
            scene?.destroy()
            scene = null
            return
        }
        if (scene) return scene.update(v)
        scene = new Scene(v)
        scene.stage.set_parent(stage)
        scene.bar.set_parent(barHolder)
        scene.top.set_parent(topHolder)
    })
    onCleanup(() => {
        unsubscribe()
        scene?.destroy()
        scene = null
        if (windowTiles.pane === pane) windowTiles.pane = null
        if (desktopTiles.pane === bar) desktopTiles.pane = null
    })

    return [
        <window
            namespace={LAYER.missionControl}
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isOpen}
            name="ags-mission-control"
            class={themeClasses(t => `MissionControl ${t}`)}
            gdkmonitor={monitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            // On demand rather than exclusive, set before it maps, which is
            // when Hyprland hands it the keyboard: while an exclusive layer
            // is up, Hyprland lets the pointer reach nothing else, the ×
            // above it included.
            keymode={Astal.Keymode.ON_DEMAND}
            $={(self) => {
                mcWindow = self
                windowTiles.window = self
                desktopTiles.window = self
                onCleanup(() => {
                    windowTiles.hidden()
                    desktopTiles.hidden()
                    if (windowTiles.window === self) windowTiles.window = null
                    if (desktopTiles.window === self) desktopTiles.window = null
                    if (mcWindow === self) mcWindow = null
                    destroyWindow(self)
                })

                const keys = new Gtk.EventControllerKey()
                keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                keys.connect("key-pressed", (_controller, keyval) =>
                    onKey(keyval) ? Gdk.EVENT_STOP : Gdk.EVENT_PROPAGATE)
                // whatever had the focus last time is gone, rebuilt since
                self.connect("map", () => self.set_focus(null))
                self.add_controller(keys)

                // Which desktop's × to show, from wherever the pointer is;
                // and the bar opens once the pointer is up in it.
                const pointer = new Gtk.EventControllerMotion()
                pointer.connect("motion", (_controller, x, y) => {
                    closeHoverAt(x, y)
                    if (scene && isOpen.get() && !closing.get() && !expanded.get() && y < scene.barBottom()) setExpanded(true)
                })
                self.add_controller(pointer)

                // anywhere that isn't a window, a desktop or a button leaves
                const background = new Gtk.GestureClick()
                background.connect("released", (_gesture, _n, x, y) => {
                    for (let w = self.pick(x, y, Gtk.PickFlags.DEFAULT); w; w = w.get_parent())
                        if (w.has_css_class("mc-target")) return
                    closeMissionControl()
                })
                self.add_controller(background)
            }}
        >
            {pane}
        </window>,
        <CloseButton monitor={monitor} />,
    ]
}
