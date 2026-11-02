import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { createMemo, createRoot, createState, type Accessor } from "ags"

import { COLUMN_GAP, editingWidgets, linesOf, setEditingWidgets, shownWidgets, type Line, type WidgetSpec } from "./model"
import { WidgetFrame } from "./Frame"
import { centerOpen } from "../Notifications/store"

// ─── In Notification Center ───────────────────────────────────────────────────

// (the list is read again at every change to the settings, and a picker
// open in a widget was built again with each new copy of the same spec)
const sameSpec = (a: WidgetSpec, b: WidgetSpec) => JSON.stringify(a) === JSON.stringify(b)

/** A row of the column: one widget, or two small ones side by side. */
export function WidgetLine({ row }: { row: Accessor<{ specs: WidgetSpec[] }> }) {
    return (
        <box class="widget-line" spacing={COLUMN_GAP}>
            {row.peek().specs.map(first => (
                <WidgetFrame spec={createMemo(() => row().specs.find(s => s.id === first.id) ?? first, { equals: sameSpec })} />
            ))}
        </box>
    ) as Gtk.Widget
}

/** Under the widgets: Edit Widgets, or Done while they're edited. */
export function EditWidgets() {
    return (
        <box class="widget-edit-row" halign={Gtk.Align.CENTER}>
            <button class="nc-pill widget-edit" onClicked={() => setEditingWidgets(!editingWidgets.peek())}>
                <label label={editingWidgets(e => e ? "Done" : "Edit Widgets")} />
            </button>
        </box>
    ) as Gtk.Widget
}

// ─── Kept between openings ────────────────────────────────────────────────────
// Notification Center builds its rows as it opens and lets them go as it
// closes; widgets built at every opening made it open in twice the time.
// So a line of widgets is kept once it has left, and taken again at the next
// opening, until the widgets change. The first are built a while after the
// shell starts, out of the first opening's way.

type Kept = { key: string, widget: Gtk.Widget, set: (line: Line) => void, dispose: () => void }

const kept = new Map<string, Kept>()
const built = new WeakMap<Gtk.Widget, Kept>()

function build(line: Line): Kept {
    return createRoot(dispose => {
        const [state, set] = createState(line)
        const widget = WidgetLine({ row: state })
        const entry = { key: line.key, widget, set, dispose }
        built.set(widget, entry)
        return entry
    })
}

/** A line's row: the one kept for it, or a new one. */
export function takeLine(line: Line): Gtk.Widget {
    const entry = kept.get(line.key)
    if (entry && !entry.widget.get_parent()) {
        kept.delete(line.key)
        entry.set(line)
        return entry.widget
    }
    return build(line).widget
}

export function updateLine(widget: Gtk.Widget, line: Line) {
    built.get(widget)?.set(line)
}

/** A line's row has left the column: kept while its widgets are still there. */
export function leaveLine(widget: Gtk.Widget) {
    const entry = built.get(widget)
    if (!entry) return
    const current = linesOf(shownWidgets.peek()).some(l => l.key === entry.key)
    if (!current) return entry.dispose()
    // (the one just shown over an older one: a note's text is in it)
    const older = kept.get(entry.key)
    if (older && older !== entry) older.dispose()
    kept.set(entry.key, entry)
}

shownWidgets.subscribe(() => {
    const keys = new Set(linesOf(shownWidgets.peek()).map(l => l.key))
    for (const [key, entry] of kept) {
        if (keys.has(key)) continue
        kept.delete(key)
        entry.dispose()
    }
})

GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 6, () => {
    // (open by now: it built its own)
    if (centerOpen.peek()) return GLib.SOURCE_REMOVE
    for (const line of linesOf(shownWidgets.peek())) if (!kept.has(line.key)) kept.set(line.key, build(line))
    return GLib.SOURCE_REMOVE
})
