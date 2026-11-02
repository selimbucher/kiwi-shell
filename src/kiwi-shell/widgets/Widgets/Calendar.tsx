import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import { With, createComputed, createState, onCleanup, type Accessor } from "ags"

import { calendarEvents, calendarStatus, firstWeekday, openCalendar, type CalendarEvent, type CalendarStatus } from "../services/calendar"
import { clockTime, minuteNow } from "../services/minuteClock"
import { centerOpen, closeCenter } from "../Notifications/store"
import type { WidgetSpec } from "./model"
import { onClick, setMenu, shownMinute, whileOpen } from "./util"
import { canvas, circle as drawCircle, rgba, text } from "./draw"

// ─── Calendar widgets ─────────────────────────────────────────────────────────
// Up Next: today's date and what's coming, today first, then the next days.
// Month: the month's page, a dot under the days with something on; at the
// medium and large size a day clicked shows its events beside or below it.
// An event clicked opens it in the calendar app, the date opens the app on
// that day.

const DAY = 86400

const at = (unix: number) => GLib.DateTime.new_from_unix_local(unix)
const midnight = (t: GLib.DateTime) => GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(), 0, 0, 0)

/** The events on a day, all-day ones first. */
function eventsOn(events: CalendarEvent[], day: GLib.DateTime): CalendarEvent[] {
    // (to the next midnight: a day is 23 or 25 hours when the clocks change)
    const from = day.to_unix(), to = day.add_days(1)!.to_unix()
    return events
        .filter(e => e.start < to && (e.end > from || (e.end === e.start && e.start >= from)))
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
}

type Group = { day: GLib.DateTime, offset: number, events: CalendarEvent[] }

/** What's still to come, by day, over the next `days` days. */
function upcoming(events: CalendarEvent[], now: GLib.DateTime, days: number): Group[] {
    const groups: Group[] = []
    const today = midnight(now)
    for (let i = 0; i < days; i++) {
        const day = today.add_days(i)!
        const list = eventsOn(events, day).filter(e => i > 0 || e.allDay || e.end > now.to_unix())
        if (list.length) groups.push({ day, offset: i, events: list })
    }
    return groups
}

const dayName = (day: GLib.DateTime, offset: number) =>
    offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : day.format("%A %-e") ?? ""

function timeText(e: CalendarEvent, day: GLib.DateTime): string {
    if (e.allDay) return "All Day"
    const from = day.to_unix(), to = day.add_days(1)!.to_unix()
    const start = e.start >= from ? clockTime(at(e.start)) : null
    const end = e.end <= to ? clockTime(at(e.end)) : null
    if (start && end) return e.end === e.start ? start : `${start}–${end}`
    if (start) return `From ${start}`
    if (end) return `Until ${end}`
    return "All Day"
}

/** How long till today's next event, or that one is on. */
function countdown(events: CalendarEvent[], now: GLib.DateTime): string {
    const t = now.to_unix()
    const today = eventsOn(events, midnight(now)).filter(e => !e.allDay && e.end > t)
    const next = today[0]
    if (!next) return ""
    if (next.start <= t) return `Now: ends in ${span(next.end - t)}`
    return `Next in ${span(next.start - t)}`
}

// (a number kept with its unit where the line wraps)
function span(seconds: number): string {
    const minutes = Math.max(1, Math.round(seconds / 60))
    if (minutes < 60) return `${minutes}\u00a0min`
    const h = Math.floor(minutes / 60), m = minutes % 60
    return m ? `${h}\u00a0h ${m}\u00a0min` : `${h}\u00a0h`
}

// A class per calendar colour in one style sheet, not a style sheet per
// event: each of those was its own provider, and every one of them slowed
// down the styling of the whole column.
const colorClasses = new Map<string, string>()
let colorCss: Gtk.CssProvider | null = null

