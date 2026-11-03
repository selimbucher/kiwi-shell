import { Gtk, Gdk } from "ags/gtk4"
import { ZoomImage } from "../zoom"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix"
import Pango from "gi://Pango"
import { With, createComputed, createState, onCleanup, type Accessor } from "ags"

import { condition, daysFrom, freshen, hoursFrom, weatherFor, type Forecast } from "../services/weather"
import { searchPlaces, type Found } from "../services/places"
import { clockHour } from "../services/minuteClock"
import { conf } from "../config"
import { centerOpen, closeCenter } from "../Notifications/store"
import { changeWidget, type WidgetSpec } from "./model"
import { onClick, setMenu } from "./util"

// ─── Weather widget ───────────────────────────────────────────────────────────
// The place, the temperature and the sky now; the next hours at the medium
// size, the coming days too at the large one, on a sky of the weather's
// colours, as Apple's. Each widget has a place of its own or follows Kiwi
// Settings' (and with none set, the time zone's city). The forecast is
// fetched as Notification Center opens on it, when it's older than 15
// minutes, never while it's closed.

const deg = (n: number) => `${Math.round(n)}°`

function hourLabel(time: string, first: boolean): string {
    if (first) return "Now"
    const t = GLib.DateTime.new_from_iso8601(`${time}:00`, GLib.TimeZone.new_local())
    return t ? clockHour(t) : time.slice(11, 13)
}

function dayLabel(date: string, first: boolean): string {
    if (first) return "Today"
    const t = GLib.DateTime.new_from_iso8601(`${date}T12:00:00`, GLib.TimeZone.new_local())
    return t?.format("%a") ?? date
}

/** The sky behind it: the weather's, by day or night. */
export function skyOf(code: number, day: boolean): string {
    const when = day ? "day" : "night"
    if (code >= 95) return "sky-storm"
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return `sky-snow-${when}`
    if (code >= 51) return `sky-rain-${when}`
    if (code === 45 || code === 48) return `sky-fog-${when}`
    if (code === 3) return `sky-cloudy-${when}`
    return `sky-clear-${when}`
}

// the chance of rain under an hour's or day's sky, where it's worth saying
const Rain = ({ chance }: { chance?: number }) =>
    <label class="weather-rain" label={chance !== undefined && chance >= 30 ? `${Math.round(chance / 10) * 10}%` : ""}
        visible={chance !== undefined && chance >= 30} />

function Now({ f, spec, wide }: { f: Forecast, spec: WidgetSpec, wide: boolean }) {
    const today = daysFrom(f, 1)[0]
    const sky = condition(f.now.code, f.now.day)
    const place = (
        <box spacing={4}>
            <label class="weather-place" label={f.place} ellipsize={Pango.EllipsizeMode.END} xalign={0} />
            {/* the place followed, not one picked for this widget */}
            <ZoomImage class="weather-here" iconName="find-location-symbolic" pixelSize={10} visible={!spec.city} />
        </box>
    )
    const range = <label class="weather-range" label={today ? `H:${deg(today.high)} L:${deg(today.low)}` : ""} xalign={wide ? 1 : 0} />
    if (!wide) {
        return (
            <box orientation={Gtk.Orientation.VERTICAL} vexpand>
                {place}
                <label class="weather-now" label={deg(f.now.degrees)} xalign={0} />
                <box vexpand />
                <ZoomImage class="weather-icon" iconName={sky.icon} pixelSize={18} halign={Gtk.Align.START} />
                <label class="weather-condition" label={sky.text} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                {range}
            </box>
        )
    }
    return (
        <box>
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                {place}
                <label class="weather-now" label={deg(f.now.degrees)} xalign={0} />
            </box>
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.END} halign={Gtk.Align.END}>
                <ZoomImage class="weather-icon" iconName={sky.icon} pixelSize={18} halign={Gtk.Align.END} />
                <label class="weather-condition" label={sky.text} xalign={1} />
                {range}
            </box>
        </box>
    )
}

function Hours({ f }: { f: Forecast }) {
    return (
        <box class="weather-hours" homogeneous>
            {hoursFrom(f, 6).map((h, i) => (
                <box orientation={Gtk.Orientation.VERTICAL} class="weather-hour" spacing={3}>
                    <label class="weather-when" label={hourLabel(h.time, i === 0)} />
                    <ZoomImage iconName={condition(h.code, h.day).icon} pixelSize={16} />
                    <Rain chance={h.rain} />
                    <label class="weather-degrees" label={deg(h.degrees)} />
                </box>
            ))}
        </box>
    )
}

