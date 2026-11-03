import { Gtk, Gdk } from "ags/gtk4"
import { ZoomImage } from "../zoom"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { With, createComputed, createState, onCleanup, type Accessor } from "ags"

import { clockTime } from "../services/minuteClock"
import { localZone, searchPlaces, timeZone, zoneCity, zones } from "../services/places"
import { centerOpen } from "../Notifications/store"
import { changeWidget, type ClockCity, type WidgetSize, type WidgetSpec } from "./model"
import { setMenu, shownMinute } from "./util"
import { canvas, circle, line, rgba, text } from "./draw"

// ─── World clock ──────────────────────────────────────────────────────────────
// Analog clocks for the cities chosen, as a Mac's Clock widget: a white face
// where it's day, a black one where it's night, the city under it with the
// day and the hours it's ahead or behind. One city at the small size, four
// at the medium, six in a list at the large one, here first. The hands move
// with the minute: no second hand ticking while it's shown.

const MOST: Record<WidgetSize, number> = { small: 1, medium: 4, large: 6 }
const ELSEWHERE = ["America/New_York", "Asia/Tokyo", "Australia/Sydney", "Europe/London", "America/Los_Angeles", "Asia/Kolkata"]

type City = { name: string, zone: string }

const cityOf = (entry: ClockCity): City => typeof entry === "string" ? { name: zoneCity(entry), zone: entry } : entry
// (kept as its zone alone where the name is the zone's own)
const entryOf = (city: City): ClockCity => city.name === zoneCity(city.zone) ? city.zone : { name: city.name, zone: city.zone }
const sameCity = (a: City, b: City) => a.name === b.name && a.zone === b.zone

/** The cities a clock shows: its own, or here and the world's usual ones. */
export function citiesOf(spec: WidgetSpec): City[] {
    const own = (spec.zones ?? []).map(cityOf).filter(c => timeZone(c.zone))
    if (own.length) return own.slice(0, MOST[spec.size])
    const here = localZone()
    const offset = (z: string) => GLib.DateTime.new_now(timeZone(z)!).get_utc_offset()
    const hereOffset = GLib.DateTime.new_now_local().get_utc_offset()
    // (not a city as far from here as here itself)
    const others = ELSEWHERE.filter(z => z !== here && timeZone(z) && offset(z) !== hereOffset)
    return [here, ...others].slice(0, MOST[spec.size]).map(cityOf)
}

const timeIn = (zone: string) => GLib.DateTime.new_now(timeZone(zone) ?? GLib.TimeZone.new_local())

function relative(zone: string): { day: string, offset: string } {
    const there = timeIn(zone)
    const here = GLib.DateTime.new_now_local()
    const diff = Math.round((Number(there.get_utc_offset()) - Number(here.get_utc_offset())) / 60e6)
    const dayDiff = Math.sign((there.get_year() - here.get_year()) * 400 + there.get_day_of_year() - here.get_day_of_year())
    const h = Math.trunc(Math.abs(diff) / 60), m = Math.abs(diff) % 60
    return {
        day: dayDiff > 0 ? "Tomorrow" : dayDiff < 0 ? "Yesterday" : "Today",
        offset: diff === 0 ? "+0h" : `${diff < 0 ? "−" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}h`,
    }
}

const isDay = (t: GLib.DateTime) => t.get_hour() >= 6 && t.get_hour() < 18

function Face({ zone, size }: { zone: string, size: number }) {
    const area = canvas(size, size, (self, snapshot, w, h) => {
        const t = timeIn(zone)
        const day = isDay(t)
        const r = Math.min(w, h) / 2
        const cx = w / 2, cy = h / 2
        const ink = (alpha: number) => day ? rgba(0.08, 0.08, 0.08, alpha) : rgba(0.96, 0.96, 0.96, alpha)
        circle(snapshot, cx, cy, r, day ? rgba(0.97, 0.97, 0.97) : rgba(0.11, 0.11, 0.12))
        // the hours: numbers on a big face, marks on a small one
        for (let n = 1; n <= 12; n++) {
            const a = n / 12 * 2 * Math.PI - Math.PI / 2
            if (size >= 70) text(self, snapshot, String(n), cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78,
                Math.round(size * 0.115), 600, ink(1))
            else line(snapshot, [[cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82],
                [cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9]], Math.max(1, size * 0.025), ink(0.55))
        }
        const hand = (turn: number, length: number, width: number) => {
            const a = turn * 2 * Math.PI - Math.PI / 2
            line(snapshot, [[cx, cy], [cx + Math.cos(a) * r * length, cy + Math.sin(a) * r * length]], width, ink(1))
        }
        const minutes = t.get_minute()
        hand(((t.get_hour() % 12) + minutes / 60) / 12, 0.5, Math.max(2, size * 0.055))
        hand(minutes / 60, 0.74, Math.max(1.5, size * 0.04))
        // the hub, in the Clock app's orange
        circle(snapshot, cx, cy, Math.max(2, size * 0.045), rgba(1, 0.62, 0.04))
    }, { halign: Gtk.Align.CENTER })
    onCleanup(shownMinute.subscribe(() => area.queue_draw()))
    return area
}