function colorClass(color: string): string {
    const c = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#8e8e93"
    let name = colorClasses.get(c)
    if (name) return name
    name = `cal-color-${c.slice(1)}`
    colorClasses.set(c, name)
    if (!colorCss) {
        colorCss = new Gtk.CssProvider()
        // (over the shell's own sheet and the GTK base it lays at USER)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, colorCss, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
    }
    colorCss.load_from_string([...colorClasses].map(([c, n]) => [
        `.cal-event.${n} { background-color: alpha(${c}, 0.2); }`,
        `.cal-event.now.${n} { background-color: alpha(${c}, 0.32); }`,
        `.${n} .cal-bar, .cal-line-dot.${n} { background-color: ${c}; }`,
        `.${n} .cal-title { color: mix(${c}, white, 0.72); }`,
    ].join("\n")).join("\n"))
    return name
}

const open = (how: Parameters<typeof openCalendar>[0]) => {
    openCalendar(how)
    closeCenter()
}

const openItem = () => [{ label: "Open Calendar", icon: "x-office-calendar-symbolic", onClick: () => open({}) }]

// ─── Pieces ───────────────────────────────────────────────────────────────────

function DateHead({ now, big = true }: { now: GLib.DateTime, big?: boolean }) {
    return (
        <box class="cal-head" orientation={Gtk.Orientation.VERTICAL} halign={Gtk.Align.START}>
            <label class="cal-weekday" label={(now.format("%A") ?? "").toUpperCase()} xalign={0} />
            <label class={big ? "cal-date" : "cal-date compact"} label={String(now.get_day_of_month())} xalign={0} />
        </box>
    )
}

function EventRow({ event, day, now }: { event: CalendarEvent, day: GLib.DateTime, now: number }) {
    const ongoing = !event.allDay && event.start <= now && event.end > now
    return (
        <button
            class={`cal-event ${colorClass(event.color)}${ongoing ? " now" : ""}`}
            tooltipText={[event.summary, event.location, event.calendar].filter(Boolean).join("\n")}
            onClicked={() => open({ event })}
        >
            <box spacing={6}>
                <box class="cal-bar" />
                <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                    <label class="cal-title" label={event.summary || "No Title"} xalign={0}
                        ellipsize={Pango.EllipsizeMode.END} />
                    <label class="cal-time" label={timeText(event, day)} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                </box>
                {event.meeting
                    ? <button class="cal-join" valign={Gtk.Align.CENTER} tooltipText="Join the call"
                        onClicked={() => {
                            try {
                                Gio.AppInfo.launch_default_for_uri(event.meeting!, null)
                            } catch { /* no browser */ }
                            closeCenter()
                        }}>
                        <Gtk.Image iconName="camera-video-symbolic" pixelSize={12} />
                    </button>
                    : <box />}
            </box>
        </button>
    )
}

// as many rows as there's room for, the rest counted (`header`: what a
// day's name costs of a row; `more`: whether the rest are counted at all)
function EventList({ groups, now, rows, headers, header: headerCost = 1, more = true }: {
    groups: Group[], now: GLib.DateTime, rows: number, headers: "all" | "later" | "none", header?: number, more?: boolean
}) {
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, cssClasses: ["cal-list"] })
    let left = rows
    let hidden = 0
    for (const group of groups) {
        const header = headers === "all" || (headers === "later" && group.offset > 0)
        if (left < (header ? 1 + headerCost : 1)) {
            hidden += group.events.length
            continue
        }
        if (header) {
            list.append(<label class="cal-day" label={dayName(group.day, group.offset).toUpperCase()} xalign={0} /> as Gtk.Widget)
            left -= headerCost
        }
        for (const event of group.events) {
            if (left <= 0) {
                hidden++
                continue
            }
            list.append(<EventRow event={event} day={group.day} now={now.to_unix()} /> as Gtk.Widget)
            left--
        }
    }
    if (hidden && more) list.append(<label class="cal-more" label={`${hidden} more`} xalign={0} /> as Gtk.Widget)
    return list
}

