import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Gio from "gi://Gio"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { conf } from "./config"

// ─── When a display's zoom may have changed ─────────────────────────────────────
// Icons look their resolution up from their zoom (below), so they're told when
// any of what decides it changes. Coalesced to a microtask: by then every box
// has followed and set its own zoom, so each listener reads a settled tree.

const zoomChangeCbs = new Set<() => void>()
/** Runs `cb` whenever a display's zoom may have changed; returns an unsubscribe. */
export function onZoomChange(cb: () => void): () => void {
    zoomChangeCbs.add(cb)
    return () => { zoomChangeCbs.delete(cb) }
}
let emitQueued = false
function emitZoomChange() {
    if (emitQueued) return
    emitQueued = true
    Promise.resolve().then(() => {
        emitQueued = false
        for (const cb of [...zoomChangeCbs]) { try { cb() } catch (e) { console.error(e) } }
    })
}

// ─── kiwi's own size on each display ──────────────────────────────────────────
// Apart from the apps': a display at scale 1, for more room for apps, keeps
// kiwi at the size that looks right on it. Worked out from how far away a
// display is likely seen, so that kiwi looks about the same size to the eye
// everywhere. kiwi's sizes were set on a 13.3" 2880x1800 laptop at scale 2:
// 124 logical px to the inch, about 50 cm away.
// - A laptop's own panel is seen from about that far whatever its size: there
//   its density decides.
// - A monitor is seen from further the bigger it is, about in step with its
//   size: there it's how many logical px tall it is. A 27" 2560x1440 at scale
//   1, about 70 cm away, shows kiwi as the laptop does at 1.25 (1 at its scale
//   1.25).
// In quarter steps, as Windows' scales are, from 1 (kiwi's own size) to 3.

const LAPTOP_PX_PER_INCH = 124
const MONITOR_PX_TALL = 1152
const LAPTOP_PX_TALL = 900
const STEP = 0.25

const builtIn = (monitor: Gdk.Monitor) => /^(eDP|LVDS|DSI)/i.test(monitor.get_connector() ?? "")

/** The size kiwi takes on a display by itself, 1 being its own. */
export function autoZoom(monitor: Gdk.Monitor): number {
    const { width, height } = monitor.get_geometry()
    let zoom = Math.min(width, height) / MONITOR_PX_TALL
    if (builtIn(monitor)) {
        const inches = Math.hypot(monitor.get_width_mm(), monitor.get_height_mm()) / 25.4
        const perInch = Math.hypot(width, height) / inches
        // (a size no laptop's panel has, or none said: by its height)
        zoom = inches > 7 && inches < 25 && perInch > 50 && perInch < 400
            ? perInch / LAPTOP_PX_PER_INCH
            : Math.min(width, height) / LAPTOP_PX_TALL
    }
    return Math.min(3, Math.max(1, Math.round(zoom / STEP) * STEP))
}

/** A display as the settings keep it: its make and model, else its connector. */
export const displayKey = (monitor: Gdk.Monitor) =>
    [monitor.get_manufacturer(), monitor.get_model()].filter(Boolean).join(" ") || (monitor.get_connector() ?? "")

/** A display's name for people. */
export const displayName = (monitor: Gdk.Monitor) =>
    builtIn(monitor) ? "Built-in Display" : displayKey(monitor)

/** The size chosen for a display in the settings, else its own. */
export function zoomOf(monitor: Gdk.Monitor | null | undefined): number {
    if (!monitor) return 1
    const chosen = Number(conf.peek().interface_scale?.[displayKey(monitor)])
    return chosen >= 0.5 && chosen <= 4 ? chosen : autoZoom(monitor)
}

// ─── Popover frames ───────────────────────────────────────────────────────────
// A popover's frame (its padding, corners, gap to what it opens from) is drawn
// outside its content, so it doesn't grow with it: the styles give its sizes
// as calc(12px * var(--zoom, 1)), --zoom set by a class on the popover.

const zoomClasses = new Map<number, string>()
let zoomCss: Gtk.CssProvider | null = null

