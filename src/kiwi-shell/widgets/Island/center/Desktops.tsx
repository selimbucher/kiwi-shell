import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"

import { desktopsOn, goToDesktop, watchDesktops } from "../../MissionControl/desktops"
import { toggleMissionControl } from "../../MissionControl/MissionControl"

const hyprland = Hyprland.get_default()

// ─── The desktops ─────────────────────────────────────────────────────────────
// The display's own row of desktops, as Mission Control has them: one mark
// each, in the row's order, so the third mark is Desktop 3 there whatever its
// workspace's number. The current one is the accent's, one with windows is
// filled, one asking for attention is red. Click one to go there; the
// current one opens Mission Control. macOS shows no such row: a Mac's
// desktops are only seen in Mission Control.

// what changes a mark
const EVENTS = new Set([
    "workspacev2", "focusedmonv2", "createworkspacev2", "destroyworkspacev2", "moveworkspacev2",
    "renameworkspace", "openwindow", "closewindow", "movewindowv2", "urgent", "monitoraddedv2",
])

type Mark = { id: number; current: boolean; filled: boolean; urgent: boolean }

function marksOn(monitor: string): Mark[] {
    const current = hyprland.get_monitor_by_name(monitor)?.get_active_workspace()?.get_id() ?? -1
    return desktopsOn(monitor).map(id => {
        const clients = hyprland.get_workspace(id)?.get_clients() ?? []
        return { id, current: id === current, filled: clients.length > 0, urgent: clients.some(c => c.urgent) }
    })
}

export default function Desktops({ monitor }: { monitor: string }) {
    const row = new Gtk.Box({ cssClasses: ["island-desktops"], valign: Gtk.Align.CENTER })
    let buttons: Gtk.Button[] = []
    let ids: number[] = []

    const build = (marks: Mark[]) => {
        buttons.forEach(b => row.remove(b))
        ids = marks.map(m => m.id)
        buttons = marks.map(() => {
            const button = new Gtk.Button({ cssClasses: ["desktop"], valign: Gtk.Align.CENTER })
            button.set_child(new Gtk.Box({ cssClasses: ["tile"], valign: Gtk.Align.CENTER }))
            // the id at the time of the click: a reordered row keeps its buttons
            button.connect("clicked", () => {
                const index = buttons.indexOf(button)
                const id = ids[index]
                if (id === undefined) return
                if (marksOn(monitor)[index]?.current) toggleMissionControl()
                else void goToDesktop(id)
            })
            row.append(button)
            return button
        })
    }

    const update = () => {
        const marks = marksOn(monitor)
        if (marks.length !== buttons.length) build(marks)
        ids = marks.map(m => m.id)
        marks.forEach((mark, i) => {
            const b = buttons[i]
            for (const name of ["current", "filled", "urgent"] as const) {
                if (mark[name]) b.add_css_class(name)
                else b.remove_css_class(name)
            }
            b.set_tooltip_text(`Desktop ${i + 1}`)
        })
    }

    // events come in bursts (a window moved is several), and Astal's own
    // objects follow them first: one update once they're through
    let pending = 0
    const soon = () => {
        if (pending) return
        pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0
            update()
            return GLib.SOURCE_REMOVE
        })
    }

    const id = hyprland.connect("event", (_h: unknown, event: string) => {
        if (EVENTS.has(event)) soon()
    })
    const unwatch = watchDesktops(soon)
    onCleanup(() => {
        hyprland.disconnect(id)
        unwatch()
        if (pending) GLib.source_remove(pending)
    })
    update()

    return row
}
