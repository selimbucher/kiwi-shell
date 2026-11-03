import { Gtk, Gdk } from "ags/gtk4"
import { ZoomImage } from "../zoom"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { createComputed, createRoot, onCleanup, type Accessor } from "ags"

import { ContextMenu, type ContextMenuItem } from "../ContextMenu"
import { wantCalendar } from "../services/calendar"
import { wantBatteries } from "../services/batteries"
import {
    SIZE_NAMES, changeWidget, editingWidgets, kindOf, moveWidget, removeWidget, setEditingWidgets, sizeOf, widgetSpecs,
    type WidgetSpec,
} from "./model"
import { menuOf, sized } from "./util"
import { Month, UpNext } from "./Calendar"
import { Weather } from "./Weather"
import { Batteries } from "./Batteries"
import { WorldClock } from "./Clock"
import { Note } from "./Note"

// ─── A widget ─────────────────────────────────────────────────────────────────
// Its rounded pane at its size, what it shows inside, and a right-click menu:
// its sizes, what it adds of its own, Edit Widgets and Remove. While the
// widgets are edited, a remove button sits on its corner.

const CONTENT: Record<string, (props: { spec: Accessor<WidgetSpec> }) => JSX.Element> = {
    "up-next": UpNext,
    month: Month,
    weather: Weather,
    batteries: Batteries,
    "world-clock": WorldClock,
    note: Note,
}

// (built at the click, in a scope of its own that goes with it)
function popMenu(frame: Gtk.Widget, items: ContextMenuItem[], x: number, y: number) {
    createRoot(dispose => {
        const menu = ContextMenu({ items, class: "context-menu widget-menu" })
        menu.set_parent(frame)
        menu.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }))
        // (unparented once it has closed and run what was clicked)
        menu.connect("closed", () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            menu.unparent()
            dispose()
            return GLib.SOURCE_REMOVE
        }))
        menu.popup()
    })
}

// a widget that failed to build (a setting written by hand it can't read):
// its place kept, and why, rather than a column that stops there
function Broken({ name }: { name: string }) {
    return (
        <box class="widget-content widget-broken" orientation={Gtk.Orientation.VERTICAL} spacing={4}
            valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER} hexpand vexpand>
            <ZoomImage iconName="dialog-warning-symbolic" pixelSize={20} />
            <label label={`${name} can't be shown`} wrap justify={Gtk.Justification.CENTER} />
            <label class="widget-broken-hint" label="Check its entry in config.json." wrap
                justify={Gtk.Justification.CENTER} />
        </box>
    )
}

/** A widget at its size; `preview` for the gallery: shown, not used. */
export function WidgetFrame({ spec, preview = false }: { spec: Accessor<WidgetSpec>, preview?: boolean }) {
    const first = spec.peek()
    const kind = kindOf(first.kind)!
    const [width, height] = sizeOf(first.size)
    // (what it shows followed while it's there, if the list doesn't yet)
    onCleanup(wantFor(first.kind))
    let content: Gtk.Widget
    try {
        content = CONTENT[first.kind]({ spec }) as Gtk.Widget
    } catch (e) {
        console.error(`widget ${first.id}:`, e)
        content = Broken({ name: kind.name }) as Gtk.Widget
    }
    // (inside its 1px border)
    const frame = (
        <box class={`widget widget-${first.kind} ${first.size}`}
            overflow={Gtk.Overflow.HIDDEN} hexpand={false} vexpand={false} halign={Gtk.Align.START} valign={Gtk.Align.START}>
            {sized(content, width - 2, height - 2)}
        </box>
    ) as Gtk.Widget
    if (preview) {
        frame.canTarget = false
        return frame
    }

    const right = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY })
    right.connect("pressed", (_g, _n, x, y) => {
        const id = spec.peek().id
        const own = menuOf(content)
        popMenu(frame, [
            ...kind.sizes.map(size => ({
                label: SIZE_NAMES[size],
                icon: size === spec.peek().size ? "object-select-symbolic" : undefined,
                onClick: () => changeWidget(id, { size }),
            })),
            { separator: true },
            ...own,
            ...(own.length ? [{ separator: true }] : []),
            { label: "Edit Widgets…", icon: "document-edit-symbolic", onClick: () => setEditingWidgets(true) },
            { label: "Remove Widget", icon: "list-remove-symbolic", onClick: () => removeWidget(id) },
        ], x, y)
    })
    frame.add_controller(right)
    // where a widget dragged here lands: a bar on that side, over it all
    const bar = new Gtk.Box({ cssClasses: ["widget-drop-bar"], canTarget: false, visible: false })
    arrange(frame, content, spec, width, height, bar)

    return (
        <overlay class="widget-wrap" $={(self: Gtk.Overlay) => self.add_overlay(bar)}>
            {frame}
            <button $type="overlay" class={editingWidgets(e => e ? "widget-remove shown" : "widget-remove")}
                canTarget={editingWidgets} focusable={editingWidgets} halign={Gtk.Align.START} valign={Gtk.Align.START}
                tooltipText="Remove Widget" onClicked={() => removeWidget(spec.peek().id)}>
                <ZoomImage iconName="list-remove-symbolic" pixelSize={10} />
            </button>
        </overlay>
    ) as Gtk.Widget
}