// ─── Picking cities ───────────────────────────────────────────────────────────
// tzdata's own cities at once, as typed; the rest of the world's (Bern,
// Munich, San Francisco: in a zone named for another city) as the place
// search answers, with their zones. Full, one is clicked to be replaced, as
// a slot of a Mac's clock widget is.

type Result = City & { where: string }

function CityPicker({ spec, done }: { spec: Accessor<WidgetSpec>, done: () => void }) {
    const most = MOST[spec.peek().size]
    const limit = most === 1 ? 3 : 4
    const [chosen, setChosen] = createState<City[]>(citiesOf(spec.peek()))
    const [found, setFound] = createState<Result[]>([])
    // the city the next one takes the place of
    const [replacing, setReplacing] = createState<number | null>(null)
    const entryState = createComputed(get => {
        const list = get(chosen), at = get(replacing)
        if (at !== null && list[at]) return { open: true, hint: `Replace ${list[at].name}` }
        if (most > 1 && list.length >= most) return { open: false, hint: "Click a City to Replace It" }
        return { open: true, hint: "Add a City" }
    })
    let searching = 0
    onCleanup(() => { if (searching) GLib.source_remove(searching) })
    let entry: Gtk.Entry
    const save = (list: City[]) => {
        setChosen(list)
        changeWidget(spec.peek().id, { zones: list.map(entryOf) })
    }
    const add = (city: City) => {
        const list = chosen.peek(), at = replacing.peek()
        if (most === 1) save([city])
        else if (list.some(c => sameCity(c, city))) { /* there already */ }
        else if (at !== null) save(list.map((c, i) => i === at ? city : c))
        else if (list.length < most) save([...list, city])
        setReplacing(null)
        entry?.set_text("")
    }
    return (
        <box class="clock-picker" orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand
            $={(self: Gtk.Box) => self.connect("map", () => entry?.grab_focus())}>
            <box>
                <label class="clock-picker-title" label={most === 1 ? "City" : "Cities"} xalign={0} hexpand />
                <button class="clock-picker-done" onClicked={done}><label label="Done" /></button>
            </box>
            <entry widthChars={4} sensitive={entryState(e => e.open)} placeholderText={entryState(e => e.hint)}
                $={(self: Gtk.Entry) => {
                    entry = self
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
                    const text = self.get_text().trim()
                    const q = text.toLowerCase()
                    if (q.length < 2) return setFound([])
                    const local: Result[] = zones()
                        .filter(z => z.name.toLowerCase().includes(q) || z.zone.toLowerCase().includes(q))
                        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
                        .slice(0, limit)
                        .map(z => ({ name: z.name, zone: z.zone, where: z.zone.split("/")[0].replace(/_/g, " ") }))
                    setFound(local)
                    searching = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        searching = 0
                        searchPlaces(text, 6).then(places => {
                            if (self.get_text().trim() !== text) return
                            const world: Result[] = places.filter(p => p.timezone && timeZone(p.timezone))
                                .map(p => ({ name: p.name, zone: p.timezone, where: [p.region, p.country].filter(Boolean).join(", ") }))
                            // (the likeliest first: the search knows how big a place is)
                            const all = [...world, ...local].filter((r, i, list) => list.findIndex(o => sameCity(o, r)) === i)
                            setFound(all.slice(0, limit))
                        }).catch(() => { /* offline: tzdata's cities */ })
                        return GLib.SOURCE_REMOVE
                    })
                }}
                onActivate={() => {
                    const first = found.peek()[0]
                    if (first) add(first)
                }} />
            <With value={createComputed(get => ({ chosen: get(chosen), found: get(found), at: get(replacing) }))}>
                {({ chosen: list, found: results, at }: { chosen: City[], found: Result[], at: number | null }) => (
                    <box orientation={Gtk.Orientation.VERTICAL}>
                        {results.length
                            ? results.map(r => (
                                <button class="clock-picker-row" onClicked={() => add(r)}>
                                    <box spacing={6}>
                                        <label label={r.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                        <label class="clock-picker-where" label={r.where} xalign={0} hexpand
                                            ellipsize={Pango.EllipsizeMode.END} />
                                    </box>
                                </button>
                            ))
                            : list.map((city, i) => (
                                <box class={at === i ? "clock-picker-city replacing" : "clock-picker-city"}>
                                    <button class="clock-picker-pick" hexpand tooltipText="Replace"
                                        onClicked={() => {
                                            setReplacing(at === i ? null : i)
                                            entry?.grab_focus()
                                        }}>
                                        <label label={city.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                    </button>
                                    {list.length > 1
                                        ? <button class="clock-picker-remove" tooltipText="Remove"
                                            onClicked={() => {
                                                setReplacing(null)
                                                save(list.filter(c => !sameCity(c, city)))
                                            }}>
                                            <ZoomImage iconName="list-remove-symbolic" pixelSize={10} />
                                        </button>
                                        : <box />}
                                </box>
                            ))}
                    </box>
                )}
            </With>
        </box>
    )
}

