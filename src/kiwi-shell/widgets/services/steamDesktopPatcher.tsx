import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { logger } from "../../log"
const log = logger("steam-patcher")

const APPLICATIONS_DIR = `${GLib.get_home_dir()}/.local/share/applications`
const RUNGAMEID_REGEX = /Exec=steam steam:\/\/rungameid\/(\d+)/

function patchDesktopFile(path: string): void {
    const file = Gio.File.new_for_path(path)

    let contents: string
    try {
        const [, bytes] = file.load_contents(null)
        contents = new TextDecoder().decode(bytes)
    } catch (e) {
        log.error(`[SteamPatcher] Failed to read ${path}:`, e)
        return
    }

    const match = RUNGAMEID_REGEX.exec(contents)
    if (!match) return

    if (contents.includes("StartupWMClass=")) return

    const appId = match[1]
    const wmClass = `steam_app_${appId}`

    const patched = contents.replace(
        /(\[Desktop Entry\]\r?\n)/,
        `$1StartupWMClass=${wmClass}\n`,
    )

    if (patched === contents) {
        log.warn(`[SteamPatcher] Could not find [Desktop Entry] in ${path}`)
        return
    }

    try {
        file.replace_contents(
            new TextEncoder().encode(patched),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        )
        log.info(`[SteamPatcher] Patched ${path} → StartupWMClass=${wmClass}`)
    } catch (e) {
        log.error(`[SteamPatcher] Failed to write ${path}:`, e)
    }
}

// one patch per file for a burst of changes: writing a file is several
// events, the patch's own write among them
const pending = new Map<string, number>()

function handleFileEvent(
    _monitor: Gio.FileMonitor,
    file: Gio.File,
    _otherFile: Gio.File | null,
    eventType: Gio.FileMonitorEvent,
): void {
    if (
        eventType !== Gio.FileMonitorEvent.CREATED &&
        eventType !== Gio.FileMonitorEvent.CHANGED
    ) return

    const path = file.get_path()
    if (!path?.endsWith(".desktop")) return

    const earlier = pending.get(path)
    if (earlier !== undefined) GLib.source_remove(earlier)
    pending.set(path, GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        pending.delete(path)
        patchDesktopFile(path)
        return GLib.SOURCE_REMOVE
    }))
}

// stops when collected, so it is kept for as long as kiwi runs
let monitor: Gio.FileMonitor | null = null

export default function steamDesktopPatcher(): void {
    const dir = Gio.File.new_for_path(APPLICATIONS_DIR)

    try {
        const enumerator = dir.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        let info: Gio.FileInfo | null
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name()
            if (name.endsWith(".desktop")) {
                patchDesktopFile(`${APPLICATIONS_DIR}/${name}`)
            }
        }
    } catch (e) {
        log.warn("[SteamPatcher] Could not enumerate applications dir:", e)
    }

    monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", handleFileEvent)

    log.debug("[SteamPatcher] Watching", APPLICATIONS_DIR)
}