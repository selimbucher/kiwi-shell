import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"

import { logger } from "../../log"
import { notify } from "../../notify"
import { minuteNow } from "./minuteClock"

const log = logger("calendar")

// ─── Calendar ─────────────────────────────────────────────────────────────────
// The events the calendar widgets show, from Evolution Data Server: the store
// GNOME Calendar, Evolution and GNOME Online Accounts keep calendars in
// (Google, Nextcloud, Exchange, any CalDAV, local ones). Read only, through
// EDS's own client library, and only while a widget is there to show them.
// Every calendar gets a live view from EDS, so an event synced, added or
// moved in GNOME Calendar comes in at once, without asking again; calendars
// hidden there stay hidden here. Repeating events are worked out here for
// the days shown: this month's page and two weeks ahead.
//
// The library is loaded when first wanted: a system without EDS has no
// events and the widgets show the date alone.

export type CalendarEvent = {
    key: string
    calendar: string
    color: string
    summary: string
    location: string
    // unix seconds; an all-day event from local midnight to midnight
    start: number
    end: number
    allDay: boolean
    // a video call to join (Zoom, Meet, Teams…), from the event's text
    meeting: string | null
    // for opening it in the calendar app
    sourceUid: string
    uid: string
    rid: string
}

export type CalendarStatus = "off" | "starting" | "ready" | "missing"

const [events, setEvents] = createState<CalendarEvent[]>([])
const [status, setStatus] = createState<CalendarStatus>("off")
export { events as calendarEvents, status as calendarStatus }

// ─── The library ──────────────────────────────────────────────────────────────

type Eds = { EDataServer: any, ECal: any, ICalGLib: any }
let eds: Eds | null | undefined

async function library(): Promise<Eds | null> {
    if (eds !== undefined) return eds
    try {
        const [EDataServer, ECal, ICalGLib] = await Promise.all([
            import("gi://EDataServer?version=1.2"),
            import("gi://ECal?version=2.0"),
            import("gi://ICalGLib?version=3.0"),
        ])
        eds = { EDataServer: EDataServer.default, ECal: ECal.default, ICalGLib: ICalGLib.default }
    } catch (e) {
        log.info("no Evolution Data Server here, so no events:", (e as Error).message)
        eds = null
    }
    return eds
}

// ─── The days asked for ───────────────────────────────────────────────────────

const AHEAD_DAYS = 14

// from the first day of this month's page (its week's Monday or Sunday) to
// six weeks on, or two weeks from today, whichever is later
function range(today: GLib.DateTime): [number, number] {
    const first = GLib.DateTime.new_local(today.get_year(), today.get_month(), 1, 0, 0, 0)
    const lead = (first.get_day_of_week() - firstWeekday() + 7) % 7
    const start = first.add_days(-lead)!
    const pageEnd = start.add_days(42)!
    const ahead = GLib.DateTime.new_local(today.get_year(), today.get_month(), today.get_day_of_month(), 0, 0, 0)
        .add_days(AHEAD_DAYS + 1)!
    return [start.to_unix(), Math.max(pageEnd.to_unix(), ahead.to_unix())]
}

let weekStart = 0

/** The week's first day as GLib counts (1 Monday … 7 Sunday), from the locale. */
export function firstWeekday(): number {
    if (!weekStart) weekStart = localeWeekday()
    return weekStart
}

// glibc's own (what GTK's calendar uses): the day the week starts, counted
// from its reference week's first
function localeWeekday(): number {
    try {
        const [ok, out] = GLib.spawn_command_line_sync("locale first_weekday week-1stday")
        if (ok && out) {
            const [first, day1] = new TextDecoder().decode(out).trim().split("\n")
            const ref = Number(day1) // 19971130 (a Sunday) or 19971201 (a Monday)
            const offset = Number(first) - 1
            const refWeekday = ref === 19971201 ? 1 : 7
            const day = ((refWeekday - 1 + offset) % 7) + 1
            if (day >= 1 && day <= 7) return day
        }
    } catch { /* no locale tool: Monday, as most of the world */ }
    return 1
}

// ─── Calendars ────────────────────────────────────────────────────────────────

type Calendar = {
    source: any
    client: any | null
    view: any | null
    // the view asked for last
    asked: object
    events: CalendarEvent[]
    refetch: number
    cancellable: Gio.Cancellable
}

let registry: any = null
let registrySignals: number[] = []
const calendars = new Map<string, Calendar>()
let window: [number, number] = [0, 0]
let wanted = 0
let resyncSource = 0
let publishSource = 0
let published = ""
// each start, so what an earlier one asked for and came late is let go
let generation = 0

