import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import Pango from "gi://Pango"
import Hyprland from "gi://AstalHyprland"
import { createRoot, createState, onCleanup } from "ags"

import { logger } from "../../log"
import { snapWindow } from "../../hypr"
import { destroyWindow } from "../monitors"
import { themeClasses, LAYER } from "../services/theme"
import { livePreviews, LiveTiles, PreviewPane } from "../services/previews"
import { isMinimized } from "../Dock/dock-state"
import { spread, type Box } from "../MissionControl/spread"
import { monitorNamed, windowsByDesktop } from "../MissionControl/desktops"
import { isOpen as missionControlOpen } from "../MissionControl/MissionControl"

const log = logger("snap-assist")
const hyprland = Hyprland.get_default()

// ─── Filling the other half ───────────────────────────────────────────────────
// A window snapped to one half of the desktop leaves the other half free
// (src/hyprland-plugin/snap.cpp says where: kiwisnapped). The desktop's other
// windows are offered there, as macOS's Split View offers them for its
// second side and Windows' Snap Assist for the space left: the one clicked
// fills it. Anything else — Escape, a click outside, another window taking
// the focus, another desktop — and the offer is gone. Nothing is offered
// when there is nothing else on the desktop, or the half is filled already.

// the panel's room round the pictures, and between them (the title below each)
const PAD = 28
const SPREAD = { columnSpacing: 24, rowSpacing: 40, maxScale: 0.5 }
const TITLE_HEIGHT = 18
const RADIUS = 8
const FADE_MS = 140
const FADE_OUT_MS = 120

type Offer = {
    // the window snapped, and the side it went to
    snapped: string
    side: "left" | "right"
    monitor: string
    // the free half: the window there with its bar, in global logical pixels
    rect: Box
    // the display's logical size
    screen: { width: number, height: number }
    windows: { client: Hyprland.Client, box: Box }[]
}

const [offer, setOffer] = createState<Offer | null>(null)
// the display of the last offer, kept while it fades
const [display, setDisplay] = createState<string>("")
// up once laid out for the offer: mapped at its size, not grown after
const [shown, setShown] = createState(false)

const live = new LiveTiles({
    set: "snap-assist",
    namespace: LAYER.snapAssist,
    motion: "live",
    radius: RADIUS,
    shadow: true,
})

const addressOf = (client: Hyprland.Client) => client.get_address()
const near = (a: number, b: number) => Math.abs(a - b) < 6

// a window put in the free half by this offer: its own snap says nothing
// (and when the other half is taken, there is no snap of its to say it)
let placing: string | null = null
const PLACED_MS = 500

function offered(args: string) {
    const [address, side, monitorName, ...numbers] = args.split(",")
    if (address === placing) {
        placing = null
        return
    }
    const [x, y, width, height] = numbers.map(Number)
    if (side !== "left" && side !== "right" || ![x, y, width, height].every(Number.isFinite)) return
    if (missionControlOpen.get() || !livePreviews()) return
    // where the windows are now, from the compositor: Astal's geometry goes
    // stale once a window is moved by hand
    const screen = monitorNamed(monitorName)
    if (!screen) return
    const onDesktop = (windowsByDesktop().get(screen.active) ?? []).filter(w => !isMinimized(w.client))
    // the free half filled already: a window snapped there
    const filled = onDesktop.some(w => near(w.x, x) && near(w.x + w.width, x + width) && w.y >= y - 6 && near(w.y + w.height, y + height))
    const windows = onDesktop
        .filter(w => addressOf(w.client) !== address.replace(/^0x/, ""))
        // the most recently used first
        .sort((a, b) => a.focusHistory - b.focusHistory)
        .map(w => ({ client: w.client, box: { x: w.x, y: w.y, width: w.width, height: w.height } }))
    if (filled || windows.length === 0) return
    log.debug(`offering ${windows.length} windows for the ${side === "left" ? "right" : "left"} half`)
    setDisplay(monitorName)
    setOffer({ snapped: address.replace(/^0x/, ""), side, monitor: monitorName, rect: { x, y, width, height },
        screen: { width: screen.width, height: screen.height }, windows })
}

// The window picked grows out of its picture into the half, as in macOS's
// Split View: its picture goes at once (the window is where it was), the
// others fade with the panel.
function pick(client: Hyprland.Client, picture: Gtk.Widget) {
    const o = offer.get()
    if (!o) return
    const window = live.window
    const [ok, bounds] = window ? picture.compute_bounds(window) : [false, null]
    const origin = monitorOf(o.monitor).get_geometry()
    const from = ok && bounds
        ? { x: origin.x + bounds.get_x(), y: origin.y + bounds.get_y(), width: bounds.get_width(), height: bounds.get_height() }
        : undefined
    picture.set_opacity(0)
    const placed = placing = addressOf(client)
    setOffer(null)
    void snapWindow(addressOf(client), o.side === "left" ? "right" : "left", from).finally(() =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACED_MS, () => {
            if (placing === placed) placing = null
            return GLib.SOURCE_REMOVE
        }))
}

