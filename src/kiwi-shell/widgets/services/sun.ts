import GLib from "gi://GLib"
import { createState } from "ags"

import { logger } from "../../log"
import { conf } from "../config"
import { placeOf, type Place } from "./weather"
import { minuteNow } from "./minuteClock"

const log = logger("sun")

// ─── Sunset and sunrise ───────────────────────────────────────────────────────
// Where the sun sets and rises for Night Shift's "Sunset to Sunrise", as on a
// Mac, without asking anyone where the computer is: the island's weather city
// when one is set (looked up once, kept for the starts without a network),
// else the city the time zone is named for, from tzdata's own table. The
// times themselves are worked out here (NOAA's solar equations), for today.

const STATE_FILE = `${GLib.get_user_state_dir()}/kiwi-shell/place.json`

function savedPlace(city: string): Place | null {
    try {
        const saved = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(STATE_FILE)[1]))
        return saved.city === city && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude) ? saved : null
    } catch {
        return null
    }
}

function savePlace(city: string, place: Place) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o755)
        GLib.file_set_contents(STATE_FILE, JSON.stringify({ city, ...place }))
    } catch (e) {
        log.warn("couldn't keep the place:", e as Error)
    }
}

// "+4723+00832" (±DDMM±DDDMM, or with seconds) as degrees
function coordinates(text: string): [number, number] | null {
    const m = text.match(/^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/)
    if (!m) return null
    const degrees = (sign: string, d: string, min: string, s?: string) =>
        (sign === "-" ? -1 : 1) * (Number(d) + Number(min) / 60 + Number(s ?? 0) / 3600)
    return [degrees(m[1], m[2], m[3], m[4]), degrees(m[5], m[6], m[7], m[8])]
}

// the time zone's own city (Europe/Zurich: Zurich)
function timeZonePlace(): Place | null {
    // (a path where the zone came from /etc/localtime: /etc/zoneinfo/Europe/Zurich)
    const id = GLib.TimeZone.new_local().get_identifier().replace(/^:/, "")
    const zone = id.replace(/^.*zoneinfo\//, "")
    const dirs = [id.match(/^(.*zoneinfo)\//)?.[1], GLib.getenv("TZDIR"), "/usr/share/zoneinfo", "/etc/zoneinfo"]
        .filter(Boolean) as string[]
    // (zone.tab too: zones merged into another, Europe/Amsterdam into
    // Brussels, are only there)
    for (const dir of dirs) for (const file of ["zone1970.tab", "zone.tab"]) {
        try {
            const table = new TextDecoder().decode(GLib.file_get_contents(`${dir}/${file}`)[1])
            for (const line of table.split("\n")) {
                const [, at, name] = line.split("\t")
                if (name !== zone) continue
                const found = coordinates(at)
                if (found) return { name: zone, latitude: found[0], longitude: found[1] }
            }
        } catch { /* not here */ }
    }
    return null
}

const [place, setPlace] = createState<Place | null>(null)

async function findPlace() {
    const city = (conf().island?.weather_city ?? "").trim()
    if (city) {
        const saved = savedPlace(city)
        if (saved) return setPlace(saved)
        try {
            const found = await placeOf(city)
            if (found) {
                savePlace(city, found)
                return setPlace(found)
            }
        } catch (e) {
            log.debug(`couldn't look ${city} up:`, e as Error)
        }
    }
    setPlace(timeZonePlace())
}

/**
 * Today's sunrise and sunset where the computer is, in minutes after
 * midnight (local time); "day" or "night" for a sun that doesn't set or rise
 * today, null where no place is known.
 */
export type SunTimes = { sunrise: number, sunset: number } | "day" | "night" | null

function sunTimes(day: GLib.DateTime, at: Place): SunTimes {
    const rad = Math.PI / 180
    const gamma = 2 * Math.PI / 365 * (day.get_day_of_year() - 1)
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
        - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
        - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
        - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
    const lat = at.latitude * rad
    // the sun's centre 0.833° below the horizon: refraction and its radius
    const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl)
    if (cosHa < -1) return "day"
    if (cosHa > 1) return "night"
    const ha = Math.acos(cosHa) / rad
    const offset = Number(day.get_utc_offset()) / 60e6
    const local = (utcMinutes: number) => ((utcMinutes + offset) % 1440 + 1440) % 1440
    return {
        sunrise: Math.round(local(720 - 4 * (at.longitude + ha) - eqtime)),
        sunset: Math.round(local(720 - 4 * (at.longitude - ha) - eqtime)),
    }
}

const [sun, setSun] = createState<SunTimes>(null)
export { sun }

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

let forDay = ""
const reckon = () => {
    const now = minuteNow.peek()
    const at = place.peek()
    forDay = now.format("%F") ?? ""
    const times = at ? sunTimes(now, at) : null
    if (at) log.info(`${at.name}: ${typeof times === "object" && times ? `sunset ${hhmm(times.sunset)}, sunrise ${hhmm(times.sunrise)}` : `${times} all day`}`)
    setSun(times)
}
place.subscribe(reckon)
// a new day, a new sunset
minuteNow.subscribe(() => { if (place.peek() && minuteNow.peek().format("%F") !== forDay) reckon() })

// looked for only while Night Shift follows the sun
let lastCity: string | null = null
const follow = () => {
    const c = conf()
    if (!c.auto_nightshift || c.nightshift_schedule !== "sunset") return
    const city = c.island?.weather_city ?? ""
    if (city === lastCity) return
    lastCity = city
    void findPlace()
}
conf.subscribe(follow)
follow()