function classFor(zoom: number): string {
    let name = zoomClasses.get(zoom)
    if (name) return name
    name = `kiwi-zoom-${String(zoom).replace(".", "_")}`
    zoomClasses.set(zoom, name)
    if (!zoomCss) {
        zoomCss = new Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, zoomCss,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
    zoomCss.load_from_string([...zoomClasses].map(([z, c]) => `.${c} { --zoom: ${z}; }`).join("\n"))
    return name
}

// ─── The zoom ─────────────────────────────────────────────────────────────────
// One child, laid out smaller by the zoom and drawn larger by it: GTK carries
// the transform through drawing, picking and every compute_bounds(), so input
// regions, blur regions and what kiwi tells Hyprland of its windows stay in
// the window's own coordinates. Its display is its window's (a popover's,
// the window it opens from), followed as a popup moves to another display.
// A box underneath, so GTK lets go of the child itself: a dispose of its own
// in JS doesn't run when the collector takes it, and nothing of it is
// watched from here (below: the windows are, and their zooms looked up).

// laid out by this rather than vfuncs of its own: GTK lays out a widget with
// its layout manager whenever it has one, and a box always has
const ZoomLayout = GObject.registerClass(
    { GTypeName: "KiwiZoomLayout" },
    class ZoomLayout extends Gtk.LayoutManager {
        vfunc_get_request_mode(widget: Gtk.Widget): Gtk.SizeRequestMode {
            return widget.get_first_child()?.get_request_mode() ?? Gtk.SizeRequestMode.CONSTANT_SIZE
        }

        vfunc_measure(widget: Gtk.Widget, orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
            const box = widget as ZoomBox
            // (the first time it's laid out: in a window by then)
            if (!box.known && box.get_root()) box.follow()
            const content = box.get_first_child()
            if (!content) return [0, 0, -1, -1]
            const zoom = box.zoom
            const [min, nat] = content.measure(orientation, forSize < 0 ? -1 : Math.floor(forSize / zoom))
            return [Math.ceil(min * zoom), Math.ceil(nat * zoom), -1, -1]
        }

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, _baseline: number) {
            const box = widget as ZoomBox
            const content = box.get_first_child()
            if (!content) return
            const zoom = box.zoom
            content.allocate(Math.floor(width / zoom), Math.floor(height / zoom), -1,
                zoom === 1 ? null : Gsk.Transform.new().scale(zoom, zoom))
        }
    },
)

const ZoomBox = GObject.registerClass(
    { GTypeName: "KiwiZoom", CssName: "zoom" },
    class ZoomBox extends Gtk.Box {
        zoom = 1
        known = false
        private popoverClass = ""

        constructor(params?: Partial<Gtk.Box.ConstructorProps>) {
            super(params)
            this.set_layout_manager(new ZoomLayout())
        }

        private monitor(): Gdk.Monitor | null {
            const window = this.get_root()
            if (!(window instanceof Gtk.Window)) return null
            const own = window instanceof Astal.Window ? window.gdkmonitor : null
            const surface = window.get_surface()
            return own ?? (surface ? Gdk.Display.get_default()?.get_monitor_at_surface(surface) ?? null : null)
        }

        /** Its display's zoom looked up again: a setting, a display or a window changed. */
        follow() {
            this.known = true
            const zoom = zoomOf(this.monitor())
            const popover = this.get_ancestor(Gtk.Popover.$gtype)
            if (popover) {
                const name = classFor(zoom)
                if (name !== this.popoverClass) {
                    if (this.popoverClass) popover.remove_css_class(this.popoverClass)
                    popover.add_css_class(name)
                    this.popoverClass = name
                }
            }
            if (zoom === this.zoom) return
            this.zoom = zoom
            this.queue_resize()
            // Laid out again all the way down: a panel sized by what it holds
            // keeps its own size in its own units, GTK changes only the
            // transform and lays out nothing inside, and what measures itself
            // on the screen as it's laid out (input regions, the compositor's
            // previews) stayed where the old size had it.
            const again = (widget: Gtk.Widget) => {
                widget.queue_allocate()
                for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) again(child)
            }
            const content = this.get_first_child()
            if (content) again(content)
            emitZoomChange()
        }
    },
)
type ZoomBox = InstanceType<typeof ZoomBox>

// Every zoom in a window (its popovers' too: they hang in its widget tree)
// looked up again, when what decides it changes: the sizes chosen in the
// settings, a display's geometry (its scale), the display a window is on.
function followIn(widget: Gtk.Widget) {
    if (widget instanceof ZoomBox) widget.follow()
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) followIn(child)
}
const followAll = () => app.get_windows().forEach(followIn)

let chosen = JSON.stringify(conf.peek().interface_scale ?? {})
conf.subscribe(() => {
    const now = JSON.stringify(conf.peek().interface_scale ?? {})
    if (now === chosen) return
    chosen = now
    followAll()
})

const watchedMonitors = new WeakSet<Gdk.Monitor>()
function watchMonitors() {
    const monitors = Gdk.Display.get_default()?.get_monitors()
    if (!monitors) return
    for (let i = 0; i < monitors.get_n_items(); i++) {
        const monitor = monitors.get_item(i) as Gdk.Monitor
        if (watchedMonitors.has(monitor)) continue
        watchedMonitors.add(monitor)
        monitor.connect("notify::geometry", followAll)
    }
}
;(Gdk.Display.get_default()?.get_monitors() as any)?.connect("items-changed", () => {
    watchMonitors()
    followAll()
})
watchMonitors()

app.connect("window-added", (_app, window: Gtk.Window) => {
    if (window instanceof Astal.Window) window.connect("notify::gdkmonitor", () => followIn(window))
    window.connect("realize", () => followIn(window))
})

/**
 * Its child at kiwi's size for the display it's on: the one widget a window
 * (or a popover) holds, everything of kiwi's drawn inside it.
 */
