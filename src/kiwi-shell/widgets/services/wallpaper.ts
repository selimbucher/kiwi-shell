import { createState } from "ags"
import { execAsync } from "ags/process"
import { Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Hyprland from "gi://AstalHyprland"

import { conf, ROOT } from "../config"
import { logger } from "../../log"
const log = logger("wallpaper")

const HOME = GLib.get_home_dir()
// the wallpapers kiwi-shell ships, see assets/wallpapers/CREDITS.md
const INCLUDED_WALLPAPERS = `${ROOT}/assets/wallpapers`
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"]

export const [wallpaperPath, storeWallpaperPath] = createState<string | null>(null)

// What awww shows on each display: the image, or null for a plain colour
// (nothing set yet, or an image it could not load).
async function queryShown(): Promise<Map<string, string | null>> {
    const namespaces = JSON.parse(await execAsync(["awww", "query", "--json"]))
    return new Map((namespaces[""] ?? []).map((display: any) =>
        [String(display.name), typeof display.displaying?.image === "string" ? display.displaying.image : null]))
}

const firstShown = (shown: Map<string, string | null>) => [...shown.values()].find(image => image) ?? null

// A picture with an included wallpaper's file name (they carry the Unsplash
// photo id) is that wallpaper: a copy in ~/Pictures, or the included one from
// before an update. Treat it as the included one, so it isn't listed twice.
function sameIncluded(path: string): string {
    const included = `${INCLUDED_WALLPAPERS}/${GLib.path_get_basename(path)}`
    return GLib.file_test(included, GLib.FileTest.EXISTS) ? included : path
}

// Picks up changes made elsewhere (kiwi-settings, a terminal).
export function refreshWallpaper() {
    queryShown()
        .then(shown => {
            const image = firstShown(shown)
            const path = image ? sameIncluded(image) : null
            if (!path || path === wallpaperPath.get()) return
            log.debug(`the wallpaper is now ${path}`)
            storeWallpaperPath(path)
        })
        .catch(() => {})
}

// At startup awww's daemon may not be up yet, or not running at all: it is
// started once, and asked again every 2s for a little while. Capped, so
// without awww installed nothing keeps trying for the life of the shell.
const ATTEMPTS = 15

// the wallpaper of a first start, when nothing is on the screen yet
const FIRST_WALLPAPER = "pawel-czerwinski-ZkzobNDayXo-unsplash.jpg"

// Another wallpaper program (hyprpaper, swaybg, mpvpaper) has the background
// already: an awww started as well covered it in black.
async function otherWallpaper(): Promise<boolean> {
    try {
        const monitors = JSON.parse(await execAsync(["hyprctl", "-j", "layers"]))
        return Object.values(monitors).some((m: any) => (m.levels?.["0"] ?? []).some((l: any) =>
            l.namespace !== "awww-daemon" && !String(l.namespace).startsWith("kiwi")))
    } catch {
        return false
    }
}

// Whoever changes the wallpaper (kiwi-settings, a terminal, the shell
// itself), awww writes what each display now shows to
// ~/.cache/awww/<version>/<display>: NUL-separated namespace, resize, filter
// and image, for each namespace. A display that comes gets its image back from
// there, by awww itself, without a transition; one it has no image for is
// left a plain colour.
const AWWW_CACHE = `${GLib.get_user_cache_dir()}/awww`
// the running awww's folder there
let awwwVersion: string | null = null

function readCache(file: string): string | null {
    try {
        const fields = new TextDecoder().decode(GLib.file_get_contents(file)[1]).split("\0")
        for (let i = 0; i + 3 < fields.length; i += 4)
            if (fields[i] === "") return fields[i + 3]
    } catch {}
    return null
}

// the image awww puts back on the display by itself, if it still can
function restoredImage(display: string): string | null {
    const image = awwwVersion ? readCache(`${AWWW_CACHE}/${awwwVersion}/${display}`) : null
    return image && GLib.file_test(image, GLib.FileTest.EXISTS) ? image : null
}

function modifiedAt(path: string): number {
    const info = Gio.File.new_for_path(path).query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null)
    return info.get_modification_date_time()?.to_unix() ?? 0
}