function publish() {
    if (publishSource) return
    publishSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        publishSource = 0
        const all = [...calendars.values()].flatMap(c => c.events)
        all.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.summary.localeCompare(b.summary))
        // (a sync touches calendars without changing what's shown)
        const signature = JSON.stringify(all)
        if (signature === published) return GLib.SOURCE_REMOVE
        published = signature
        setEvents(all)
        return GLib.SOURCE_REMOVE
    })
}

const shown = (source: any) => {
    const { EDataServer } = eds!
    if (!source.get_enabled() || !source.has_extension(EDataServer.SOURCE_EXTENSION_CALENDAR)) return false
    // (a calendar whose account is switched off in Online Accounts is
    // disabled through its parent)
    const parent = source.get_parent() ? registry.ref_source(source.get_parent()) : null
    if (parent && !parent.get_enabled()) return false
    return source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).get_selected()
}

function resync() {
    if (resyncSource) GLib.source_remove(resyncSource)
    resyncSource = GLib.timeout_add(GLib.PRIORITY_LOW, 300, () => {
        resyncSource = 0
        if (!registry) return GLib.SOURCE_REMOVE
        const { EDataServer } = eds!
        const sources = (registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR) as any[]).filter(shown)
        const uids = new Set(sources.map(s => s.get_uid()))
        for (const [uid, cal] of calendars) {
            if (!uids.has(uid)) {
                drop(cal)
                calendars.delete(uid)
            }
        }
        for (const source of sources) {
            const known = calendars.get(source.get_uid())
            // a new colour or name: the events carry both
            if (known) known.events = known.events.map(e => ({ ...e, ...looks(source) }))
            else open(source)
        }
        publish()
        return GLib.SOURCE_REMOVE
    })
}

const looks = (source: any) => {
    const { EDataServer } = eds!
    const color = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).get_color() ?? ""
    // EDS keeps #RRGGBBAA where GNOME Calendar picked the colour
    return { calendar: source.get_display_name() ?? "", color: /^#[0-9a-f]{8}$/i.test(color) ? color.slice(0, 7) : color }
}

function open(source: any) {
    const { ECal } = eds!
    const cal: Calendar = { source, client: null, view: null, asked: {}, events: [], refetch: 0, cancellable: new Gio.Cancellable() }
    calendars.set(source.get_uid(), cal)
    ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 30, cal.cancellable, (_s: unknown, result: Gio.AsyncResult) => {
        try {
            cal.client = ECal.Client.connect_finish(result)
        } catch (e) {
            if (!cal.cancellable.is_cancelled()) log.warn(`couldn't open ${source.get_display_name()}:`, (e as Error).message)
            return
        }
        watch(cal)
        fetch(cal)
    })
}

function drop(cal: Calendar) {
    cal.cancellable.cancel()
    if (cal.refetch) GLib.source_remove(cal.refetch)
    try { cal.view?.stop() } catch { /* gone with the factory */ }
    cal.view = null
    cal.client = null
    cal.events = []
}

const icalTime = (unix: number) => {
    const { ICalGLib } = eds!
    return ICalGLib.Time.new_from_timet_with_zone(unix, false, ICalGLib.Timezone.get_utc_timezone())
}

const query = () =>
    `(occur-in-time-range? (make-time "${icalTime(window[0]).as_ical_string()}") (make-time "${icalTime(window[1]).as_ical_string()}"))`

// EDS says what changed; the calendar's events are asked for again, once
// for a burst of changes (a sync brings many)
function watch(cal: Calendar) {
    const { ECal } = eds!
    if (cal.view) {
        try { cal.view.stop() } catch { /* gone */ }
        cal.view = null
    }
    const asked = cal.asked = {}
    cal.client.get_view(query(), cal.cancellable, (_c: unknown, result: Gio.AsyncResult) => {
        try {
            const [, view] = cal.client.get_view_finish(result)
            if (asked !== cal.asked) return
            cal.view = view
            const again = () => scheduleFetch(cal)
            view.connect("objects-added", again)
            view.connect("objects-modified", again)
            view.connect("objects-removed", again)
            view.set_flags(ECal.ClientViewFlags.NONE)
            view.start()
        } catch (e) {
            if (!cal.cancellable.is_cancelled()) log.warn(`no live view of ${cal.source.get_display_name()}:`, (e as Error).message)
        }
    })
}

function scheduleFetch(cal: Calendar) {
    if (cal.refetch) GLib.source_remove(cal.refetch)
    cal.refetch = GLib.timeout_add(GLib.PRIORITY_LOW, 250, () => {
        cal.refetch = 0
        fetch(cal)
        return GLib.SOURCE_REMOVE
    })
}