export function Zoomed({ children }: { children?: JSX.Element | JSX.Element[] }) {
    const box = new ZoomBox()
    const child = Array.isArray(children) ? children[0] : children
    if (child) box.append(child as Gtk.Widget)
    return box
}

/** The zoom of the display a widget is on now (its window's). */
export function zoomOfWidget(widget: Gtk.Widget): number {
    const zoom = widget.get_ancestor(ZoomBox.$gtype) as ZoomBox | null
    return zoom?.zoom ?? 1
}

// ─── Icons at the zoom's resolution ─────────────────────────────────────────────
// GTK rasterises an icon to a texture at the widget's integer scale factor and
// then the zoom transform stretches that bitmap: on a display kept at scale 1
// and zoomed (an external monitor at 1.25), every icon blurs, while text and
// borders — drawn through the transform, not from a bitmap — stay crisp. This
// is a Gtk.Image that, when the size it's drawn at asks for more pixels than
// the scale factor supplies, looks the icon up at a higher scale and draws that
// paintable instead, sharp under the transform. Symbolic icons are still
// recoloured from the CSS (GtkImage does that for any symbolic paintable). At
// scale 1 with no zoom — or wherever the scale factor already covers the zoom —
// it is a plain Gtk.Image on the icon-name path, untouched. A drop-in: it takes
// the same icon-name / gicon / pixel-size, so a site swaps the tag and nothing
// else.
export const ZoomImage = GObject.registerClass(
    { GTypeName: "KiwiZoomImage" },
    class ZoomImage extends Gtk.Image {
        private srcName: string | null = null
        private srcGicon: Gio.Icon | null = null
        // what apply() itself last left in icon-name and gicon: a notify raised
        // inside a handler of the same notify is held until that handler
        // returns, so apply()'s own change can come in after apply() is done.
        // The handlers know it by value; a flag set around the call misses it,
        // and each round would set the icon again, forever
        private ownName: string | null = null
        private ownGicon: Gio.Icon | null = null
        private appliedKey = ""
        private unsub: (() => void) | null = null

        constructor(params?: Partial<Gtk.Image.ConstructorProps>) {
            super(params)
            // an imperative `new ZoomImage({ iconName })` set it through super
            this.srcName = this.ownName = this.get_icon_name()
            this.srcGicon = this.ownGicon = this.get_gicon()

            this.connect("notify::icon-name", () => {
                const name = this.get_icon_name()
                if (name === this.ownName) return
                if (name) { this.srcName = name; this.srcGicon = null }
                else if (!this.srcGicon) this.srcName = null
                this.appliedKey = ""
                this.apply()
            })
            this.connect("notify::gicon", () => {
                const gicon = this.get_gicon()
                if (gicon === this.ownGicon) return
                if (gicon) { this.srcGicon = gicon; this.srcName = null }
                else if (!this.srcName) this.srcGicon = null
                this.appliedKey = ""
                this.apply()
            })
            this.connect("notify::pixel-size", () => { this.appliedKey = ""; this.apply() })
            this.connect("notify::scale-factor", () => { this.appliedKey = ""; this.apply() })
            this.connect("map", () => {
                if (!this.unsub) this.unsub = onZoomChange(() => this.apply())
                this.apply()
            })
            this.connect("unmap", () => { this.unsub?.(); this.unsub = null })
        }

        private apply() {
            const scale = this.get_scale_factor()
            const target = Math.ceil(scale * zoomOfWidget(this))
            // native: GTK's own rasterisation at the scale factor is enough
            if (target <= scale || (!this.srcName && !this.srcGicon)) {
                const key = `n:${this.srcName ?? ""}:${this.srcGicon ? "g" : ""}`
                if (key === this.appliedKey) return
                this.appliedKey = key
                this.ownName = this.srcName
                this.ownGicon = this.srcName ? null : this.srcGicon
                // a site's own set already shows it, unless a paintable took its place
                if (this.srcName) {
                    if (this.get_icon_name() !== this.srcName) this.set_from_icon_name(this.srcName)
                } else if (this.srcGicon && this.get_gicon() !== this.srcGicon) {
                    this.set_from_gicon(this.srcGicon)
                }
                return
            }
            const display = this.get_display()
            if (!display) return
            const size = this.get_pixel_size() > 0 ? this.get_pixel_size() : 16
            const key = `h:${target}:${size}:${this.srcName ?? this.srcGicon?.to_string() ?? ""}`
            if (key === this.appliedKey) return
            const theme = Gtk.IconTheme.get_for_display(display)
            const paintable = this.srcName
                ? theme.lookup_icon(this.srcName, null, size, target, this.get_direction(), 0)
                : theme.lookup_by_gicon(this.srcGicon!, size, target, this.get_direction(), 0)
            this.appliedKey = key
            this.ownName = null
            this.ownGicon = null
            this.set_from_paintable(paintable)
        }
    },
)
