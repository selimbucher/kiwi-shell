import GLib from "gi://GLib"
import Soup from "gi://Soup?version=3.0"

// ─── Places ───────────────────────────────────────────────────────────────────
// Where things are, for the weather, Night Shift's sunset and the world
// clock: a city looked up by name at Open-Meteo (free, no account; only the
// name typed is sent), and the cities tzdata knows, with their coordinates
// and zones, read from its own table without asking anyone.

export type Place = { name: string; latitude: number; longitude: number }

const session = new Soup.Session({ user_agent: "kiwi-shell", timeout: 20 })

export function getJson(url: string): Promise<any> {
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

// ─── By name ──────────────────────────────────────────────────────────────────

// (its time zone too: Europe/Zurich)
export type Found = Place & { region: string; country: string; code: string; timezone: string }
const places = new Map<string, Place>()

/** The places of that name (or starting so), the likeliest first. */
export async function searchPlaces(name: string, count = 10): Promise<Found[]> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=${count}&format=json&language=en&name=${encodeURIComponent(name.trim())}`
    const results: any[] = (await getJson(url)).results ?? []
    return results.map(r => ({
        name: r.name, latitude: r.latitude, longitude: r.longitude,
        region: r.admin1 ?? "", country: r.country ?? "", code: r.country_code ?? "", timezone: r.timezone ?? "",
    }))
}

// "Zurich", "Zurich, Switzerland" (or "Zurich, CH"), "Buchs, St. Gallen,
// Switzerland": the first place of that name in the region and country named
export async function placeOf(city: string): Promise<Place | null> {
    const known = places.get(city)
    if (known) return known
    const [name, ...where] = city.split(",").map(s => s.trim())
    const wanted = where.map(w => w.toLowerCase()).filter(Boolean)
    const found = (await searchPlaces(name)).find(r => wanted.every(w =>
        r.country.toLowerCase() === w || r.code.toLowerCase() === w || r.region.toLowerCase() === w)) ?? null
    if (!found) return null
    const place = { name: found.name, latitude: found.latitude, longitude: found.longitude }
    places.set(city, place)
    return place
}

// ─── tzdata's cities ──────────────────────────────────────────────────────────

export type Zone = Place & { zone: string; code: string }

// "+4723+00832" (±DDMM±DDDMM, or with seconds) as degrees
function coordinates(text: string): [number, number] | null {
    const m = text.match(/^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/)
    if (!m) return null
    const degrees = (sign: string, d: string, min: string, s?: string) =>
        (sign === "-" ? -1 : 1) * (Number(d) + Number(min) / 60 + Number(s ?? 0) / 3600)
    return [degrees(m[1], m[2], m[3], m[4]), degrees(m[5], m[6], m[7], m[8])]
}

/** "Europe/Zurich" as a place's name: Zurich. */
export const zoneCity = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ")

// (a path where the zone came from /etc/localtime: /etc/zoneinfo/Europe/Zurich)
const localId = () => GLib.TimeZone.new_local().get_identifier().replace(/^:/, "")

/** The local time zone's name: Europe/Zurich. */
export const localZone = () => localId().replace(/^.*zoneinfo\//, "")

// where tzdata is: the local zone's folder, TZDIR, the usual places
const zoneDirs = () => [localId().match(/^(.*zoneinfo)\//)?.[1], GLib.getenv("TZDIR"), "/usr/share/zoneinfo", "/etc/zoneinfo"]
    .filter((d): d is string => !!d && GLib.file_test(d, GLib.FileTest.IS_DIR))

const timeZones = new Map<string, GLib.TimeZone | null>()

/**
 * A zone by its name (Asia/Tokyo). GLib looks for it where most systems keep
 * tzdata, and finds nothing where it's elsewhere (NixOS: /etc/zoneinfo,
 * TZDIR unset), so it's asked by its file there too.
 */
export function timeZone(zone: string): GLib.TimeZone | null {
    if (timeZones.has(zone)) return timeZones.get(zone)!
    let found: GLib.TimeZone | null = null
    if (/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
        found = GLib.TimeZone.new_identifier(zone)
        for (const dir of zoneDirs()) {
            if (found) break
            if (GLib.file_test(`${dir}/${zone}`, GLib.FileTest.IS_REGULAR)) found = GLib.TimeZone.new_identifier(`${dir}/${zone}`)
        }
    }
    timeZones.set(zone, found)
    return found
}

let zoneList: Zone[] | null = null

/** Every zone tzdata names a city for, with where that city is. */
export function zones(): Zone[] {
    if (zoneList) return zoneList
    const dirs = zoneDirs()
    const found = new Map<string, Zone>()
    // (zone.tab too: zones merged into another, Europe/Amsterdam into
    // Brussels, are only there)
    for (const dir of dirs) {
        for (const file of ["zone1970.tab", "zone.tab"]) {
            try {
                const table = new TextDecoder().decode(GLib.file_get_contents(`${dir}/${file}`)[1])
                for (const line of table.split("\n")) {
                    if (line.startsWith("#")) continue
                    const [codes, at, zone] = line.split("\t")
                    const where = at && coordinates(at)
                    if (!zone || !where || found.has(zone)) continue
                    found.set(zone, { zone, name: zoneCity(zone), latitude: where[0], longitude: where[1], code: codes.split(",")[0] })
                }
            } catch { /* not here */ }
        }
        if (found.size) break
    }
    zoneList = [...found.values()]
    return zoneList
}

/** The local time zone's own city (Europe/Zurich: Zurich), where it has one. */
export function timeZonePlace(): Place | null {
    const zone = localZone()
    const found = zones().find(z => z.zone === zone)
    return found ? { name: found.name, latitude: found.latitude, longitude: found.longitude } : null
}
