import { createComputed, createMemo, createState, type Accessor } from "ags"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalNetwork from "gi://AstalNetwork"

import { logger } from "../../log"
import { conf } from "../config"
import { getJson, placeOf, timeZonePlace } from "./places"

const log = logger("weather")

// ─── Weather ──────────────────────────────────────────────────────────────────
// For the island's centre and the weather widgets, from Open-Meteo (free, no
// account): only a place's coordinates are ever sent. A place is a city
// typed (the widget's own, else the one in Kiwi Settings) or, with none, the
// city the time zone is named for. The island's place is fetched while the
// weather is its centre: every 30 minutes, after the machine wakes and when
// the network comes back, when the last is older than that. A widget's is
// fetched when Notification Center opens on it and it's older than 15
// minutes, never in between. The last forecasts are kept on disk, so a login
// starts with them.

const EVERY_SECONDS = 30 * 60
const STALE_US = 15 * 60 * 1e6
const STATE_FILE = `${GLib.get_user_state_dir()}/kiwi-shell/weather.json`

export type Hour = { time: string; degrees: number; code: number; day: boolean; rain?: number }
export type Day = { date: string; code: number; high: number; low: number; rain?: number }
export type Forecast = {
    city: string // as asked: typed, or "" for the time zone's city
    place: string // as Open-Meteo names it
    units: "celsius" | "fahrenheit"
    fetched: number // unix seconds
    now: { degrees: number; code: number; day: boolean; feels?: number }
    hours: Hour[]
    days: Day[]
}

// ─── Places' forecasts ────────────────────────────────────────────────────────

type Slot = {
    forecast: Accessor<Forecast | null>
    setForecast: (f: Forecast | null) => void
    problem: Accessor<string | null>
    setProblem: (p: string | null) => void
    fetching: boolean
    // asked for again while fetching (the units changed meanwhile)
    again: boolean
}

const kept: Record<string, Forecast> = load()
const slots = new Map<string, Slot>()

function load(): Record<string, Forecast> {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE)
        const saved = JSON.parse(new TextDecoder().decode(bytes))
        // (one forecast, the island's, before there were widgets)
        if (saved?.now) return { [saved.city ?? ""]: saved }
        return saved?.forecasts ?? {}
    } catch {
        return {}
    }
}

function save() {
    const forecasts: Record<string, Forecast> = {}
    for (const [asked, slot] of slots) {
        const f = slot.forecast.peek()
        if (f) forecasts[asked] = f
    }
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o755)
        GLib.file_set_contents(STATE_FILE, JSON.stringify({ forecasts }))
    } catch (e) {
        log.warn("saving the forecast:", e as Error)
    }
}

function slot(asked: string): Slot {
    let found = slots.get(asked)
    if (!found) {
        const [forecast, setForecast] = createState<Forecast | null>(kept[asked] ?? null)
        const [problem, setProblem] = createState<string | null>(null)
        found = { forecast, setForecast, problem, setProblem, fetching: false, again: false }
        slots.set(asked, found)
    }
    return found
}

// a widget's own city, else the one in the settings, else "" (the time zone's)
const askedFor = (city: string, c = conf()) => city.trim() || (c.island?.weather_city ?? "").trim()

/** The forecast for a widget's city ("" for the settings' place). */
export function weatherFor(city: string): { forecast: Accessor<Forecast | null>, problem: Accessor<string | null> } {
    const asked = createMemo(() => askedFor(city, conf()))
    return {
        forecast: createComputed(get => get(slot(get(asked)).forecast)),
        problem: createComputed(get => get(slot(get(asked)).problem)),
    }
}

/** Notification Center opening on a widget: its forecast, if it's old (and not on its way). */
export function freshen(city: string) {
    const asked = askedFor(city)
    if (!slot(asked).fetching && stale(asked)) void refresh(asked)
}

// A forecast kept from earlier (a login, a while offline) starts at the hour
// and the day it was fetched: what has gone by since is left out.

/** The forecast's hours from the current one on. */
export function hoursFrom(f: Forecast, count: number): Hour[] {
    const gone = Math.max(0, Math.floor(Date.now() / 3.6e6) - Math.floor(f.fetched / 3600))
    return f.hours.slice(gone, gone + count)
}

/** The forecast's days from today on. */
export function daysFrom(f: Forecast, count: number): Day[] {
    const then = GLib.DateTime.new_from_unix_local(f.fetched)
    const today = GLib.DateTime.new_now_local()
    const gone = Math.max(0, Math.round((
        GLib.DateTime.new_local(today.get_year(), today.get_month(), today.get_day_of_month(), 12, 0, 0).to_unix() -
        GLib.DateTime.new_local(then.get_year(), then.get_month(), then.get_day_of_month(), 12, 0, 0).to_unix()) / 86400))
    return f.days.slice(gone, gone + count)
}

// the island's
const island = weatherFor("")
export const forecast = island.forecast
export const weatherProblem = island.problem

// ─── What the codes mean ──────────────────────────────────────────────────────
// WMO weather codes, as Open-Meteo gives them, in Apple Weather's words