// The wallpaper last set on any display, an included one as this kiwi's own
// copy (a cache can name a kiwi since collected), or a first start's.
function lastWallpaper(): string | null {
    let newest: { image: string, time: number } | null = null
    if (awwwVersion) try {
        const dir = `${AWWW_CACHE}/${awwwVersion}`
        const listing = GLib.Dir.open(dir, 0)
        let name: string | null
        while ((name = listing.read_name()) !== null) {
            const cached = readCache(`${dir}/${name}`)
            const image = cached ? sameIncluded(cached) : null
            if (!image || !GLib.file_test(image, GLib.FileTest.EXISTS)) continue
            const time = modifiedAt(`${dir}/${name}`)
            if (!newest || time > newest.time) newest = { image, time }
        }
        listing.close()
    } catch {}
    if (newest) return newest.image
    const included = listWallpapers()
    return included.find(p => p.endsWith(`/${FIRST_WALLPAPER}`)) ?? included[0] ?? null
}

// The displays awww shows no image on, and won't put one back on itself (one
// connected for the first time, or whose image has gone), get the wallpaper
// at once. The others are awww's to put back, as each display comes: a query
// can find one blank a moment before.
async function fillBlank(shown: Map<string, string | null>, only?: string) {
    const blank = [...shown]
        .filter(([display, image]) => image === null && (!only || display === only) && !restoredImage(display))
        .map(([display]) => display)
    const wallpaper = blank.length ? lastWallpaper() : null
    if (!wallpaper) return
    log.info(`nothing on ${blank.join(", ")}, showing ${GLib.path_get_basename(wallpaper)}`)
    await execAsync(["awww", "img", "--outputs", blank.join(","), "--transition-type", "none", wallpaper])
        .catch(error => log.error("Failed to set wallpaper:", error))
}

function findWallpaper(attempt = 0) {
    queryShown()
        .then(async shown => {
            awwwVersion ??= (await execAsync(["awww", "--version"]).catch(() => "")).trim().split(" ")[1] ?? null
            const image = firstShown(shown)
            storeWallpaperPath(image ? sameIncluded(image) : lastWallpaper())
            await fillBlank(shown)
        })
        .catch(async () => {
            if (attempt === 0) {
                if (await otherWallpaper()) return log.info("another program draws the wallpaper; not starting awww")
                log.debug("awww daemon not running, starting it")
                // not on the shell's output: that is a pipe that closes when
                // the shell stops, and the daemon died writing to it
                try {
                    Gio.Subprocess.new(["awww-daemon"], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
                } catch {
                    log.debug("awww-daemon could not be started")
                }
            }
            if (attempt + 1 >= ATTEMPTS) return log.debug("giving up on the awww daemon")
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                findWallpaper(attempt + 1)
                return GLib.SOURCE_REMOVE
            })
        })
}

findWallpaper()

// A display connected: awww lists it once it has set it up, a moment after
// Hyprland says it's there.
const LISTED_ATTEMPTS = 5

function fillWhenListed(display: string, attempt = 0) {
    queryShown()
        .then(shown => {
            if (shown.has(display)) return fillBlank(shown, display)
            if (attempt + 1 >= LISTED_ATTEMPTS) return log.debug(`awww never listed ${display}`)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250 * 2 ** attempt, () => {
                fillWhenListed(display, attempt + 1)
                return GLib.SOURCE_REMOVE
            })
        })
        .catch(() => {})
}

Hyprland.get_default().connect("monitor-added", (_h: unknown, monitor: Hyprland.Monitor) => {
    if (awwwVersion && monitor.get_name() !== "FALLBACK") fillWhenListed(monitor.get_name())
})

// Watching awww's cache is how the shell hears of a new wallpaper, Mission
// Control's included; one query per change, however many displays it touched.
const watching = new Map<string, Gio.FileMonitor>()
let refreshSoon = 0

function changed() {
    if (refreshSoon) return
    refreshSoon = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        refreshSoon = 0
        refreshWallpaper()
        return GLib.SOURCE_REMOVE
    })
}

