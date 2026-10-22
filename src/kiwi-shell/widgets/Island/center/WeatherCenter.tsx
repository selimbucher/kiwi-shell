import { Gtk } from "ags/gtk4"
import { With } from "ags"
import GLib from "gi://GLib"

import { forecast, weatherProblem, condition, type Forecast } from "../../services/weather"

// ─── The weather ──────────────────────────────────────────────────────────────
// The sky and the temperature now; a click shows what macOS's Weather widget
// does: the place, the day's high and low, the next hours and days.

const deg = (n: number) => `${Math.round(n)}°`

function hourLabel(time: string, first: boolean): string {
    if (first) return "Now"
    const t = GLib.DateTime.new_from_iso8601(`${time}:00`, GLib.TimeZone.new_local())
    return t?.format("%H") ?? time.slice(11, 13)
}

function dayLabel(date: string, first: boolean): string {
    if (first) return "Today"
    const t = GLib.DateTime.new_from_iso8601(`${date}T12:00:00`, GLib.TimeZone.new_local())
    return t?.format("%a") ?? date
}

function Details({ f }: { f: Forecast }) {
    const today = f.days[0]
    const lowest = Math.min(...f.days.map(d => d.low))
    const highest = Math.max(...f.days.map(d => d.high))
    const span = Math.max(1, highest - lowest)
    return (
        <box class="island-weather-card" orientation={Gtk.Orientation.VERTICAL}>
            <label class="place" label={f.place} xalign={0} />
            <label class="now" label={deg(f.now.degrees)} xalign={0} />
            <label class="sky" label={condition(f.now.code, f.now.day).text} xalign={0} />
            {today ? <label class="range" label={`H:${deg(today.high)} L:${deg(today.low)}`} xalign={0} /> : <box />}
            <box class="hours" homogeneous>
                {f.hours.map((h, i) => (
                    <box orientation={Gtk.Orientation.VERTICAL} class="hour">
                        <label class="when" label={hourLabel(h.time, i === 0)} />
                        <Gtk.Image iconName={condition(h.code, h.day).icon} pixelSize={18} />
                        <label class="degrees" label={deg(h.degrees)} />
                    </box>
                ))}
            </box>
            <box class="days" orientation={Gtk.Orientation.VERTICAL}>
                {f.days.map((d, i) => (
                    <box class="day">
                        <label class="when" label={dayLabel(d.date, i === 0)} xalign={0} widthChars={6} />
                        <Gtk.Image iconName={condition(d.code).icon} pixelSize={16} />
                        <label class="low" label={deg(d.low)} widthChars={4} xalign={1} />
                        {/* the day's range on the week's scale, as Apple Weather draws it */}
                        <box class="scale" hexpand valign={Gtk.Align.CENTER}>
                            <box class="span" hexpand={false} valign={Gtk.Align.CENTER}
                                marginStart={Math.round(((d.low - lowest) / span) * 100)}
                                widthRequest={Math.max(6, Math.round(((d.high - d.low) / span) * 100))} />
                        </box>
                        <label class="high" label={deg(d.high)} widthChars={4} xalign={1} />
                    </box>
                ))}
            </box>
        </box>
    )
}

export default function WeatherCenter() {
    return (
        <menubutton class="island-weather" valign={Gtk.Align.CENTER} alwaysShowArrow={false}>
            <box>
                <With value={forecast}>
                    {(f: Forecast | null) => f
                        ? <box spacing={5}>
                            <Gtk.Image iconName={condition(f.now.code, f.now.day).icon} pixelSize={16} />
                            <label label={deg(f.now.degrees)} />
                        </box>
                        : <Gtk.Image iconName="weather-few-clouds-symbolic" pixelSize={16} />}
                </With>
            </box>
            <popover class="island-weather-popover" hasArrow={false} autohide>
                <box>
                    <With value={forecast}>
                        {(f: Forecast | null) => f
                            ? <Details f={f} />
                            : <label class="island-weather-empty" label={weatherProblem(p => p === "No city set"
                                ? "Set your city in Kiwi Settings, under Status Bar." : p ?? "Getting the weather…")} />}
                    </With>
                </box>
            </popover>
        </menubutton>
    )
}
