import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createComputed, createMemo, createRoot, createState, onCleanup, type Accessor } from "ags"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Cairo from "gi://cairo"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"

import { logger } from "../../log"
import { conf } from "../config"
import { destroyWindow, remeasureOn } from "../monitors"
import { themeClasses, LAYER } from "../services/theme"
import {
    alert, arrangement, activityById, collapse, expand, opened, cardOn, setCardOn, covered, setCovered, islandRects, islandBodies, PRIVACY_ID,
    type Rect,
} from "./model"
import { IslandShape, IslandBody, Fader, Bubble, CardMorph, whenDone } from "./shape"
import { PrivacyDots, PrivacyCard, anyPrivacy } from "./sources/privacy"
import Desktops from "./center/Desktops"
import DateCenter from "./center/DateCenter"
import WeatherCenter from "./center/WeatherCenter"
import "./sources/media"
import "./sources/performance"
import "./sources/alerts"

const log = logger("island")
const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

// ─── The island in the bar ────────────────────────────────────────────────────
// One per display, in the middle of the bar (model.ts has what shows when).
// Its window spans the bar's width so that the island can grow and gain
// bubbles without the window being resized under it; only the island and its
// bubbles take the pointer, the rest lets it through to whatever is below.

export type Center = "desktops" | "date" | "weather" | "none"

// how long the island stays grown once the pointer has left what grew it: a
// pointer slipping off its edge for a moment doesn't shut it
const UNPOINT_AFTER_MS = 300

const windowCss = conf.as(c => `--primary: ${c.primary_color}; --bar-margin: ${c.bar_margin}px;`)

// A CenterBox that says when it has been laid out again. GTK leaves a
// widget's own size_allocate out when it has a layout manager, so it's the
// layout manager that tells (as services/previews.ts's PaneLayout does).
const RowLayout = GObject.registerClass(
    { GTypeName: "KiwiIslandRowLayout" },
    class RowLayout extends Gtk.CenterLayout {
        onLayout: (() => void) | null = null
        // how far right of the middle the centre goes (IslandShape.shift)
        shift: () => number = () => 0

        // CenterLayout's, but with the centre where the island says: the
        // sides take what's left either side of it
        vfunc_allocate(_widget: Gtk.Widget, width: number, height: number, baseline: number): void {
            const center = this.get_center_widget()
            const [, cw] = center?.get_visible() ? center.measure(Gtk.Orientation.HORIZONTAL, height) : [0, 0]
            // not rounded: see IslandShape's allocation
            const x = Math.max(0, Math.min(width - cw, (width - cw) / 2 + this.shift()))
            const place = (child: Gtk.Widget | null, from: number, w: number) => {
                if (!child?.get_visible()) return
                child.measure(Gtk.Orientation.HORIZONTAL, height)
                child.allocate(Math.max(0, Math.floor(w)), height, baseline, new Gsk.Transform().translate(new Graphene.Point().init(from, 0)))
            }
            place(this.get_start_widget(), 0, x)
            place(center, x, cw)
            place(this.get_end_widget(), x + cw, width - x - cw)
            this.onLayout?.()
        }
    },
)

const Row = GObject.registerClass(
    { GTypeName: "KiwiIslandRow" },
    class Row extends Gtk.CenterBox {
        onLayout: (() => void) | null = null
        shift: () => number = () => 0

        _init(props?: Partial<Gtk.CenterBox.ConstructorProps>) {
            // @ts-expect-error GJS constructs GObject classes through _init
            super._init(props)
            const layout = new RowLayout()
            layout.onLayout = () => this.onLayout?.()
            layout.shift = () => this.shift()
            this.set_layout_manager(layout)
        }
    },
)

function centerView(center: Center, monitor: string): Gtk.Widget | null {
    switch (center) {
        case "desktops": return Desktops({ monitor })
        case "date": return DateCenter() as Gtk.Widget
        case "weather": return WeatherCenter() as Gtk.Widget
        default: return null
    }
}

/** A widget built in a reactive scope of its own, ended when it's let go. */
function scoped(build: () => Gtk.Widget | null): Gtk.Widget | null {
    return createRoot(dispose => {
        const widget = build()
        if (!widget) {
            dispose()
            return null
        }
        return whenDone(widget, dispose)
    })
}

function boundsIn(widget: Gtk.Widget, win: Gtk.Widget | null): Rect | undefined {
    if (!win) return undefined
    const [ok, b] = widget.compute_bounds(win)
    return ok ? { x: b.get_x(), y: b.get_y(), width: b.get_width(), height: b.get_height() } : undefined
}