// ─── Arranged by dragging ─────────────────────────────────────────────────────
// While the widgets are edited, one is dragged to another place: dropped on a
// widget's first half it goes before it, on its second half after it. What
// is inside a widget doesn't answer clicks meanwhile, so arranging never
// opens an event or the weather.

function arrange(frame: Gtk.Widget, content: Gtk.Widget, spec: Accessor<WidgetSpec>, width: number, height: number,
    bar: Gtk.Widget) {
    const follow = () => { content.canTarget = !editingWidgets.peek() }
    onCleanup(editingWidgets.subscribe(follow))
    follow()

    const drag = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE, propagationPhase: Gtk.PropagationPhase.CAPTURE })
    drag.connect("prepare", (source, x, y) => {
        if (!editingWidgets.peek()) return null
        // (held where it was picked up; set before the drag starts, the
        // spot is kept)
        source.set_icon(new Gtk.WidgetPaintable({ widget: frame }), Math.round(x), Math.round(y))
        return Gdk.ContentProvider.new_for_value(spec.peek().id)
    })
    drag.connect("drag-begin", () => frame.add_css_class("dragged"))
    drag.connect("drag-end", () => frame.remove_css_class("dragged"))
    frame.add_controller(drag)

    // Which side the dragged widget lands on. Not the pointer's half of this
    // widget — coming in over the far edge then marked the wrong side and you
    // had to drag all the way across and back. Instead their current order: a
    // widget from before this one drops after it, one from after drops before,
    // so hovering anywhere over it is enough and every spot is still reachable
    // by the widget you drop onto.
    const wide = spec.peek().size !== "small"
    const afterFor = (draggedId: string) => {
        const list = widgetSpecs.peek()
        const from = list.findIndex(s => s.id === draggedId)
        const to = list.findIndex(s => s.id === spec.peek().id)
        return from >= 0 && to >= 0 && from < to
    }
    const mark = (where: "" | "before" | "after") => {
        frame.remove_css_class("drop-target")
        bar.visible = !!where
        if (!where) return
        frame.add_css_class("drop-target")
        const edge = where === "before" ? Gtk.Align.START : Gtk.Align.END
        // across a wide one, down the side of a small one
        bar.set_css_classes(["widget-drop-bar", wide ? "across" : "down"])
        bar.halign = wide ? Gtk.Align.FILL : edge
        bar.valign = wide ? edge : Gtk.Align.FILL
    }
    // only a widget being arranged: text dragged out of a note is left alone
    // (a drop taken as a move would cut it from the note)
    const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
    drop.set_preload(true)
    drop.connect("accept", (_t, offer: Gdk.Drop) =>
        editingWidgets.peek() && offer.get_formats().contain_gtype(GObject.TYPE_STRING))
    drop.connect("motion", (target) => {
        const dragged = String(target.get_value() ?? "")
        // (nowhere to go on itself)
        if (dragged === spec.peek().id) {
            mark("")
            return 0
        }
        mark(afterFor(dragged) ? "after" : "before")
        return Gdk.DragAction.MOVE
    })
    drop.connect("leave", () => mark(""))
    drop.connect("drop", (_t, dropped: unknown) => {
        mark("")
        const value = String(dropped)
        const id = spec.peek().id
        if (value === id || !widgetSpecs.peek().some(s => s.id === value)) return false
        if (!afterFor(value)) moveWidget(value, id)
        else {
            const list = widgetSpecs.peek().filter(s => s.id !== value)
            moveWidget(value, list[list.findIndex(s => s.id === id) + 1]?.id ?? null)
        }
        return true
    })
    frame.add_controller(drop)
}

// ─── The data they show ───────────────────────────────────────────────────────
// Calendars and batteries are followed while a widget showing them is in
// the list, open or not: EDS and UPower say when something changes, so it
// costs nothing meanwhile, and Notification Center opens on what's current
// rather than on an empty widget filling in. Started a moment after the
// shell, not in its way.

const needs = createComputed(get => {
    const kinds = new Set(get(widgetSpecs).map(s => s.kind))
    return { calendar: kinds.has("up-next") || kinds.has("month"), batteries: kinds.has("batteries") }
})

let releaseCalendar: (() => void) | null = null
let releaseBatteries: (() => void) | null = null
const follow = () => {
    const { calendar, batteries } = needs.peek()
    if (calendar && !releaseCalendar) releaseCalendar = wantCalendar()
    if (!calendar && releaseCalendar) { releaseCalendar(); releaseCalendar = null }
    if (batteries && !releaseBatteries) releaseBatteries = wantBatteries()
    if (!batteries && releaseBatteries) { releaseBatteries(); releaseBatteries = null }
}
GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 4, () => {
    needs.subscribe(follow)
    follow()
    return GLib.SOURCE_REMOVE
})

function wantFor(kind: string): () => void {
    if (kind === "up-next" || kind === "month") return wantCalendar()
    if (kind === "batteries") return wantBatteries()
    return () => {}
}
