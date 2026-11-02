import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import { createState, onCleanup, type Accessor } from "ags"
import type { ContextMenuItem } from "../ContextMenu"
import { minuteNow } from "../services/minuteClock"
import { centerOpen } from "../Notifications/store"

// ─── The minute, while they're seen ───────────────────────────────────────────
// The time the widgets show by: the shell's minute while Notification Center
// is open, and caught up as it opens. Kept between openings, they'd be built
// again every minute for nobody.

const [shownMinute, setShownMinute] = createState(minuteNow.peek())
export { shownMinute }
minuteNow.subscribe(() => { if (centerOpen.peek()) setShownMinute(minuteNow.peek()) })

let openedAt = 0
centerOpen.subscribe(() => {
    if (!centerOpen.peek()) return
    openedAt = Date.now()
    const now = minuteNow.peek()
    if (now.to_unix() !== shownMinute.peek().to_unix()) setShownMinute(now)
})

/** Notification Center opened a moment ago: what comes into view does so now. */
export const justOpened = () => centerOpen.peek() && Date.now() - openedAt < 500

/** `source` as a widget shows it: as it changes while Notification Center is open, caught up as it opens. */
export function whileOpen<T>(source: Accessor<T>): Accessor<T> {
    const [value, set] = createState(source.peek())
    const unsubscribe = [
        source.subscribe(() => { if (centerOpen.peek()) set(source.peek()) }),
        centerOpen.subscribe(() => { if (centerOpen.peek() && value.peek() !== source.peek()) set(source.peek()) }),
    ]
    onCleanup(() => unsubscribe.forEach(u => u()))
    return value
}

// ─── A size that holds ────────────────────────────────────────────────────────
// A widget is its size whatever is inside: GTK grows a box to what its
// content needs (a text field, a long name), and one widget wider than its
// column pushed the whole column out. This one asks for its size alone and
// lets its content have what it needs, cut at its edges.

const SizedLayout = GObject.registerClass(
    { GTypeName: "KiwiWidgetSizeLayout" },
    class SizedLayout extends Gtk.LayoutManager {
        vfunc_get_request_mode(): Gtk.SizeRequestMode {
            return Gtk.SizeRequestMode.CONSTANT_SIZE
        }

        vfunc_measure(widget: Gtk.Widget, orientation: Gtk.Orientation): [number, number, number, number] {
            const box = widget as Sized
            const size = orientation === Gtk.Orientation.HORIZONTAL ? box.fixedWidth : box.fixedHeight
            return [size, size, -1, -1]
        }

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number) {
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
                if (!child.should_layout()) continue
                const [minWidth] = child.measure(Gtk.Orientation.HORIZONTAL, -1)
                const w = Math.max(width, minWidth)
                const [minHeight] = child.measure(Gtk.Orientation.VERTICAL, w)
                child.allocate(w, Math.max(height, minHeight), -1, null)
            }
        }
    },
)

const Sized = GObject.registerClass(
    { GTypeName: "KiwiWidgetSize" },
    class Sized extends Gtk.Box {
        fixedWidth = 0
        fixedHeight = 0

        constructor(width: number, height: number) {
            super({ overflow: Gtk.Overflow.HIDDEN })
            this.fixedWidth = width
            this.fixedHeight = height
            this.set_layout_manager(new SizedLayout())
        }
    },
)
type Sized = InstanceType<typeof Sized>

/** `child` in exactly `width` by `height`, whatever it asks for. */
export function sized(child: Gtk.Widget, width: number, height: number): Gtk.Widget {
    const box = new Sized(width, height)
    box.append(child)
    return box
}

/**
 * A click on the widget where nothing inside takes it (an event, a day):
 * what the widget opens.
 */
export function onClick(widget: Gtk.Widget, action: () => void) {
    const click = new Gtk.GestureClick({ button: 1 })
    click.connect("released", (_g, n, x, y) => {
        if (n !== 1 || !widget.contains(x, y)) return
        action()
    })
    widget.add_controller(click)
    widget.set_cursor_from_name("pointer")
}

// ─── Their own menu items ─────────────────────────────────────────────────────

const menus = new WeakMap<Gtk.Widget, () => ContextMenuItem[]>()

/** What a widget adds to its right-click menu (a place to pick). */
export function setMenu(widget: Gtk.Widget, items: () => ContextMenuItem[]) {
    menus.set(widget, items)
}

export const menuOf = (widget: Gtk.Widget): ContextMenuItem[] => menus.get(widget)?.() ?? []