// one line an event, for where there's less room: the large month
function EventLines({ events, day, rows }: { events: CalendarEvent[], day: GLib.DateTime, rows: number }) {
    const shown = events.length > rows ? events.slice(0, rows - 1) : events
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
            {shown.map(event => {
                return (
                    <button class="cal-line" onClicked={() => open({ event })}
                        tooltipText={[event.summary, event.location, event.calendar].filter(Boolean).join("\n")}>
                        <box spacing={7}>
                            <box class={`cal-line-dot ${colorClass(event.color)}`} valign={Gtk.Align.CENTER} />
                            <label class="cal-line-title" label={event.summary || "No Title"} xalign={0} hexpand
                                ellipsize={Pango.EllipsizeMode.END} />
                            <label class="cal-line-time" label={timeText(event, day)} />
                        </box>
                    </button>
                )
            })}
            {events.length > shown.length ? <label class="cal-more" label={`${events.length - shown.length} more`} xalign={0} /> : <box />}
        </box>
    )
}

function Nothing({ text }: { text: string }) {
    return <label class="cal-nothing" label={text} xalign={0} valign={Gtk.Align.START} wrap />
}

// the free part of a wide widget with nothing to show: what to do about it,
// where there's no calendar to show at all
function NoEvents({ status }: { status: CalendarStatus }) {
    const missing = status === "missing"
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER} vexpand hexpand>
            <Gtk.Image class="cal-none-icon" iconName="x-office-calendar-symbolic" pixelSize={22} />
            <label class="cal-none" label={missing ? "No Calendars" : "No Events"} />
            <label class="cal-none-hint" justify={Gtk.Justification.CENTER} wrap maxWidthChars={26}
                label={missing ? "Calendars come from Evolution Data Server, as GNOME Calendar's do."
                    : "Nothing in the next days."} />
        </box>
    )
}

// ─── Up Next ──────────────────────────────────────────────────────────────────

export function UpNext({ spec }: { spec: Accessor<WidgetSpec> }) {
    const size = spec.peek().size
    const events = whileOpen(calendarEvents)
    const shown = createComputed(get => ({ now: get(shownMinute), events: get(events), status: get(calendarStatus) }))
    return (
        <box class="cal up-next" hexpand vexpand $={(self: Gtk.Box) => {
            onClick(self, () => open({ date: minuteNow.peek() }))
            setMenu(self, openItem)
        }}>
            <With value={shown}>
                {({ now, events, status }: { now: GLib.DateTime, events: CalendarEvent[], status: CalendarStatus }) => {
                    const groups = upcoming(events, now, size === "large" ? 14 : 7)
                    const none = size !== "small" ? <NoEvents status={status} />
                        : <Nothing text={status === "missing" ? "No Calendars" : "No events in the next days"} />
                    if (size === "small") {
                        // the next two events, a later day's under its name (a
                        // name is half the height of an event)
                        return (
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand>
                                <DateHead now={now} big={groups.length === 0} />
                                {groups.length ? <EventList groups={groups} now={now} rows={2.5} headers="later" header={0.5} more={false} /> : none}
                            </box>
                        )
                    }
                    if (size === "medium") {
                        return (
                            <box spacing={14} hexpand>
                                <box orientation={Gtk.Orientation.VERTICAL} widthRequest={86}>
                                    <DateHead now={now} />
                                    <box vexpand />
                                    {/* (wrapped in the column, not widening it) */}
                                    <label class="cal-countdown" label={countdown(events, now)} xalign={0} wrap
                                        maxWidthChars={8} visible={!!countdown(events, now)} />
                                </box>
                                <box hexpand valign={groups.length ? Gtk.Align.START : Gtk.Align.FILL}>
                                    {groups.length ? <EventList groups={groups} now={now} rows={4} headers="later" /> : none}
                                </box>
                            </box>
                        )
                    }
                    return (
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} hexpand>
                            <DateHead now={now} />
                            {groups.length ? <EventList groups={groups} now={now} rows={8} headers="all" /> : none}
                        </box>
                    )
                }}
            </With>
        </box>
    )
}