// ─── The widget ───────────────────────────────────────────────────────────────

// (four in a row: the day over the hours, "Tomorrow, +10h" being wider
// than a quarter)
function CityFace({ city, face, narrow = false }: { city: City, face: number, narrow?: boolean }) {
    const { day, offset } = relative(city.zone)
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} halign={Gtk.Align.CENTER}>
            <Face zone={city.zone} size={face} />
            <box orientation={Gtk.Orientation.VERTICAL}>
                <label class="clock-city" label={city.name} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={10} />
                {narrow
                    ? <box orientation={Gtk.Orientation.VERTICAL}>
                        <label class="clock-when" label={day} />
                        <label class="clock-when" label={offset} />
                    </box>
                    : <label class="clock-when" label={`${day}, ${offset}`} />}
            </box>
        </box>
    )
}

export function WorldClock({ spec }: { spec: Accessor<WidgetSpec> }) {
    const size = spec.peek().size
    const [picking, setPicking] = createState(false)
    // (a picker left open is put away with Notification Center)
    onCleanup(centerOpen.subscribe(() => { if (!centerOpen.peek()) setPicking(false) }))
    // built again as the cities change, or one's day or offset does (its
    // midnight, the clocks changing); the hands follow the minute themselves
    const shown = createComputed(get => {
        get(shownMinute)
        return JSON.stringify(citiesOf(get(spec)).map(c => [c.name, c.zone, relative(c.zone).day, relative(c.zone).offset]))
    })
    return (
        <box class="widget-content clock" hexpand vexpand
            $={(self: Gtk.Box) => setMenu(self, () => [{
                label: size === "small" ? "Choose City…" : "Choose Cities…", icon: "find-location-symbolic",
                onClick: () => setPicking(true),
            }])}>
            <With value={picking}>
                {(isPicking: boolean) => isPicking
                    ? <CityPicker spec={spec} done={() => setPicking(false)} />
                    : <box hexpand vexpand><With value={shown}>
                {() => {
                    const list = citiesOf(spec.peek())
                    if (size === "small") return <box halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} hexpand vexpand>
                        <CityFace city={list[0]} face={92} />
                    </box>
                    if (size === "medium") return (
                        <box homogeneous hexpand valign={Gtk.Align.CENTER}>
                            {list.map(city => <CityFace city={city} face={60} narrow />)}
                        </box>
                    )
                    return (
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={10} hexpand>
                            {list.map(city => {
                                const { day, offset } = relative(city.zone)
                                return (
                                    <box class="clock-row" spacing={12}>
                                        <Face zone={city.zone} size={38} />
                                        <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                                            <label class="clock-city" label={city.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                            <label class="clock-when" label={`${day}, ${offset}`} xalign={0} />
                                        </box>
                                        <label class="clock-digital" label={shownMinute(() => clockTime(timeIn(city.zone)))} />
                                    </box>
                                )
                            })}
                        </box>
                    )
                }}
                    </With></box>}
            </With>
        </box>
    )
}
