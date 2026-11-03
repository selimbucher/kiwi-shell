import { Gtk } from "ags/gtk4"
import { ZoomImage } from "../zoom"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import { With, type Accessor } from "ags"

import { batteries, chargeHistory, type Battery, type Charge } from "../services/batteries"
import type { WidgetSpec } from "./model"
import { arc, canvas, line, polygon, rgba } from "./draw"
import { justOpened, whileOpen } from "./util"

// ─── Batteries widget ─────────────────────────────────────────────────────────
// A ring per device, filled as far as it's charged, its icon inside: green,
// red once it's low, a bolt on it while it charges. The small size holds one
// big ring (just the computer) or four small ones, the medium four in a row
// with their levels, the large a list with names and the time left.

const GREEN = [0.19, 0.82, 0.35]
const RED = [1, 0.27, 0.23]
const LOW = 0.2

const percent = (b: Battery) => `${Math.round(b.level * 100)}%`

// A ring fills to its level as Notification Center opens; a level that
// changes while it's open moves there from where it was.
const FILL_MS = 520
const lastShown = new Map<string, number>()
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

function timeLeft(b: Battery): string {
    if (b.full) return "Charged"
    if (b.held) return "Charging On Hold"
    if (!b.left) return b.charging ? "Charging" : ""
    const h = Math.floor(b.left / 3600), m = Math.round((b.left % 3600) / 60)
    const time = h ? `${h}:${String(m).padStart(2, "0")}` : `${m} min`
    return b.charging ? `Full in ${time}` : `${time} left`
}

function Ring({ battery, size, icon }: { battery: Battery, size: number, icon: number }) {
    const width = Math.max(4, Math.round(size * 0.085))
    let shown = 1
    const area = canvas(size, size, (_c, snapshot, w, h) => {
        const r = Math.min(w, h) / 2 - width / 2
        const cx = w / 2, cy = h / 2
        arc(snapshot, cx, cy, r, 1, width, rgba(1, 1, 1, 0.16))
        const [red, green, blue] = battery.level <= LOW && !battery.charging ? RED : GREEN
        arc(snapshot, cx, cy, r, shown, width, rgba(red, green, blue))
        if (battery.charging) {
            // a bolt on the ring's top
            const s = width * 2
            const bolt: [number, number][] = [
                [cx + s * 0.08, cy - r - s * 0.5], [cx - s * 0.28, cy - r + s * 0.06], [cx - s * 0.02, cy - r + s * 0.06],
                [cx - s * 0.1, cy - r + s * 0.5], [cx + s * 0.28, cy - r - s * 0.08], [cx + s * 0.02, cy - r - s * 0.08],
            ]
            line(snapshot, [...bolt, bolt[0]], 2.4, rgba(0, 0, 0, 0.55))
            polygon(snapshot, bolt, rgba(1, 1, 1))
        }
    })
    const level = Math.min(1, battery.level)
    shown = level
    area.connect("map", () => {
        const from = justOpened() ? 0 : lastShown.get(battery.key) ?? level
        lastShown.set(battery.key, level)
        if (Math.abs(from - level) < 0.005) {
            shown = level
            return area.queue_draw()
        }
        let start = 0
        shown = from
        area.add_tick_callback((_w, clock) => {
            const now = clock.get_frame_time() / 1000
            if (!start) start = now
            const t = Math.min(1, (now - start) / FILL_MS)
            shown = from + (level - from) * easeOut(t)
            area.queue_draw()
            return t < 1 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
        })
    })
    return (
        <overlay class="battery-ring" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}
            tooltipText={`${battery.of ? `${battery.of}, ` : ""}${battery.name}: ${percent(battery)}${timeLeft(battery) ? `, ${timeLeft(battery)}` : ""}`}>
            {area}
            <ZoomImage $type="overlay" class="battery-icon" gicon={Gio.ThemedIcon.new_from_names(battery.icon)} pixelSize={icon}
                halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} />
        </overlay>
    )
}

// the last day's charge, as a Mac's battery settings draw it; fetched again
// at most every few minutes (the widget is built again as the power drawn
// changes, and the chart went blank meanwhile each time)
const HISTORY_FOR_MS = 5 * 60_000
const histories = new Map<string, { at: number, points: Charge[] }>()