// ─── Month ────────────────────────────────────────────────────────────────────

// Drawn, not built: a month of buttons was some 170 widgets, and Notification
// Center opened in twice the time for them. The day under a click is worked
// out from where it landed; the hovered one lights up.
function MonthGrid({ now, events, selected, onSelect, large }: {
    now: GLib.DateTime
    events: CalendarEvent[]
    selected: Accessor<GLib.DateTime | null> | null
    onSelect: ((day: GLib.DateTime) => void) | null
    large: boolean
}) {
    const first = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0)
    const lead = (first.get_day_of_week() - firstWeekday() + 7) % 7
    const days = GLib.Date.get_days_in_month(now.get_month() as GLib.DateMonth, now.get_year())
    const weeks = Math.ceil((lead + days) / 7)
    const busy = new Set<number>()
    for (let d = 1; d <= days; d++) if (eventsOn(events, first.add_days(d - 1)!).length) busy.add(d)
    const letters = Array.from({ length: 7 }, (_, col) => {
        const name = (first.add_days(col - lead)!.format("%a") ?? "").slice(0, large ? 3 : 1)
        return large ? name : name.toUpperCase()
    })
    const head = large ? 20 : 14, row = large ? 30 : 18, circle = large ? 24 : 16
    const today = now.get_month() === first.get_month() ? now.get_day_of_month() : 0
    const pickedDay = () => {
        const s = selected?.peek()
        return s && s.get_month() === first.get_month() && s.get_year() === first.get_year() ? s.get_day_of_month() : today
    }
    let hovered = 0

    const cell = (w: number, x: number, y: number) => {
        const col = Math.floor(x / (w / 7)), r = Math.floor((y - head) / row)
        const d = r * 7 + col - lead + 1
        return y >= head && r < weeks && d >= 1 && d <= days ? d : 0
    }
    // (a day's width at least: the events beside it don't squeeze it)
    const area = canvas(7 * (circle + 3), head + weeks * row, (self, snapshot, w) => {
        const fg = self.get_color()
        const ink = (alpha: number) => rgba(fg.red, fg.green, fg.blue, alpha)
        const colWidth = w / 7
        const picked = pickedDay()
        letters.forEach((l, col) => text(self, snapshot, l, colWidth * (col + 0.5), head / 2, large ? 10 : 9, 700, ink(0.66)))
        for (let d = 1; d <= days; d++) {
            const i = d - 1 + lead
            const cx = colWidth * (i % 7 + 0.5)
            const cy = head + row * Math.floor(i / 7) + (large ? row / 2 - 2 : circle / 2)
            const fill = d === today ? rgba(1, 0.27, 0.23) : d === picked ? ink(0.22) : d === hovered ? ink(0.14) : null
            if (fill) drawCircle(snapshot, cx, cy, circle / 2, fill)
            text(self, snapshot, String(d), cx, cy, large ? 12 : 10, 600, d === today ? rgba(1, 1, 1) : ink(1))
            if (busy.has(d)) drawCircle(snapshot, cx, cy + circle / 2 + (large ? 3 : 1.5), large ? 2 : 1.5, ink(0.45))
        }
    }, { cssClasses: ["cal-grid"], hexpand: true, vexpand: true, valign: Gtk.Align.CENTER })
    if (selected) onCleanup(selected.subscribe(() => area.queue_draw()))
    if (onSelect) {
        area.set_cursor_from_name("pointer")
        const motion = new Gtk.EventControllerMotion()
        const hover = (d: number) => {
            if (d === hovered) return
            hovered = d
            area.queue_draw()
        }
        motion.connect("motion", (_m, x, y) => hover(cell(area.get_width(), x, y)))
        motion.connect("leave", () => hover(0))
        area.add_controller(motion)
        const click = new Gtk.GestureClick()
        click.connect("pressed", (_g, n, x, y) => {
            const d = cell(area.get_width(), x, y)
            if (!d) return
            // twice: the app on that day
            if (n === 2) open({ date: first.add_days(d - 1)! })
            else onSelect(first.add_days(d - 1)!)
        })
        area.add_controller(click)
    }
    return area
}