function Days({ f }: { f: Forecast }) {
    const days = daysFrom(f, 5)
    const lowest = Math.min(...days.map(d => d.low))
    const highest = Math.max(...days.map(d => d.high))
    const span = Math.max(1, highest - lowest)
    const BAR = 90
    return (
        <box class="weather-days" orientation={Gtk.Orientation.VERTICAL} vexpand homogeneous>
            {days.map((d, i) => (
                <box class="weather-day" spacing={8}>
                    <label class="weather-when" label={dayLabel(d.date, i === 0)} xalign={0} widthChars={6} />
                    <box orientation={Gtk.Orientation.VERTICAL} widthRequest={26} valign={Gtk.Align.CENTER}>
                        <ZoomImage iconName={condition(d.code).icon} pixelSize={16} />
                        <Rain chance={d.rain} />
                    </box>
                    <label class="weather-low" label={deg(d.low)} widthChars={4} xalign={1} hexpand />
                    {/* the day's range on the week's scale, as Apple Weather draws it */}
                    <box class="weather-scale" widthRequest={BAR} valign={Gtk.Align.CENTER}>
                        <box class="weather-span" hexpand={false}
                            marginStart={Math.round(((d.low - lowest) / span) * BAR)}
                            widthRequest={Math.max(8, Math.round(((d.high - d.low) / span) * BAR))} />
                    </box>
                    <label class="weather-high" label={deg(d.high)} widthChars={4} xalign={1} />
                </box>
            ))}
        </box>
    )
}

// ─── Picking a place ──────────────────────────────────────────────────────────

// a place as it's kept: its name and where it is, so a second Buchs or
// Portland is told from the first ("Buchs, St. Gallen, Switzerland")
const placeName = (p: Found) => [p.name, p.region, p.country].filter(Boolean).join(", ")

type Search = { text: string, places: Found[], state: "idle" | "searching" | "found" | "none" | "failed" }

function PlacePicker({ spec, done }: { spec: Accessor<WidgetSpec>, done: () => void }) {
    // as many as there's room for: a small one's under their names, the
    // wider ones' on a line each
    const size = spec.peek().size
    const room = size === "small" ? 2 : size === "medium" ? 3 : 6
    const [search, setSearch] = createState<Search>({ text: "", places: [], state: "idle" })
    let searching = 0
    // Enter before the places came: the first of them, once they're here
    let pickFirst = false
    let entry: Gtk.Entry
    const pick = (city: string | undefined) => {
        changeWidget(spec.peek().id, { city })
        done()
    }
    onCleanup(() => { if (searching) GLib.source_remove(searching) })
    const fallback = () => (conf.peek().island?.weather_city ?? "").trim() || "your time zone's city"
    return (
        <box class="weather-picker" orientation={Gtk.Orientation.VERTICAL} spacing={6}
            $={(self: Gtk.Box) => self.connect("map", () => entry?.grab_focus())}>
            <label class="weather-picker-title" label="Location" xalign={0} />
            <entry
                placeholderText="City"
                widthChars={4}
                $={(self: Gtk.Entry) => {
                    entry = self
                    self.set_text(spec.peek().city ?? "")
                    const keys = new Gtk.EventControllerKey()
                    keys.connect("key-pressed", (_c, key) => {
                        if (key !== Gdk.KEY_Escape) return false
                        done()
                        return true
                    })
                    self.add_controller(keys)
                }}
                onChanged={(self: Gtk.Entry) => {
                    if (searching) GLib.source_remove(searching)
                    searching = 0
                    pickFirst = false
                    const text = self.get_text().trim()
                    // (what was found for the last text is gone with it)
                    if (text.length < 2) return setSearch({ text, places: [], state: "idle" })
                    setSearch({ text, places: [], state: "searching" })
                    searching = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        searching = 0
                        searchPlaces(text, room).then(places => {
                            if (self.get_text().trim() !== text) return
                            setSearch({ text, places, state: places.length ? "found" : "none" })
                            if (pickFirst && places[0]) pick(placeName(places[0]))
                        }).catch(() => {
                            if (self.get_text().trim() === text) setSearch({ text, places: [], state: "failed" })
                        })
                        return GLib.SOURCE_REMOVE
                    })
                }}
                onActivate={(self: Gtk.Entry) => {
                    const { places, state } = search.peek()
                    if (!self.get_text().trim()) pick(undefined)
                    else if (places[0]) pick(placeName(places[0]))
                    else if (state === "searching") pickFirst = true
                }}
            />
            <box orientation={Gtk.Orientation.VERTICAL} class="weather-found">
                <With value={search}>
                    {({ places, state }: Search) => (
                        <box orientation={Gtk.Orientation.VERTICAL}>
                            {places.length
                                ? places.map(p => (
                                    <button class="weather-found-row" onClicked={() => pick(placeName(p))}>
                                        <box orientation={size === "small" ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL}
                                            spacing={6}>
                                            <label label={p.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                            <label class="weather-found-where" label={[p.region, p.country].filter(Boolean).join(", ")}
                                                xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} />
                                        </box>
                                    </button>
                                ))
                                : <label class="weather-picker-hint" wrap xalign={0} label={
                                    state === "searching" ? "Searching…"
                                    : state === "none" ? "No places found."
                                    : state === "failed" ? "Couldn't search: no connection?"
                                    : `Leave it empty for ${fallback()}.`} />}
                        </box>
                    )}
                </With>
            </box>
        </box>
    )
}