function watch(path: string, onChange: (file: Gio.File, event: Gio.FileMonitorEvent) => void) {
    if (watching.has(path)) return
    try {
        const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null)
        monitor.connect("changed", (_m, file, _other, event) => onChange(file, event))
        watching.set(path, monitor)
    } catch (e) {
        log.debug(`not watching ${path}:`, e as Error)
    }
}

// a version folder for each awww there has been; a new awww makes a new one
function watchVersion(path: string) {
    watch(path, (_file, event) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED) changed()
    })
}

GLib.mkdir_with_parents(AWWW_CACHE, 0o700)
watch(AWWW_CACHE, (file, event) => {
    if (event === Gio.FileMonitorEvent.CREATED && GLib.file_test(file.get_path()!, GLib.FileTest.IS_DIR)) watchVersion(file.get_path()!)
})
try {
    const dir = GLib.Dir.open(AWWW_CACHE, 0)
    let name: string | null
    while ((name = dir.read_name()) !== null)
        if (GLib.file_test(`${AWWW_CACHE}/${name}`, GLib.FileTest.IS_DIR)) watchVersion(`${AWWW_CACHE}/${name}`)
    dir.close()
} catch {}

export function setWallpaper(path: string) {
    if (conf().auto_color) {
        execAsync(["kiwi-settings", "auto-color", path])
            .catch(error => log.error("Failed to match accent color:", error))
    }
    execAsync(["awww", "img", path, "--transition-type", "wipe", "--transition-fps", "120"])
        .then(() => storeWallpaperPath(sameIncluded(path)))
        .catch(error => log.error("Failed to set wallpaper:", error))
}

// where the file picker starts
export function pictureFolder(): string {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? `${HOME}/Pictures`
}

// lives beside setWallpaper because more than one surface offers it now (the
// theme tab and the desktop's right-click menu) and the accepted extensions
// have to stay one list
export function promptWallpaper() {
    execAsync([
        "zenity", "--file-selection",
        "--title=Choose a Wallpaper",
        `--filename=${pictureFolder()}/`,
        "--file-filter=Image files | *.jpg *.jpeg *.png *.gif *.pnm *.tga *.tiff *.tif *.webp *.bmp *.farbfeld *.ff *.svg",
        "--file-filter=All files | *",
    ])
        .then((path) => {
            const cleanPath = path.trim()
            if (cleanPath) setWallpaper(cleanPath)
        })
        .catch(() => {
            log.info("Wallpaper selection cancelled or failed.")
        })
}

// the included wallpapers, and the current one first when it's your own
export function listWallpapers(): string[] {
    const folder = INCLUDED_WALLPAPERS
    const paths: string[] = []
    try {
        const enumerator = Gio.File.new_for_path(folder).enumerate_children(
            "standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
        let info: Gio.FileInfo | null
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name()
            if (info.get_file_type() !== Gio.FileType.REGULAR) continue
            if (!IMAGE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) continue
            paths.push(`${folder}/${name}`)
        }
        enumerator.close(null)
    } catch (error) {
        log.debug(`No wallpapers in ${folder}:`, error)
    }
    paths.sort((a, b) => a.localeCompare(b))

    const current = wallpaperPath.get()
    if (current && !paths.includes(current)) paths.unshift(current)
    return paths
}

// "vadim-sadovski-J3e3_mK4MBQ-unsplash.jpg" -> "Vadim Sadovski"
export function wallpaperName(path: string): string {
    const base = GLib.path_get_basename(path).replace(/\.[^.]+$/, "")
    const unsplash = base.match(/^(.+)-[A-Za-z0-9_-]{11}-unsplash$/)
    if (!unsplash) return base
    return unsplash[1]
        .split("-")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
}

// the line under the name: the source for Unsplash photos, else the folder
export function wallpaperDetail(path: string): string {
    if (/-[A-Za-z0-9_-]{11}-unsplash\.[^.]+$/.test(path)) return "Photo on Unsplash"
    const folder = GLib.path_get_dirname(path)
    return folder.startsWith(HOME) ? `~${folder.slice(HOME.length)}` : folder
}

const thumbnails = new Map<string, Promise<Gdk.Texture | null>>()