export function Month({ spec }: { spec: Accessor<WidgetSpec> }) {
    const size = spec.peek().size
    const [selected, setSelected] = createState<GLib.DateTime | null>(null)
    // (today again at each opening: the widget is kept between them)
    onCleanup(centerOpen.subscribe(() => { if (centerOpen.peek()) setSelected(null) }))
    const events = whileOpen(calendarEvents)
    const shown = createComputed(get => ({ now: get(shownMinute), events: get(events) }))
    return (
        <box class={`cal month ${size}`} hexpand vexpand
            $={(self: Gtk.Box) => {
                if (size === "small") onClick(self, () => open({ date: minuteNow.peek() }))
                setMenu(self, openItem)
            }}>
            <With value={shown}>
                {({ now, events }: { now: GLib.DateTime, events: CalendarEvent[] }) => {
                    const monthName = (now.format("%B") ?? "").toUpperCase()
                    if (size === "small") {
                        return (
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                                <label class="cal-month" label={monthName} xalign={0} />
                                <MonthGrid now={now} events={events} selected={null} onSelect={null} large={false} />
                            </box>
                        )
                    }
                    // the day picked this month, else today
                    const dayOf = (picked: GLib.DateTime | null) =>
                        picked && picked.get_month() === now.get_month() ? picked : midnight(now)
                    const dayEvents = (
                        <box hexpand>
                            <With value={selected}>
                                {(picked: GLib.DateTime | null) => {
                                    const day = dayOf(picked)
                                    const offset = Math.round((midnight(day).to_unix() - midnight(now).to_unix()) / DAY)
                                    const list = eventsOn(events, day)
                                        .filter(e => offset !== 0 || e.allDay || e.end > now.to_unix())
                                    const label = offset === 0 ? "Today" : offset === 1 ? "Tomorrow"
                                        : offset === -1 ? "Yesterday" : day.format("%A %-e") ?? ""
                                    return (
                                        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                                            <label class="cal-weekday" label={label.toUpperCase()} xalign={0} />
                                            {!list.length
                                                ? <Nothing text={offset === 0 ? "No more events today" : "No events"} />
                                                : size === "large"
                                                ? <EventLines events={list} day={day} rows={3} />
                                                : <EventList groups={[{ day, offset, events: list }]} now={now} rows={3} headers="none" />}
                                        </box>
                                    )
                                }}
                            </With>
                        </box>
                    )
                    const pick = (d: GLib.DateTime) => setSelected(d)
                    if (size === "medium") {
                        return (
                            <box spacing={12} hexpand>
                                <box widthRequest={150} hexpand={false} valign={Gtk.Align.START}>{dayEvents}</box>
                                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                                    <label class="cal-month" label={monthName} xalign={0} />
                                    <MonthGrid now={now} events={events} selected={selected} onSelect={pick} large={false} />
                                </box>
                            </box>
                        )
                    }
                    return (
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} hexpand>
                            <box>
                                <label class="cal-month large" label={now.format("%B") ?? ""} xalign={0} hexpand />
                                <label class="cal-year" label={String(now.get_year())} />
                            </box>
                            <MonthGrid now={now} events={events} selected={selected} onSelect={pick} large />
                            <Gtk.Separator class="cal-rule" />
                            {dayEvents}
                        </box>
                    )
                }}
            </With>
        </box>
    )
}
