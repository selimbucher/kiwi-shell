import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"
import Hyprland from "gi://AstalHyprland"

import { desktopsOn, goToDesktop, watchDesktops } from "../../MissionControl/desktops"
import { toggleMissionControl } from "../../MissionControl/MissionControl"
import { Tween, cubicBezier, type Timing } from "../../MissionControl/motion"

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

// ─── The row ──────────────────────────────────────────────────────────────────
// Laid out here rather than by a box and the marks' own CSS transitions: GTK
// rounds each mark's width up to a whole pixel on its own, so one mark
// narrowing while another widened (an empty desktop to an empty one) made
// the row, and the island with it, a pixel wider for as long as it lasted.
// Here the widths are counted together, in fractions. A desktop more grows a
// mark at the row's end out of nothing, one fewer shrinks the last into
// nothing (the marks before it take on what the desktops now are).

const MARK = 14 // a mark, the colour across its width
const WIDE = 20 // the current desktop's, or one with windows
const GAP = 3 // either side of each
const GROW: Timing = { ms: 260, curve: cubicBezier(0.25, 0.1, 0.25, 1) }

type Slot = { button: Gtk.Button; width: Tween; leaving: boolean }

const MarksRow = GObject.registerClass(
    { GTypeName: "KiwiIslandMarks" },
    class MarksRow extends Gtk.Widget {
        private slots: Slot[] = []
        private ticking = 0

        /** A mark at the end, grown out of nothing unless `now`. */
        add(button: Gtk.Button, now: boolean) {
            button.set_parent(this)
            const width = new Tween(0)
            if (now) width.jump(MARK)
            else width.to(MARK, GROW)
            this.slots.push({ button, width, leaving: false })
            this.animate()
        }

        /** Wide or not, at once if `now`. */
        widen(button: Gtk.Button, wide: boolean, now: boolean) {
            const slot = this.slots.find(s => s.button === button && !s.leaving)
            if (!slot) return
            if (now) slot.width.jump(wide ? WIDE : MARK)
            else slot.width.to(wide ? WIDE : MARK, GROW)
            this.animate()
        }

        /** Shrunk into nothing, then gone. */
        drop(button: Gtk.Button) {
            const slot = this.slots.find(s => s.button === button)
            if (!slot) return
            slot.leaving = true
            button.set_can_target(false)
            slot.width.to(0, GROW)
            this.animate()
        }

        private animate() {
            this.queue_resize()
            if (this.ticking) return
            this.ticking = this.add_tick_callback((_w, clock) => {
                const now = clock.get_frame_time()
                let running = false
                for (const slot of this.slots) if (slot.width.step(now) || slot.width.running) running = true
                for (const slot of this.slots.filter(s => s.leaving && !s.width.running)) {
                    slot.button.unparent()
                    this.slots.splice(this.slots.indexOf(slot), 1)
                }
                this.queue_resize()
                if (running) return GLib.SOURCE_CONTINUE
                this.ticking = 0
                return GLib.SOURCE_REMOVE
            })
        }

        // the gaps grow and shrink with a mark coming or going
        private static gap(width: number): number {
            return GAP * Math.min(1, width / MARK)
        }

        vfunc_measure(orientation: Gtk.Orientation, _forSize: number): [number, number, number, number] {
            if (orientation === Gtk.Orientation.VERTICAL) {
                const sizes = this.slots.map(s => s.button.measure(orientation, -1))
                return [Math.max(0, ...sizes.map(([min]) => min)), Math.max(0, ...sizes.map(([, nat]) => nat)), -1, -1]
            }
            const total = this.slots.reduce((sum, s) => sum + s.width.value + 2 * MarksRow.gap(s.width.value), 0)
            const width = Math.round(total)
            return [width, width, -1, -1]
        }

        vfunc_size_allocate(_width: number, height: number, _baseline: number): void {
            let x = 0
            for (const { button, width } of this.slots) {
                const gap = MarksRow.gap(width.value)
                button.measure(Gtk.Orientation.HORIZONTAL, height)
                button.allocate(Math.max(0, Math.round(width.value)), height, -1,
                    new Gsk.Transform().translate(new Graphene.Point({ x: x + gap, y: 0 })))
                x += width.value + 2 * gap
            }
        }

        vfunc_dispose(): void {
            if (this.ticking) this.remove_tick_callback(this.ticking)
            this.ticking = 0
            for (const { button } of this.slots) button.unparent()
            this.slots = []
            super.vfunc_dispose()
        }
    },
)

export default function Desktops({ monitor }: { monitor: string }) {
    const row = new MarksRow({ cssClasses: ["island-desktops"], valign: Gtk.Align.CENTER })
    // the marks, in order; not the ones on their way out
    const buttons: Gtk.Button[] = []
    let ids: number[] = []
    let built = false

    const make = () => {
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
        // the row as it is when the island first shows: no growing in
        row.add(button, !built)
        buttons.push(button)
    }

    const update = () => {
        const marks = marksOn(monitor)
        while (buttons.length < marks.length) make()
        while (buttons.length > marks.length) row.drop(buttons.pop()!)
        ids = marks.map(m => m.id)
        marks.forEach((mark, i) => {
            const b = buttons[i]
            for (const name of ["current", "filled", "urgent"] as const) {
                if (mark[name]) b.add_css_class(name)
                else b.remove_css_class(name)
            }
            row.widen(b, mark.current || mark.filled, !built)
            b.set_tooltip_text(`Desktop ${i + 1}`)
        })
        built = true
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