const monitorOf = (connector: string) =>
    app.get_monitors().find(m => m.get_connector() === connector) ?? app.get_monitors()[0]

hyprland.connect("event", (_h: unknown, event: string, args: string) => {
    if (event === "kiwisnapped") return offered(args)
    const o = offer.get()
    if (!o) return
    // the desktop gone from view, or the window snapped closed or moved
    if (event === "workspacev2" || event === "activespecialv2") setOffer(null)
    else if ((event === "closewindow" || event === "movewindowv2") && args.split(",")[0] === o.snapped) setOffer(null)
})

function Picture({ client, slot, onPick }: { client: Hyprland.Client; slot: Box; onPick: (picture: Gtk.Widget) => void }) {
    const address = addressOf(client)
    const picture = new Gtk.Box({ cssClasses: ["snap-assist-picture"], widthRequest: Math.round(slot.width), heightRequest: Math.round(slot.height) })
    live.tiles.set(address, picture)
    onCleanup(() => { if (live.tiles.get(address) === picture) live.tiles.delete(address) })
    return (
        <box
            class="snap-assist-window"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={6}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.connect("released", () => onPick(picture))
                self.add_controller(click)
            }}
        >
            {picture}
            <label
                class="snap-assist-title"
                label={client.title || client.class || ""}
                ellipsize={Pango.EllipsizeMode.END}
                maxWidthChars={1}
                widthRequest={Math.round(slot.width)}
                heightRequest={TITLE_HEIGHT}
            />
        </box>
    )
}

// The keyboard: the arrows go from window to window, Enter puts the one
// chosen in the half. Any other key lets the offer go, as a click elsewhere
// does: the keys are the windows' again, not swallowed until Escape.
let choices: { client: Hyprland.Client; widget: Gtk.Widget; picture: Gtk.Widget }[] = []
let chosen = -1
function choose(step: number) {
    if (choices.length === 0) return
    choices[chosen]?.widget.remove_css_class("selected")
    chosen = chosen < 0 ? (step > 0 ? 0 : choices.length - 1) : (chosen + step + choices.length) % choices.length
    choices[chosen].widget.add_css_class("selected")
}

