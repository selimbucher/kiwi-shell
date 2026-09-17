import { createState } from "ags"
import { exec, execAsync } from "ags/process"
import { Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"

import { conf } from "../config"
import { logger } from "../../log"
const log = logger("wallpaper")

const HOME = GLib.get_home_dir()
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"]

export const [wallpaperPath, storeWallpaperPath] = createState<string | null>(null)

function parseQuery(output: string): string | null {
    const line = output.split("\n").find(l => l.includes("image: "))
    const match = line?.match(/image:\s*(.+)$/)
    return match ? match[1].trim() : null
}

function queryWallpaper(): string | null {
    try {
        return parseQuery(exec("awww query"))
    } catch {
        execAsync("awww-daemon").catch(() => {})
        log.debug("awww daemon not running, starting...")
    }
    return null
}

// Picks up changes made elsewhere (kiwi-settings, a terminal).
export function refreshWallpaper() {
    execAsync("awww query")
        .then(output => {
            const path = parseQuery(output)
            if (path && path !== wallpaperPath.get()) storeWallpaperPath(path)
        })
        .catch(() => {})
}

let retryInterval: number | null = null

function setupWallpaperPolling() {
    const path = queryWallpaper()
    if (path) {
        storeWallpaperPath(path)
        return
    }

    log.debug("Starting wallpaper polling...")
    // capped: without awww installed this would otherwise spawn two
    // processes every 2s for the lifetime of the shell
    let attempts = 0
    retryInterval = setInterval(() => {
        const path = queryWallpaper()
        if (path) {
            log.debug("Successfully connected to awww daemon")
            storeWallpaperPath(path)
        } else if (++attempts < 15) {
            return
        } else {
            log.debug("Giving up on awww daemon")
        }
        clearInterval(retryInterval!)
        retryInterval = null
    }, 2000) as unknown as number
}

setupWallpaperPolling()

export function setWallpaper(path: string) {
    if (conf().auto_color) {
        execAsync(["kiwi-settings", "auto-color", path])
            .catch(error => log.error("Failed to match accent color:", error))
    }
    execAsync(["awww", "img", path, "--transition-type", "wipe", "--transition-fps", "120"])
        .then(() => storeWallpaperPath(path))
        .catch(error => log.error("Failed to set wallpaper:", error))
}

// ~/Pictures/Wallpapers when it exists, else the folder of the current one
export function wallpaperFolder(): string {
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? `${HOME}/Pictures`
    const library = `${pictures}/Wallpapers`
    if (GLib.file_test(library, GLib.FileTest.IS_DIR)) return library
    const current = wallpaperPath.get()
    return current ? GLib.path_get_dirname(current) : pictures
}

export function listWallpapers(): string[] {
    // awww reports resolved paths, so list the folder by its resolved path too
    // (a symlinked ~/Pictures would otherwise never match the current one)
    let folder = wallpaperFolder()
    try {
        folder = exec(["realpath", "-e", folder]).trim() || folder
    } catch {}
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

export function prettyFolder(path: string): string {
    const folder = GLib.path_get_dirname(path)
    return folder.startsWith(HOME) ? `~${folder.slice(HOME.length)}` : folder
}

const thumbnails = new Map<string, Promise<Gdk.Texture | null>>()

// Decodes at thumbnail size (covering width x height at scale 2) off the main
// loop: the wallpapers themselves are often 5-8K, 100 MB+ as a full texture.
export function loadThumbnail(path: string, width: number, height: number): Promise<Gdk.Texture | null> {
    const key = `${path}|${width}x${height}`
    const cached = thumbnails.get(key)
    if (cached) return cached

    const promise = new Promise<Gdk.Texture | null>(resolve => {
        try {
            const [, imageWidth, imageHeight] = GdkPixbuf.Pixbuf.get_file_info(path)
            if (!imageWidth || !imageHeight) return resolve(null)
            const factor = Math.min(1, Math.max((width * 2) / imageWidth, (height * 2) / imageHeight))
            const stream = Gio.File.new_for_path(path).read(null)
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                Math.round(imageWidth * factor),
                Math.round(imageHeight * factor),
                true,
                null,
                (_source, result) => {
                    try {
                        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(result)
                        resolve(pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null)
                    } catch (error) {
                        log.debug(`Failed to load ${path}:`, error)
                        resolve(null)
                    } finally {
                        stream.close(null)
                    }
                },
            )
        } catch (error) {
            log.debug(`Failed to load ${path}:`, error)
            resolve(null)
        }
    })
    thumbnails.set(key, promise)
    return promise
}