// ─── The widget ───────────────────────────────────────────────────────────────

const weatherApp = () => GioUnix.DesktopAppInfo.new("org.gnome.Weather.desktop")

export function Weather({ spec }: { spec: Accessor<WidgetSpec> }) {
    const size = spec.peek().size
    const { forecast, problem } = weatherFor(spec.peek().city ?? "")
    const [picking, setPicking] = createState(false)
    const shown = createComputed(get => ({ f: get(forecast), problem: get(problem) }))
    // (built ahead while it's closed: not fetched then; a picker left open
    // is put away with Notification Center)
    if (centerOpen.peek()) freshen(spec.peek().city ?? "")
    onCleanup(centerOpen.subscribe(() => {
        if (centerOpen.peek()) freshen(spec.peek().city ?? "")
        else setPicking(false)
    }))
    return (
        <box class="weather" hexpand vexpand
            $={(self: Gtk.Box) => {
                const app = weatherApp()
                if (app) onClick(self, () => {
                    if (picking.peek()) return
                    try { app.launch([], null) } catch { /* gone */ }
                    closeCenter()
                })
                setMenu(self, () => [{
                    label: "Change Location…", icon: "find-location-symbolic", onClick: () => setPicking(true),
                }])
            }}>
            <With value={picking}>
                {(isPicking: boolean) => isPicking
                    // (apart from the forecast: one landing meanwhile left the
                    // picker as it was)
                    ? <box class="widget-content weather-sky sky-plain" hexpand vexpand>
                        <PlacePicker spec={spec} done={() => setPicking(false)} />
                    </box>
                    : <box hexpand vexpand><With value={shown}>
                {({ f, problem }: { f: Forecast | null, problem: string | null }) => {
                    if (!f) {
                        return (
                            <box class="widget-content weather-sky sky-cloudy-day" orientation={Gtk.Orientation.VERTICAL} hexpand vexpand>
                                <label class="weather-place" label="Weather" xalign={0} />
                                <box vexpand />
                                <label class="weather-condition" wrap xalign={0}
                                    label={problem ?? "Getting the weather…"} />
                            </box>
                        )
                    }
                    const sky = skyOf(f.now.code, f.now.day)
                    if (size === "small") {
                        return <box class={`widget-content weather-sky ${sky}`} hexpand vexpand>
                            <Now f={f} spec={spec.peek()} wide={false} />
                        </box>
                    }
                    return (
                        <box class={`widget-content weather-sky ${sky}`} orientation={Gtk.Orientation.VERTICAL} hexpand vexpand>
                            <Now f={f} spec={spec.peek()} wide />
                            <box vexpand={size === "medium"} />
                            <Hours f={f} />
                            {size === "large" ? <Gtk.Separator class="weather-rule" /> : <box />}
                            {size === "large" ? <Days f={f} /> : <box />}
                        </box>
                    )
                }}
                    </With></box>}
            </With>
        </box>
    )
}
