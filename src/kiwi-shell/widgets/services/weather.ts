import { createMemo, createState } from "ags"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Soup from "gi://Soup?version=3.0"
import AstalNetwork from "gi://AstalNetwork"

import { logger } from "../../log"
import { conf } from "../config"

const log = logger("weather")

// ─── Weather ──────────────────────────────────────────────────────────────────
// For the island's centre, from Open-Meteo (free, no account), for the city
// set in the settings: only its coordinates are ever sent. It's fetched only
// while the weather is the centre: then, every 30 minutes, after the
// machine wakes and when the network comes back, when the last is older than
// that. The last forecast is kept on disk, so a login starts with it.

const EVERY_SECONDS = 30 * 60
const STALE_US = 15 * 60 * 1e6
const STATE_FILE = `${GLib.get_user_state_dir()}/kiwi-shell/weather.json`

export type Hour = { time: string; degrees: number; code: number; day: boolean }
export type Day = { date: string; code: number; high: number; low: number }
export type Forecast = {
    city: string // as the settings have it
    place: string // as Open-Meteo names it
    units: "celsius" | "fahrenheit"
    fetched: number // unix seconds
    now: { degrees: number; code: number; day: boolean }
    hours: Hour[]
    days: Day[]
}

const [forecast, setForecast] = createState<Forecast | null>(load())
const [problem, setProblem] = createState<string | null>(null)
export { forecast, problem as weatherProblem }

function load(): Forecast | null {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE)
        return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
        return null
    }
}

function save(f: Forecast) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o755)
        GLib.file_set_contents(STATE_FILE, JSON.stringify(f))
    } catch (e) {
        log.warn("saving the forecast:", e as Error)
    }
}

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

const session = new Soup.Session({ user_agent: "kiwi-shell", timeout: 20 })

function getJson(url: string): Promise<any> {
    const message = Soup.Message.new("GET", url)
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            try {
                const bytes = session.send_and_read_finish(result)
                const status = message.get_status()
                if (status !== Soup.Status.OK) throw new Error(`HTTP ${status}`)
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())))
            } catch (e) {
                reject(e)
            }
        })
    })
}

type Place = { name: string; latitude: number; longitude: number }
const places = new Map<string, Place>()

// "Zurich" or "Zurich, Switzerland" (or "Zurich, CH"): the first place of
// that name, in that country when one is named
async function placeOf(city: string): Promise<Place | null> {
    const known = places.get(city)
    if (known) return known
    const [name, country] = city.split(",").map(s => s.trim())
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=10&format=json&language=en&name=${encodeURIComponent(name)}`
    const results: any[] = (await getJson(url)).results ?? []
    const wanted = country?.toLowerCase()
    const found = results.find(r => !wanted
        || r.country?.toLowerCase() === wanted || r.country_code?.toLowerCase() === wanted
        || r.admin1?.toLowerCase() === wanted) ?? null
    if (!found) return null
    const place = { name: found.name, latitude: found.latitude, longitude: found.longitude }
    places.set(city, place)
    return place
}

let fetching = false
// asked for again while fetching (the city or units changed meanwhile)
let again = false

async function refresh() {
    const { weather_city: city, weather_units: units } = conf().island
    if (!city?.trim()) {
        setProblem("No city set")
        return
    }
    if (fetching) {
        again = true
        return
    }
    fetching = true
    try {
        const place = await placeOf(city.trim())
        if (!place) {
            setProblem(`No place called ${city}`)
            return
        }
        const unit = units === "fahrenheit" ? "fahrenheit" : "celsius"
        const url = "https://api.open-meteo.com/v1/forecast" +
            `?latitude=${place.latitude}&longitude=${place.longitude}` +
            "&current=temperature_2m,weather_code,is_day" +
            "&hourly=temperature_2m,weather_code,is_day" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
            `&timezone=auto&forecast_days=6&temperature_unit=${unit}`
        const data = await getJson(url)
        // the hours from the current one on, in the place's own time
        const nowHour = String(data.current.time).slice(0, 13)
        const first = Math.max(0, (data.hourly.time as string[]).findIndex(t => t.slice(0, 13) === nowHour))
        const next: Forecast = {
            city, place: place.name, units: unit, fetched: Math.floor(Date.now() / 1000),
            now: { degrees: data.current.temperature_2m, code: data.current.weather_code, day: !!data.current.is_day },
            hours: (data.hourly.time as string[]).slice(first, first + 6).map((time, i) => ({
                time,
                degrees: data.hourly.temperature_2m[first + i],
                code: data.hourly.weather_code[first + i],
                day: !!data.hourly.is_day[first + i],
            })),
            days: (data.daily.time as string[]).map((date, i) => ({
                date,
                code: data.daily.weather_code[i],
                high: data.daily.temperature_2m_max[i],
                low: data.daily.temperature_2m_min[i],
            })),
        }
        setForecast(next)
        setProblem(null)
        save(next)
        log.info(`forecast for ${place.name}: ${next.now.degrees}°, code ${next.now.code}`)
    } catch (e) {
        // the last forecast stays up; the next try is the next timer, wake-up
        // or network change
        log.warn(`fetching the forecast for ${city}:`, e as Error)
        setProblem(forecast() ? null : "Weather unavailable")
    } finally {
        fetching = false
        // the one asked for meanwhile, for what is set now
        if (again) {
            again = false
            void refresh()
        }
    }
}

const stale = () => {
    const f = forecast()
    const { weather_city, weather_units } = conf().island
    return !f || f.city !== weather_city || f.units !== weather_units
        || Date.now() * 1000 - f.fetched * 1e6 > STALE_US
}

// ─── When ─────────────────────────────────────────────────────────────────────

let timer = 0
let subscriptions: (() => void)[] = []

function start() {
    if (timer) return
    if (stale()) void refresh()
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVERY_SECONDS, () => {
        void refresh()
        return GLib.SOURCE_CONTINUE
    })
    let sleep = 0
    try {
        sleep = Gio.DBus.system.signal_subscribe(
            "org.freedesktop.login1", "org.freedesktop.login1.Manager", "PrepareForSleep",
            "/org/freedesktop/login1", null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [goingToSleep] = params.deepUnpack() as [boolean]
                if (!goingToSleep && stale()) void refresh()
            })
    } catch { /* no system bus: the timer and the network are enough */ }
    const network = AstalNetwork.get_default()
    const online = network.connect("notify::connectivity", () => {
        if (network.connectivity === AstalNetwork.Connectivity.FULL && stale()) void refresh()
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
    setProblem(null)
    void refresh()
})
if (wanted()) start()