export default function Island({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const monitor = gdkmonitor.get_connector() ?? ""
    const center = createMemo(() => (conf().island?.center ?? "desktops") as Center)

    // ids only: an activity's views are built again when another takes its
    // place, not on every change inside it
    const compactId = createMemo(() => arrangement().compact?.id ?? "")
    const bubbleId = (i: number) => createMemo(() => arrangement().bubbles[i]?.id ?? "")
    const alertShown = createMemo(() => alert() !== null)
    // what the sides show: an alert while there is one, else the compact
    // activity
    const sideKey = createMemo(() => {
        const a = alert()
        return a ? `alert:${a.seq}` : compactId() ? `activity:${compactId()}` : ""
    })
    // Its trailing side pointed at, an activity that has more to show grows
    // into it there at once (Now Playing's bars become its controls), and
    // back a little after the pointer leaves.
    const [pointed, setPointed] = createState(false)
    const trailingKey = createMemo(() => {
        const key = sideKey()
        const id = compactId()
        const more = key.startsWith("activity:") && pointed() && !!(id && activityById(id)?.pointed)
        return more ? `${key}:pointed` : key
    })
    // the card grown out of this island covers it
    const underCard = createMemo(() => covered()?.monitor === monitor && covered()?.origin === "island")

    const shown = createComputed(get =>
        get(center) !== "none" || get(compactId) !== "" || get(alertShown) || get(anyPrivacy))

    let win: Gtk.Window | null = null
    const subscriptions: (() => void)[] = []
    const follow = (accessor: Accessor<unknown>, run: () => void) => {
        subscriptions.push(accessor.subscribe(run))
        run()
    }

    // ─── What the island holds ────────────────────────────────────────────

    const shape = new IslandShape({ cssClasses: ["island"], overflow: Gtk.Overflow.HIDDEN, valign: Gtk.Align.CENTER })

    const side = (edge: "leading" | "trailing") => {
        const fader = new Fader({ cssClasses: ["island-side", edge], valign: Gtk.Align.CENTER })
        fader.edge = edge === "leading" ? "start" : "end"
        const keyOf = edge === "leading" ? sideKey : trailingKey
        let last = ""
        follow(keyOf, () => {
            const key = keyOf()
            // the pointed-at view coming or going changes the trailing side
            // only: the rest stays where it is
            const base = (k: string) => k.replace(/:pointed$/, "")
            shape.anchor = edge === "trailing" && last && base(last) === base(key) ? 0 : 0.5
            last = key
            const a = alert()
            if (key.startsWith("alert:") && a) {
                const view = edge === "leading" ? a.leading : a.trailing
                return fader.show(view ? scoped(() => <box class="island-part">{view()}</box> as Gtk.Widget) : null)
            }
            const id = compactId()
            const activity = id ? activityById(id) : null
            if (key.endsWith(":pointed") && activity?.pointed) {
                const more = activity.pointed
                return fader.show(scoped(() => <box class={`island-part ${edge} pointed`}>{more()}</box> as Gtk.Widget))
            }
            const view = activity && (edge === "leading" ? activity.leading : activity.trailing)
            fader.show(view ? scoped(() => (
                <button class={`island-part ${edge}`} valign={Gtk.Align.CENTER}
                    onClicked={() => expand(id, monitor)}>
                    {view()}
                </button>
            ) as Gtk.Widget) : null)
        })
        return fader
    }

    const middle = new Fader({ cssClasses: ["island-center"], valign: Gtk.Align.CENTER })
    follow(center, () => {
        shape.anchor = 0.5
        middle.show(scoped(() => centerView(center(), monitor)))
    })

    const leading = side("leading")
    const trailing = side("trailing")
    const body = new IslandBody({ cssClasses: ["island-body"] })
    body.hold(leading, middle, trailing, (
        <button class="island-part privacy" visible={anyPrivacy} valign={Gtk.Align.CENTER}
            onClicked={() => expand(PRIVACY_ID, monitor)}>
            <PrivacyDots />
        </button>
    ) as Gtk.Widget)

    shape.child = body
    // With a card open from it, the island stays as it was, pointed at or
    // not: the card grew out of it and shrinks back into it. The pointer is
    // over the card meanwhile, which to the island is the pointer leaving.
    // Once the card has gone, it goes by where the pointer is.
    const carded = createMemo(() => opened()?.monitor === monitor || covered()?.monitor === monitor)
    let pointTimer = 0
    const pointAfter = (on: boolean, ms: number) => {
        if (pointTimer) GLib.source_remove(pointTimer)
        pointTimer = 0
        if (carded()) return
        if (ms === 0) return setPointed(on)
        pointTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            pointTimer = 0
            setPointed(on)
            return GLib.SOURCE_REMOVE
        })
    }
    const pointer = new Gtk.EventControllerMotion()
    pointer.connect("enter", () => pointAfter(true, 0))
    pointer.connect("leave", () => pointAfter(false, UNPOINT_AFTER_MS))
    trailing.add_controller(pointer)
    subscriptions.push(carded.subscribe(() => {
        if (carded()) return
        const on = pointer.contains_pointer
        if (on !== pointed()) pointAfter(on, on ? 0 : UNPOINT_AFTER_MS)
    }))
    subscriptions.push(() => { if (pointTimer) GLib.source_remove(pointTimer) })
    shape.shownNow = shown()
    subscriptions.push(shown.subscribe(() => shape.reveal(shown())))
    islandBodies.set(monitor, body)
    subscriptions.push(() => { if (islandBodies.get(monitor) === body) islandBodies.delete(monitor) })

    // ─── The bubbles beside it ────────────────────────────────────────────

    const bubble = (i: number, edge: "start" | "end") => {
        // the side's whole width, so that it sits against the island
        const b = new Bubble({ hexpand: true, valign: Gtk.Align.CENTER, halign: edge === "start" ? Gtk.Align.END : Gtk.Align.START })
        b.side = edge
        const id = bubbleId(i)
        follow(id, () => {
            const activity = activityById(id())
            b.show(activity ? scoped(() => (
                <button class="island-bubble" valign={Gtk.Align.CENTER}
                    opacity={covered(c => c?.monitor === monitor && c.origin === "bubble" && c.id === activity.id ? 0.001 : 1)}
                    onClicked={self => expand(activity.id, monitor, { rect: boundsIn(self, win), widget: self })}>
                    {activity.minimal()}
                </button>
            ) as Gtk.Widget) : null)
        })
        return b
    }

    let row: InstanceType<typeof Row> | null = null
    let lastRegion = ""

    // What takes the pointer: the island and its bubbles, nothing else. Set
    // while the row is laid out: a surface takes a new region with the frame
    // it draws next, and one set after that frame would wait for the one
    // after, a change behind.
    const updateRegion = () => {
        const surface = win?.get_surface()
        if (!win || !surface || !row) return
        const rects: number[][] = []
        const add = (widget: Gtk.Widget) => {
            // mapped: shown, and so is everything it's in
            if (!widget.get_mapped()) return null
            const [ok, b] = widget.compute_bounds(win!)
            if (!ok || b.get_width() <= 0) return null
            const rect = [Math.floor(b.get_x()), Math.floor(b.get_y()), Math.ceil(b.get_width()), Math.ceil(b.get_height())]
            rects.push(rect)
            return rect
        }
        const island = add(shape)
        if (island) islandRects.set(monitor, { x: island[0], y: island[1], width: island[2], height: island[3] })
        for (const box of [row.get_start_widget(), row.get_end_widget()]) {
            for (let child = box?.get_first_child() ?? null; child; child = child.get_next_sibling()) add(child)
        }
        const signature = rects.join(";")
        if (signature === lastRegion) return
        lastRegion = signature
        log.debug(`${monitor}: the pointer's region ${signature || "none"}`)
        const region = new Cairo.Region()
        for (const [x, y, width, height] of rects) {
            const rect = new Cairo.RectangleInt()
            rect.x = x
            rect.y = y
            rect.width = width
            rect.height = height
            region.unionRectangle(rect)
        }
        surface.set_input_region(region)
    }

    return (
        <window
            namespace={LAYER.panel}
            css={windowCss}
            visible
            name="kiwi-island"
            class={themeClasses(t => `Bar IslandBar ${t}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={TOP | LEFT | RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                win = self
                onCleanup(() => {
                    subscriptions.forEach(unsubscribe => unsubscribe())
                    destroyWindow(self)
                })
                remeasureOn(self, () => `${conf().bar_margin}`, () => gdkmonitor.get_geometry().width)
            }}
        >
            <overlay>
            <Row class="island-row" $={(self: InstanceType<typeof Row>) => {
                row = self
                self.onLayout = updateRegion
                self.shift = () => shape.shift
            }}>
                <box $type="start" hexpand valign={Gtk.Align.CENTER}>{bubble(1, "start")}</box>
                {/* under the card, all but invisible rather than not there:
                    GTK draws nothing at opacity 0, and the card shows what
                    the island holds, live, as it shrinks back into it */}
                <box $type="center" valign={Gtk.Align.CENTER} opacity={underCard(under => under ? 0.001 : 1)}>
                    {shape}
                </box>
                <box $type="end" hexpand valign={Gtk.Align.CENTER}>{bubble(0, "end")}</box>
            </Row>
            {/* GTK draws a window whose snapshot is empty not at all, and
                the compositor keeps its last frame: with nothing in the
                middle, the island stayed up after the music stopped. One
                practically invisible pixel keeps every frame drawn (the
                notification center has one too). */}
            <box $type="overlay" class="island-keepalive" canTarget={false}
                halign={Gtk.Align.START} valign={Gtk.Align.START} widthRequest={1} heightRequest={1} />
            </overlay>
        </window>
    )
}

// ─── The open card ────────────────────────────────────────────────────────────
// What a click on an activity opens: iOS's expanded presentation, the island
// itself grown into a card (shape.ts, CardMorph), on the display it was
// clicked on. A click anywhere else, or Escape, shrinks it back. The card is
// in the OVERLAY layer, above a clear window over the whole display (TOP)
// that catches the click outside, as the notification center does.

export function IslandCard() {
    const monitorOf = (name: string | null) =>
        app.get_monitors().find(m => m.get_connector() === name) ?? app.get_monitors()[0]
    const isOpen = createMemo(() => opened() !== null)
    // the display it's on stays while it closes
    let lastWhere: string | null = null
    const where = createMemo(() => (lastWhere = opened()?.monitor ?? cardOn() ?? lastWhere))

    const morph = new CardMorph({ hexpand: true })
    let showing = ""
    let origin: { origin: "island" | "bubble"; id: string } = { origin: "island", id: "" }
    morph.onCovering = on => {
        const monitor = cardOn()
        setCovered(on && monitor ? { monitor, ...origin } : null)
    }
    morph.onClosed = () => {
        setCovered(null)
        setCardOn(null)
        morph.clear()
        showing = ""
    }

    const content = (id: string): Gtk.Widget | null => scoped(() => {
        if (id === PRIVACY_ID) return <PrivacyCard /> as Gtk.Widget
        const view = activityById(id)?.expanded
        // in a box of its own: a view may be a With itself
        return view ? <box>{view()}</box> as Gtk.Widget : null
    })

    const follow = () => {
        const open = opened()
        if (!open) {
            if (cardOn()) morph.close()
            return
        }
        const widget = open.id === showing && cardOn() ? null : content(open.id)
        if (!widget && open.id !== showing) return collapse()
        if (widget) showing = open.id
        origin = { origin: open.origin, id: open.id }
        setCardOn(open.monitor)
        morph.open(open.from, widget, open.what)
    }
    opened.subscribe(follow)

    const closeSoon = () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        collapse()
        return GLib.SOURCE_REMOVE
    })

    return [
        <window
            namespace={LAYER.plain}
            name="kiwi-island-backdrop"
            class="island-backdrop"
            visible={isOpen}
            gdkmonitor={where(monitorOf)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={TOP | LEFT | RIGHT | BOTTOM}
            keymode={Astal.Keymode.ON_DEMAND}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.set_button(0)
                // on release, a moment later: hiding a window in the middle
                // of its own press upsets GTK
                click.connect("released", closeSoon)
                self.add_controller(click)
                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_c, keyval) => {
                    if (keyval !== Gdk.KEY_Escape) return false
                    collapse()
                    return true
                })
                self.add_controller(key)
                onCleanup(() => destroyWindow(self))
            }}
        >
            <box />
        </window>,
        <window
            namespace={LAYER.island}
            css={windowCss}
            name="kiwi-island-card"
            class={themeClasses(t => `Bar IslandCardWindow ${t}`)}
            visible={cardOn(on => on !== null)}
            gdkmonitor={where(monitorOf)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={TOP | LEFT | RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            $={(self) => {
                onCleanup(() => destroyWindow(self))
                // The pointer only where the card is: the rest of the window
                // is the backdrop's, whose click closes it. Set as it's laid
                // out, so it goes with the frame that draws it there.
                let last = ""
                morph.onLayout = shape => {
                    const surface = self.get_surface()
                    const [ok, origin] = morph.compute_point(self, new Graphene.Point().init(0, 0))
                    if (!surface || !ok) return
                    const rect = new Cairo.RectangleInt()
                    rect.x = Math.floor(origin.x + shape.x)
                    rect.y = Math.floor(origin.y + shape.y)
                    rect.width = Math.ceil(shape.width)
                    rect.height = Math.ceil(shape.height)
                    const signature = `${rect.x},${rect.y},${rect.width},${rect.height}`
                    if (signature === last) return
                    last = signature
                    const region = new Cairo.Region()
                    region.unionRectangle(rect)
                    surface.set_input_region(region)
                }
                // The display's width, as the bar's island window has: the
                // card grows out of the island wherever that is, and a
                // layer surface asking for its content's width is given just
                // that, at the display's edge. The height is the card's
                // own: a shorter card after a taller one would keep the
                // taller's window.
                const size = () => self.set_default_size(monitorOf(where())?.get_geometry().width ?? -1, -1)
                size()
                cardOn.subscribe(size)
            }}
        >
            {morph}
        </window>,
    ]
}