function History({ battery }: { battery: Battery }) {
    let points: Charge[] = histories.get(battery.key)?.points ?? []
    const area = canvas(0, 60, (_c, snapshot, w, h) => {
        const now = Date.now() / 1000, since = now - 86400
        // the lines at 0, 50 and 100%
        for (const f of [0, 0.5, 1]) {
            const y = Math.round(1 + (h - 2) * (1 - f)) + 0.5
            line(snapshot, [[0, y], [w, y]], 1, rgba(1, 1, 1, 0.1))
        }
        if (!points.length) return
        const x = (t: number) => (t - since) / 86400 * w
        const y = (l: number) => 1 + (h - 2) * (1 - l)
        const all = [...points, { time: now, level: battery.level, charging: battery.charging }]
        const curve = all.map(p => [x(p.time), y(p.level)] as [number, number])
        const [red, green, blue] = GREEN
        polygon(snapshot, [[curve[0][0], h], ...curve, [x(now), h]], rgba(red, green, blue, 0.22))
        line(snapshot, curve, 1.6, rgba(red, green, blue))
    }, { hexpand: true, vexpand: true })
    area.connect("map", () => {
        const known = histories.get(battery.key)
        if (known && Date.now() - known.at < HISTORY_FOR_MS) return
        chargeHistory(battery).then(found => {
            histories.set(battery.key, { at: Date.now(), points: found })
            points = found
            area.queue_draw()
        })
    })
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand>
            <label class="battery-fact-name" label="LAST 24 HOURS" xalign={0} />
            {area}
            <box>
                <label class="battery-axis" label="24 h ago" xalign={0} hexpand />
                <label class="battery-axis" label="Now" xalign={1} />
            </box>
        </box>
    )
}

function Empty() {
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER} vexpand hexpand>
            <ZoomImage class="battery-none-icon" iconName="battery-missing-symbolic" pixelSize={26} />
            <label class="battery-none" label="No Batteries" />
        </box>
    )
}

export function Batteries({ spec }: { spec: Accessor<WidgetSpec> }) {
    const size = spec.peek().size
    return (
        <box class="widget-content batteries" hexpand vexpand>
            <With value={whileOpen(batteries)}>
                {(all: Battery[]) => {
                    if (!all.length) return <Empty />
                    if (size === "small" && all.length === 1) {
                        const b = all[0]
                        return (
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={8} valign={Gtk.Align.CENTER} hexpand vexpand>
                                <Ring battery={b} size={84} icon={30} />
                                <label class="battery-level big" label={percent(b)} />
                            </box>
                        )
                    }
                    if (size === "small") {
                        const grid = new Gtk.Grid({ rowSpacing: 10, columnSpacing: 10, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true })
                        all.slice(0, 4).forEach((b, i) => grid.attach(<Ring battery={b} size={56} icon={20} /> as Gtk.Widget, i % 2, Math.floor(i / 2), 1, 1))
                        return grid
                    }
                    if (size === "medium" && all.length === 1) {
                        const b = all[0]
                        return (
                            <box spacing={18} valign={Gtk.Align.CENTER} hexpand>
                                <Ring battery={b} size={92} icon={32} />
                                <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                                    <label class="battery-name" label={b.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                    <label class="battery-level huge" label={percent(b)} xalign={0} />
                                    <label class="battery-status" label={timeLeft(b)} xalign={0} visible={!!timeLeft(b)} />
                                </box>
                            </box>
                        )
                    }
                    if (size === "medium") {
                        return (
                            <box homogeneous hexpand valign={Gtk.Align.CENTER}>
                                {all.slice(0, 4).map(b => (
                                    <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                                        <Ring battery={b} size={62} icon={22} />
                                        <label class="battery-level" label={percent(b)} />
                                    </box>
                                ))}
                            </box>
                        )
                    }
                    // the computer on top, how it's doing, then the rest
                    const own = all.find(b => b.internal)
                    const others = all.filter(b => b !== own)
                    const facts = own ? [
                        own.health ? ["Health", `${Math.round(own.health * 100)}%`] : null,
                        own.cycles ? ["Cycles", String(own.cycles)] : null,
                        own.watts >= 0.1 ? [own.charging ? "Charging at" : "Using", `${own.watts.toFixed(1)} W`] : null,
                    ].filter((f): f is string[] => !!f) : []
                    return (
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={10} hexpand vexpand>
                            {own ? (
                                <box spacing={18}>
                                    <Ring battery={own} size={84} icon={30} />
                                    <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                                        <label class="battery-name" label={own.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                        <label class="battery-level huge" label={percent(own)} xalign={0} />
                                        <label class="battery-status" label={timeLeft(own)} xalign={0} visible={!!timeLeft(own)} />
                                    </box>
                                </box>
                            ) : <box />}
                            {facts.length ? (
                                <box class="battery-facts" homogeneous>
                                    {facts.map(([name, value]) => (
                                        <box orientation={Gtk.Orientation.VERTICAL} spacing={1}>
                                            <label class="battery-fact-name" label={name} xalign={0} />
                                            <label class="battery-fact" label={value} xalign={0} />
                                        </box>
                                    ))}
                                </box>
                            ) : <box />}
                            {own && !others.length ? <History battery={own} /> : <box />}
                            {others.slice(0, own ? 3 : 6).map(b => (
                                <box class="battery-row" spacing={12}>
                                    <Ring battery={b} size={40} icon={16} />
                                    <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                                        <label class="battery-name" label={b.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                        <label class="battery-status" label={timeLeft(b) || b.of || ""} xalign={0}
                                            ellipsize={Pango.EllipsizeMode.END} visible={!!(timeLeft(b) || b.of)} />
                                    </box>
                                    <label class="battery-level" label={percent(b)} />
                                </box>
                            ))}
                        </box>
                    )
                }}
            </With>
        </box>
    )
}
