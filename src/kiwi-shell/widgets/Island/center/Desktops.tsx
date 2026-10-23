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

// A desktop more grows a mark at the row's end out of nothing, one fewer
// shrinks the last away (the marks before it take on what the desktops now
// are): the row, and with it the island, changes width on the marks' own
// transition rather than at once (island.scss).
const LEAVE_MS = 300

export default function Desktops({ monitor }: { monitor: string }) {
    const row = new Gtk.Box({ cssClasses: ["island-desktops"], valign: Gtk.Align.CENTER })
    // the marks, in order; not the ones on their way out
    const buttons: Gtk.Button[] = []
    let ids: number[] = []
    const leaving = new Set<number>()

    const make = () => {
        const button = new Gtk.Button({ cssClasses: ["desktop", "arriving"], valign: Gtk.Align.CENTER })
        button.set_child(new Gtk.Box({ cssClasses: ["tile"], valign: Gtk.Align.CENTER }))
        // the id at the time of the click: a reordered row keeps its buttons
        button.connect("clicked", () => {
            const index = buttons.indexOf(button)
            const id = ids[index]
            if (id === undefined) return
            if (marksOn(monitor)[index]?.current) toggleMissionControl()
            else void goToDesktop(id)
        })
        // from nothing once it has been drawn so (a frame later: the first
        // comes before it is styled at all), or there's no start to go from
        let frames = 0
        button.add_tick_callback(() => {
            if (++frames < 2) return GLib.SOURCE_CONTINUE
            button.remove_css_class("arriving")
            return GLib.SOURCE_REMOVE
        })
        row.insert_child_after(button, buttons.at(-1) ?? null)
        buttons.push(button)
    }

    const drop = () => {
        const button = buttons.pop()!
        button.add_css_class("leaving")
        button.set_can_target(false)
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_MS, () => {
            leaving.delete(timer)
            row.remove(button)
            return GLib.SOURCE_REMOVE
        })
        leaving.add(timer)
    }

    const update = () => {
        const marks = marksOn(monitor)
        while (buttons.length < marks.length) make()
        while (buttons.length > marks.length) drop()
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
        leaving.forEach(timer => GLib.source_remove(timer))
    })
    update()

    return row
}