export default function SnapAssist() {
    const pane = new PreviewPane({ hexpand: true, vexpand: true })
    const canvas = new Gtk.Fixed({ hexpand: true, vexpand: true })
    pane.append(canvas)
    pane.onLayout = () => live.measure()
    live.pane = pane

    // the pictures for an offer, laid out in the free half as Mission Control
    // lays a desktop out, in a scope of their own (built from a subscription)
    let built: (() => void) | null = null
    const build = (o: Offer) => createRoot(dispose => {
        const area = { x: PAD, y: PAD, width: o.rect.width - 2 * PAD, height: o.rect.height - 2 * PAD - TITLE_HEIGHT }
        const slots = spread(o.windows.map(w => ({ item: w.client, box: w.box })), area, o.screen, SPREAD)
        const widgets: Gtk.Widget[] = []
        choices = []
        chosen = -1
        for (const slot of slots) {
            const w = <Picture client={slot.item} slot={slot} onPick={picture => pick(slot.item, picture)} /> as Gtk.Widget
            canvas.put(w, Math.round(slot.x), Math.round(slot.y))
            widgets.push(w)
            choices.push({ client: slot.item, widget: w, picture: w.get_first_child()! })
        }
        built = () => {
            for (const w of widgets) canvas.remove(w)
            choices = []
            chosen = -1
            dispose()
            live.tiles.clear()
        }
    })

    // The window covers the display, as the switcher's × does, and takes the
    // pointer only on the panel: a click anywhere else goes to the window
    // there (and takes the focus away, which lets the offer go).
    const panel = new Gtk.Box({ cssClasses: ["snap-assist-panel"] })
    panel.append(pane)
    const stage = new Gtk.Fixed({ hexpand: true, vexpand: true })
    stage.put(panel, 0, 0)
    let panelBox: Box | null = null

    return (
        <window
            namespace={LAYER.snapAssist}
            name="ags-snap-assist"
            class={themeClasses(t => `SnapAssist ${t}`)}
            visible={shown}
            gdkmonitor={display(monitorOf)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            // the keyboard, taken as it maps (choose, pick, let go)
            keymode={Astal.Keymode.ON_DEMAND}
            $={(self) => {
                live.window = self
                // only the panel takes the pointer (surface coordinates)
                const region = () => {
                    const surface = self.get_surface()
                    if (!surface) return
                    const r = new Cairo.Region()
                    if (panelBox) {
                        const [dx, dy] = self.get_surface_transform()
                        const box = new Cairo.RectangleInt()
                        ;[box.x, box.y, box.width, box.height] = [panelBox.x + dx, panelBox.y + dy, panelBox.width, panelBox.height].map(Math.round)
                        r.unionRectangle(box)
                    }
                    surface.set_input_region(r)
                }
                self.connect("map", region)
                let fade = 0
                const gone = () => {
                    built?.()
                    built = null
                    setShown(false)
                    live.hidden()
                }
                // the panel's opacity from where it is to `to`, the pictures
                // with it (a tile's alpha is its widget's), then `done`
                const fadeTo = (to: number, ms: number, done?: () => void) => {
                    if (fade) panel.remove_tick_callback(fade)
                    const from = panel.get_opacity()
                    let start = -1
                    fade = panel.add_tick_callback((_w, clock) => {
                        const now = clock.get_frame_time() / 1000
                        if (start < 0) start = now
                        const t = Math.min(1, (now - start) / ms)
                        panel.set_opacity(from + (to - from) * (1 - Math.pow(1 - t, 3)))
                        live.measure()
                        if (t < 1) return GLib.SOURCE_CONTINUE
                        fade = 0
                        done?.()
                        return GLib.SOURCE_REMOVE
                    })
                }
                const follow = () => {
                    const o = offer.get()
                    if (!o) {
                        // going: faded out from how far it came in, the
                        // pointer through to what is under it already
                        panelBox = null
                        region()
                        if (shown.get() && self.get_mapped() && panel.get_opacity() > 0) fadeTo(0, FADE_OUT_MS, gone)
                        else {
                            if (fade) panel.remove_tick_callback(fade)
                            fade = 0
                            gone()
                        }
                        return
                    }
                    built?.()
                    built = null
                    // the free half, from the display's corner
                    const geometry = monitorOf(o.monitor).get_geometry()
                    panelBox = { x: o.rect.x - geometry.x, y: o.rect.y - geometry.y, width: o.rect.width, height: o.rect.height }
                    panel.set_size_request(Math.round(o.rect.width), Math.round(o.rect.height))
                    stage.move(panel, Math.round(panelBox.x), Math.round(panelBox.y))
                    region()
                    build(o)
                    // coming in, from its first frame once it is on screen
                    if (fade) panel.remove_tick_callback(fade)
                    fade = 0
                    panel.set_opacity(0)
                    const fadeIn = () => fadeTo(1, FADE_MS)
                    if (self.get_mapped()) fadeIn()
                    else {
                        const mapped = self.connect("map", () => {
                            self.disconnect(mapped)
                            if (offer.get() === o) fadeIn()
                        })
                    }
                    setShown(true)
                    live.shown()
                }
                onCleanup(offer.subscribe(follow))
                onCleanup(() => built?.())

                const keys = new Gtk.EventControllerKey()
                keys.connect("key-pressed", (_c, keyval) => {
                    switch (keyval) {
                        case Gdk.KEY_Left: case Gdk.KEY_Up: case Gdk.KEY_KP_Left: case Gdk.KEY_KP_Up:
                            choose(-1)
                            return true
                        case Gdk.KEY_Right: case Gdk.KEY_Down: case Gdk.KEY_Tab: case Gdk.KEY_KP_Right: case Gdk.KEY_KP_Down:
                            choose(1)
                            return true
                        case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: case Gdk.KEY_space: {
                            const choice = choices[chosen]
                            if (choice) pick(choice.client, choice.picture)
                            return true
                        }
                    }
                    setOffer(null)
                    return true
                })
                self.add_controller(keys)
                // a click on the panel, not on a window, lets it go
                const click = new Gtk.GestureClick()
                click.connect("released", (_g, _n, x, y) => {
                    for (let w = self.pick(x, y, Gtk.PickFlags.DEFAULT); w; w = w.get_parent())
                        if (w.has_css_class("snap-assist-window")) return
                    setOffer(null)
                })
                self.add_controller(click)
                // the focus gone to a window: clicked elsewhere
                self.connect("notify::is-active", () => {
                    if (!self.isActive && offer.get()) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!self.isActive) setOffer(null)
                        return GLib.SOURCE_REMOVE
                    })
                })
                onCleanup(() => {
                    if (live.window === self) live.window = null
                    if (live.pane === pane) live.pane = null
                    destroyWindow(self)
                })
            }}
        >
            {stage}
        </window>
    )
}