// How much of the file goes to the decoder per turn of the main loop. The
// decoder works as the bytes come in, so a photo costs the shell a few
// milliseconds a turn: decoding a 4K wallpaper in one go, then scaling it,
// held everything up for half a second the first time Mission Control opened.
const CHUNK = 16 * 1024

// Scaling the decoded image is one go on the main loop too, cheap for a small
// image only (pixels); past that the GPU scales the picture as it draws it,
// unless the image would take this many times the room the size asked for does.
const CHEAP_SCALE = 1_000_000
const ROOM_FACTOR = 4

// The size to decode a `width` x `height` image at, to cover `want` x
// `wantHeight`. A JPEG decodes at 1/2, 1/4 or 1/8 of its size at a fraction
// of the cost, so it comes at the smallest of those that still covers.
function decodeSize(format: string, width: number, height: number, wantWidth: number, wantHeight: number) {
    const factor = Math.min(1, Math.max(wantWidth / width, wantHeight / height))
    const cover = { width: Math.round(width * factor), height: Math.round(height * factor) }
    let native = { width, height }
    if (format === "jpeg") {
        for (const n of [8, 4, 2]) {
            const w = Math.ceil(width / n), h = Math.ceil(height / n)
            if (w >= wantWidth && h >= wantHeight) {
                native = { width: w, height: h }
                break
            }
        }
    }
    const pixels = (s: { width: number, height: number }) => s.width * s.height
    return pixels(native) <= CHEAP_SCALE || pixels(native) > ROOM_FACTOR * pixels(cover) ? cover : native
}

// Decodes to cover width x height at scale 2, a little at a time (CHUNK):
// the wallpapers themselves are often 5-8K, 100 MB+ as a full texture.
// `keep`: kept for the session, as the few wallpapers are; music covers,
// one per track, are not
export function loadThumbnail(path: string, width: number, height: number, keep = true): Promise<Gdk.Texture | null> {
    const key = `${path}|${width}x${height}`
    const cached = thumbnails.get(key)
    if (cached) return cached

    const promise = new Promise<Gdk.Texture | null>(resolve => {
        const fail = (error: unknown) => {
            log.debug(`Failed to load ${path}:`, error)
            resolve(null)
        }
        try {
            const [format, imageWidth, imageHeight] = GdkPixbuf.Pixbuf.get_file_info(path)
            if (!format || !imageWidth || !imageHeight) return resolve(null)
            const size = decodeSize(format.get_name(), imageWidth, imageHeight, width * 2, height * 2)
            const loader = new GdkPixbuf.PixbufLoader()
            if (size.width !== imageWidth || size.height !== imageHeight) loader.set_size(size.width, size.height)

            Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT_IDLE, null, (file, result) => {
                let stream: Gio.FileInputStream
                try {
                    stream = file!.read_finish(result)
                } catch (error) {
                    return fail(error)
                }
                const next = () => stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT_IDLE, null, (_s, result) => {
                    try {
                        const bytes = stream.read_bytes_finish(result)
                        if (bytes.get_size() > 0) {
                            loader.write_bytes(bytes)
                            return next()
                        }
                        stream.close(null)
                        loader.close()
                        const pixbuf = loader.get_pixbuf()
                        resolve(pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null)
                    } catch (error) {
                        stream.close(null)
                        try { loader.close() } catch { /* already failed */ }
                        fail(error)
                    }
                })
                next()
            })
        } catch (error) {
            fail(error)
        }
    })
    if (keep) {
        // A display's whole wallpaper (Mission Control's) is tens of MB: only
        // the wallpaper's own are kept, those of the ones before it let go.
        // The small ones (the wallpaper picker's) stay.
        if (width * height > LARGE_THUMBNAIL)
            for (const other of [...thumbnails.keys()]) {
                const at = other.lastIndexOf("|")
                const [w, h] = other.slice(at + 1).split("x").map(Number)
                if (other.slice(0, at) !== path && w * h > LARGE_THUMBNAIL) thumbnails.delete(other)
            }
        thumbnails.set(key, promise)
    }
    return promise
}

const LARGE_THUMBNAIL = 512 * 512