function fetch(cal: Calendar) {
    if (!cal.client) return
    cal.client.get_object_list_as_comps(query(), cal.cancellable, (_c: unknown, result: Gio.AsyncResult) => {
        let comps: any[] = []
        try {
            [, comps] = cal.client.get_object_list_as_comps_finish(result)
        } catch (e) {
            if (!cal.cancellable.is_cancelled()) log.warn(`couldn't read ${cal.source.get_display_name()}:`, (e as Error).message)
            return
        }
        const zones = new Set<string>()
        for (const comp of comps) {
            for (const time of [comp.get_dtstart(), comp.get_dtend()]) {
                const tzid = time?.get_tzid()
                if (tzid && !builtinZone(tzid)) zones.add(tzid)
            }
        }
        // zones of the calendar's own (Outlook names them), fetched once
        fetchZones(cal, [...zones]).then(() => {
            if (cal.cancellable.is_cancelled()) return
            cal.events = expand(cal, comps)
            log.debug(`${cal.source.get_display_name()}: ${comps.length} events, ${cal.events.length} on the days shown`)
            publish()
        }).catch(e => log.warn(`couldn't read ${cal.source.get_display_name()}:`, e as Error))
    })
}

// ─── Time zones ───────────────────────────────────────────────────────────────

const ownZones = new Map<string, any>()

function builtinZone(tzid: string): any {
    const { ICalGLib } = eds!
    return ownZones.get(tzid)
        ?? ICalGLib.Timezone.get_builtin_timezone(tzid)
        ?? ICalGLib.Timezone.get_builtin_timezone_from_tzid(tzid)
}

function fetchZones(cal: Calendar, tzids: string[]): Promise<void> {
    const missing = tzids.filter(t => !ownZones.has(t))
    return Promise.all(missing.map(tzid => new Promise<void>(resolve => {
        cal.client.get_timezone(tzid, cal.cancellable, (_c: unknown, result: Gio.AsyncResult) => {
            try {
                const [, zone] = cal.client.get_timezone_finish(result)
                if (zone) ownZones.set(tzid, zone)
            } catch { /* the event is read in local time then */ }
            resolve()
        })
    }))).then(() => {})
}

