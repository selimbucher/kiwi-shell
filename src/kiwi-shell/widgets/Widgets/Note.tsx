import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { onCleanup, type Accessor } from "ags"

import { logger } from "../../log"
import { SIZES, SIZE_NAMES, changeWidget, removeWidget, setEditingWidgets, whenRemoved, type WidgetSize, type WidgetSpec } from "./model"

const log = logger("widgets")

// ─── Note ─────────────────────────────────────────────────────────────────────
// A note to write in, right there: a phone number, a thought, what to buy.
// Its first line is its title. Kept as it's typed (a moment after the last
// key) in the state directory, one text per note widget; a widget removed
// takes its note with it.

const FILE = `${GLib.get_user_state_dir()}/kiwi-shell/notes.json`

let notes: Record<string, string> = (() => {
    try {
        const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(FILE)[1]))
        return saved && typeof saved === "object" ? saved : {}
    } catch {
        return {}
    }
})()

let saving = 0
function save() {
    if (saving) GLib.source_remove(saving)
    saving = GLib.timeout_add(GLib.PRIORITY_LOW, 600, () => {
        saving = 0
        notes = Object.fromEntries(Object.entries(notes).filter(([, text]) => text))
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(FILE), 0o755)
            GLib.file_set_contents(FILE, JSON.stringify(notes))
        } catch (e) {
            log.warn("couldn't keep the notes:", e as Error)
        }
        return GLib.SOURCE_REMOVE
    })
}
// (only a widget removed from the list: not one missing because the
// settings didn't read)
whenRemoved(id => {
    if (!(id in notes)) return
    delete notes[id]
    save()
})

// A right click in the text opens the text's menu, so the widget's own
// (its sizes, Edit Widgets, Remove) comes after Cut, Copy and Paste there.
function textMenu(view: Gtk.TextView, spec: Accessor<WidgetSpec>) {
    const actions = new Gio.SimpleActionGroup()
    const size = new Gio.SimpleAction({ name: "size", parameterType: new GLib.VariantType("s") })
    size.connect("activate", (_a, value) => changeWidget(spec.peek().id, { size: value!.unpack() as WidgetSize }))
    const edit = new Gio.SimpleAction({ name: "edit" })
    edit.connect("activate", () => setEditingWidgets(true))
    const remove = new Gio.SimpleAction({ name: "remove" })
    remove.connect("activate", () => removeWidget(spec.peek().id))
    for (const action of [size, edit, remove]) actions.add_action(action)
    view.insert_action_group("note", actions)
    const sizes = new Gio.Menu()
    for (const s of SIZES) sizes.append(SIZE_NAMES[s], `note.size::${s}`)
    const widget = new Gio.Menu()
    widget.append("Edit Widgets…", "note.edit")
    widget.append("Remove Widget", "note.remove")
    const menu = new Gio.Menu()
    menu.append_section(null, sizes)
    menu.append_section(null, widget)
    view.set_extra_menu(menu)
}

export function Note({ spec }: { spec: Accessor<WidgetSpec> }) {
    const id = spec.peek().id
    const view = new Gtk.TextView({
        cssClasses: ["note-text"], wrapMode: Gtk.WrapMode.WORD_CHAR, hexpand: true, vexpand: true,
        acceptsTab: false, topMargin: 0, bottomMargin: 0,
    })
    const buffer = view.get_buffer()
    // the title in the Notes app's yellow
    const title = new Gtk.TextTag({ name: "title", weight: 700, scale: 1.15, foreground: "#ffd60a" })
    buffer.get_tag_table().add(title)
    // (a preview in the gallery writes nothing)
    const preview = id.startsWith("preview-")
    buffer.set_text(preview ? "Groceries\nOat milk, coffee, apples" : notes[id] ?? "", -1)
    const style = () => {
        const [start, end] = buffer.get_bounds()
        buffer.remove_tag(title, start, end)
        const lineEnd = buffer.get_start_iter()
        lineEnd.forward_to_line_end()
        buffer.apply_tag(title, buffer.get_start_iter(), lineEnd)
    }
    style()
    const placeholder = new Gtk.Label({ label: "Write something…", cssClasses: ["note-placeholder"],
        xalign: 0, yalign: 0, halign: Gtk.Align.START, valign: Gtk.Align.START, canTarget: false })
    placeholder.visible = buffer.get_char_count() === 0
    const changed = buffer.connect("changed", () => {
        style()
        placeholder.visible = buffer.get_char_count() === 0
        if (preview) return
        notes[id] = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false)
        save()
    })
    onCleanup(() => buffer.disconnect(changed))
    if (preview) view.editable = false
    else textMenu(view, spec)
    const scroll = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: view })
    return (
        <box class="widget-content note" hexpand vexpand>
            <overlay hexpand vexpand>
                {scroll}
                <box $type="overlay" canTarget={false}>{placeholder}</box>
            </overlay>
        </box>
    )
}