const CONDITIONS: [codes: number[], text: string, icon: string, night?: string][] = [
    [[0], "Clear", "weather-clear-symbolic", "weather-clear-night-symbolic"],
    [[1], "Mostly Clear", "weather-few-clouds-symbolic", "weather-few-clouds-night-symbolic"],
    [[2], "Partly Cloudy", "weather-few-clouds-symbolic", "weather-few-clouds-night-symbolic"],
    [[3], "Cloudy", "weather-overcast-symbolic"],
    [[45, 48], "Fog", "weather-fog-symbolic"],
    [[51, 53, 55], "Drizzle", "weather-showers-scattered-symbolic"],
    [[56, 57], "Freezing Drizzle", "weather-showers-scattered-symbolic"],
    [[61, 63], "Rain", "weather-showers-symbolic"],
    [[65], "Heavy Rain", "weather-showers-symbolic"],
    [[66, 67], "Freezing Rain", "weather-showers-symbolic"],
    [[71, 73, 77], "Snow", "weather-snow-symbolic"],
    [[75], "Heavy Snow", "weather-snow-symbolic"],
    [[80, 81], "Showers", "weather-showers-scattered-symbolic"],
    [[82], "Heavy Showers", "weather-showers-symbolic"],
    [[85, 86], "Snow Showers", "weather-snow-symbolic"],
    [[95], "Thunderstorms", "weather-storm-symbolic"],
    [[96, 99], "Thunderstorms and Hail", "weather-storm-symbolic"],
]

export function condition(code: number, day = true): { text: string; icon: string } {
    const found = CONDITIONS.find(([codes]) => codes.includes(code))
    if (!found) return { text: "", icon: "weather-severe-alert-symbolic" }
    const [, text, icon, night] = found
    return { text, icon: !day && night ? night : icon }
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

async function refresh(asked: string) {
    const units = conf().island.weather_units === "fahrenheit" ? "fahrenheit" : "celsius"
    const s = slot(asked)
    if (s.fetching) {
        s.again = true
        return
    }
    s.fetching = true
    try {
        const place = asked ? await placeOf(asked) : timeZonePlace()
        if (!place) {
            s.setProblem(asked ? `No place called ${asked}` : "No city set")
            return
        }
        const url = "https://api.open-meteo.com/v1/forecast" +
            `?latitude=${place.latitude}&longitude=${place.longitude}` +
            "&current=temperature_2m,apparent_temperature,weather_code,is_day" +
            "&hourly=temperature_2m,weather_code,is_day,precipitation_probability" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
            `&timezone=auto&forecast_days=6&temperature_unit=${units}`
        const data = await getJson(url)
        // the hours from the current one on, in the place's own time
        const nowHour = String(data.current.time).slice(0, 13)
        const first = Math.max(0, (data.hourly.time as string[]).findIndex(t => t.slice(0, 13) === nowHour))
        const next: Forecast = {
            city: asked, place: place.name, units, fetched: Math.floor(Date.now() / 1000),
            now: {
                degrees: data.current.temperature_2m, code: data.current.weather_code,
                day: !!data.current.is_day, feels: data.current.apparent_temperature,
            },
            hours: (data.hourly.time as string[]).slice(first, first + 24).map((time, i) => ({
                time,
                degrees: data.hourly.temperature_2m[first + i],
                code: data.hourly.weather_code[first + i],
                day: !!data.hourly.is_day[first + i],
                rain: data.hourly.precipitation_probability?.[first + i] ?? undefined,
            })),
            days: (data.daily.time as string[]).map((date, i) => ({
                date,
                code: data.daily.weather_code[i],
                high: data.daily.temperature_2m_max[i],
                low: data.daily.temperature_2m_min[i],
                rain: data.daily.precipitation_probability_max?.[i] ?? undefined,
            })),
        }
        s.setForecast(next)
        s.setProblem(null)
        save()
        log.info(`forecast for ${place.name}: ${next.now.degrees}°, code ${next.now.code}`)
    } catch (e) {
        // the last forecast stays up; the next try is the next timer, wake-up,
        // network change or opening
        log.warn(`fetching the forecast for ${asked || "the time zone's city"}:`, e as Error)
        s.setProblem(s.forecast.peek() ? null : "Weather unavailable")
    } finally {
        s.fetching = false
        if (s.again) {
            s.again = false
            void refresh(asked)
        }
    }
}

const stale = (asked: string) => {
    const f = slot(asked).forecast.peek()
    return !f || f.units !== (conf().island.weather_units === "fahrenheit" ? "fahrenheit" : "celsius")
        || Date.now() * 1000 - f.fetched * 1e6 > STALE_US
}

const islandAsked = () => askedFor("")

// ─── When ─────────────────────────────────────────────────────────────────────

let timer = 0
let subscriptions: (() => void)[] = []

function start() {
    if (timer) return
    if (stale(islandAsked())) void refresh(islandAsked())
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVERY_SECONDS, () => {
        void refresh(islandAsked())
        return GLib.SOURCE_CONTINUE
    })
    let sleep = 0
    try {
        sleep = Gio.DBus.system.signal_subscribe(
            "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep",
            "/org/freedesktop/login1", null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [goingToSleep] = params.deepUnpack() as [boolean]
                if (!goingToSleep && stale(islandAsked())) void refresh(islandAsked())
            })
    } catch { /* no system bus: the timer and the network are enough */ }
    const network = AstalNetwork.get_default()
    const online = network.connect("notify::connectivity", () => {
        if (network.connectivity === AstalNetwork.Connectivity.FULL && stale(islandAsked())) void refresh(islandAsked())
    })
    subscriptions = [
        () => { if (sleep) Gio.DBus.system.signal_unsubscribe(sleep) },
        () => network.disconnect(online),
    ]
}

function stop() {
    if (timer) GLib.source_remove(timer)
    timer = 0
    subscriptions.forEach(s => s())
    subscriptions = []
}

const wanted = createMemo(() => conf().island.center === "weather")
const settings = createMemo(() => `${conf().island.weather_city}|${conf().island.weather_units}`)
wanted.subscribe(() => wanted() ? start() : stop())
settings.subscribe(() => {
    if (!wanted()) return
    slot(islandAsked()).setProblem(null)
    void refresh(islandAsked())
})
if (wanted()) start()