let localZoneCache: any = null
function localZone(): any {
    if (localZoneCache) return localZoneCache
    const { ICalGLib } = eds!
    const id = GLib.TimeZone.new_local().get_identifier().replace(/^:/, "").replace(/^.*zoneinfo\//, "")
    localZoneCache = ICalGLib.Timezone.get_builtin_timezone(id) ?? ICalGLib.Timezone.get_utc_timezone()
    return localZoneCache
}

// ─── Instances ────────────────────────────────────────────────────────────────

const MEETING = /https:\/\/[^\s<>"']*(zoom\.us\/[jw]\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|webex\.com\/|whereby\.com\/|meet\.jit\.si\/|facetime\.apple\.com\/)[^\s<>"']*/i

function unixOf(time: any, allDay: boolean, tzid?: string | null): number {
    if (allDay) return GLib.DateTime.new_local(time.get_year(), time.get_month(), time.get_day(), 0, 0, 0).to_unix()
    return time.as_timet_with_zone((tzid ? builtinZone(tzid) : null) ?? time.get_timezone() ?? localZone())
}

function expand(cal: Calendar, comps: any[]): CalendarEvent[] {
    const { ECal, ICalGLib } = eds!
    const { calendar, color } = looks(cal.source)
    const sourceUid = cal.source.get_uid()
    const found: CalendarEvent[] = []
    // occurrences moved or changed on their own come as their own
    // components: the series leaves those dates to them
    const detached = new Set<string>()
    for (const comp of comps) {
        const rid = comp.get_recurid_as_string()
        // (in the zone it names, as the series' own times are read)
        const instance = rid ? comp.get_recurid()?.get_instance() : null
        const original = instance?.get_value()
        if (original) detached.add(`${comp.get_uid()}@${unixOf(original, original.is_date(), instance.get_tzid())}`)
    }
    const start = icalTime(window[0]), end = icalTime(window[1])
    for (const comp of comps) {
        const ical = comp.get_icalcomponent()
        // (as text: an event without one has a status GJS won't take)
        const status = ical.get_first_property(ICalGLib.PropertyKind.STATUS_PROPERTY)
        if (status?.get_value_as_string()?.toUpperCase() === "CANCELLED") continue
        const uid = comp.get_uid() ?? ""
        const rid = comp.get_recurid_as_string() ?? ""
        const summary = comp.get_summary()?.get_value() ?? ""
        const location = comp.get_location() ?? ""
        const descriptions = (comp.get_descriptions() ?? []).map((d: any) => d.get_value() ?? "").join("\n")
        const meeting = `${location}\n${comp.get_url() ?? ""}\n${descriptions}`.match(MEETING)?.[0] ?? null
        try {
            ECal.recur_generate_instances_sync(ical, start, end,
                (_icomp: any, from: any, to: any) => {
                    const allDay = from.is_date()
                    const s = unixOf(from, allDay)
                    if (!rid && detached.has(`${uid}@${s}`)) return true
                    let e = unixOf(to, allDay)
                    if (e <= s) e = allDay ? GLib.DateTime.new_from_unix_local(s).add_days(1)!.to_unix() : s
                    found.push({
                        key: `${sourceUid}:${uid}:${rid || s}`, calendar, color, summary, location,
                        start: s, end: e, allDay, meeting, sourceUid, uid, rid,
                    })
                    return true
                },
                (tzid: string) => builtinZone(tzid) ?? null,
                localZone(), null)
        } catch (e) {
            log.debug(`skipping "${summary}":`, (e as Error).message)
        }
    }
    return found
}

// ─── Starting and stopping ────────────────────────────────────────────────────

let dayWatch: (() => void) | null = null
let today = ""

async function start() {
    const mine = ++generation
    setStatus("starting")
    const lib = await library()
    if (!wanted || mine !== generation) return
    if (!lib) return setStatus("missing")
    const { EDataServer } = lib
    window = range(minuteNow.peek())
    today = minuteNow.peek().format("%F") ?? ""
    EDataServer.SourceRegistry.new(null, (_s: unknown, result: Gio.AsyncResult) => {
        let found: any
        try {
            found = EDataServer.SourceRegistry.new_finish(result)
        } catch (e) {
            if (mine !== generation) return
            log.warn("no calendars: Evolution Data Server didn't answer:", (e as Error).message)
            setStatus("missing")
            return
        }
        if (mine !== generation || !wanted) return
        registry = found
        registrySignals = ["source-added", "source-removed", "source-changed", "source-enabled", "source-disabled"]
            .map(signal => registry.connect(signal, resync))
        setStatus("ready")
        resync()
    })
    // a new day moves the page and the two weeks
    dayWatch = minuteNow.subscribe(() => {
        const day = minuteNow.peek().format("%F") ?? ""
        if (day === today) return
        today = day
        window = range(minuteNow.peek())
        for (const cal of calendars.values()) {
            if (!cal.client) continue
            watch(cal)
            fetch(cal)
        }
    })
}

function stop() {
    generation++
    published = ""
    dayWatch?.()
    dayWatch = null
    for (const cal of calendars.values()) drop(cal)
    calendars.clear()
    if (registry) for (const id of registrySignals) registry.disconnect(id)
    registrySignals = []
    registry = null
    if (resyncSource) GLib.source_remove(resyncSource)
    resyncSource = 0
    setEvents([])
    setStatus("off")
}

/** A widget showing events: the calendars are read while one is. */
export function wantCalendar(): () => void {
    if (wanted++ === 0) start().catch(e => {
        log.error("couldn't read the calendars:", e as Error)
        setStatus("missing")
    })
    let released = false
    return () => {
        if (released) return
        released = true
        if (--wanted === 0) stop()
    }
}

// ─── Opening ──────────────────────────────────────────────────────────────────

/** The calendar app, at an event or a day: GNOME Calendar goes straight there. */
export function openCalendar(at?: { date?: GLib.DateTime, event?: CalendarEvent }) {
    // (GNOME Calendar first, where it's there: it shows these same calendars,
    // where the default for .ics files may be a mail app with its own)
    const app = Gio.AppInfo.get_all().find(a => a.get_id() === "org.gnome.Calendar.desktop")
        ?? Gio.AppInfo.get_default_for_type("text/calendar", false)
    if (!app) {
        log.info("no calendar app to open")
        notify("No Calendar App",
            "Install GNOME Calendar to open events and dates from here.",
            { icon: "x-office-calendar-symbolic" })
        return
    }
    const exe = app.get_executable()
    if (app.get_id() === "org.gnome.Calendar.desktop" && exe) {
        const args = at?.event
            ? ["--uuid", [at.event.sourceUid, at.event.uid, at.event.rid].filter(Boolean).join(":")]
            : at?.date ? ["--date", at.date.format("%F") ?? ""] : []
        try {
            Gio.Subprocess.new([exe, ...args], Gio.SubprocessFlags.NONE)
            return
        } catch (e) {
            log.warn("couldn't start GNOME Calendar:", (e as Error).message)
        }
    }
    try {
        app.launch([], null)
    } catch (e) {
        log.warn(`couldn't open ${app.get_name()}:`, (e as Error).message)
    }
}
