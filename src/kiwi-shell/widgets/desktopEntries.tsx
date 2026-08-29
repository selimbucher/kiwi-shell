import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import { createState } from "ags"
import { logger } from "../log"
const log = logger("desktop-entries")

export const classToEntry = new Map<string, string>()
export const entryToClass = new Map<string, string>()
export const execToEntry = new Map<string, string>()
export const titleMatchers: Array<{ entry: string, regex: RegExp }> = []
export const [mapVersion, setMapVersion] = createState(0)

// runtimes that host many unrelated apps — indexing them by executable would
// make every window of that runtime resolve to whichever entry got scanned
// first (this excludes *runtimes*, not applications)
const GENERIC_EXECUTABLES = new Set([
    "sh", "bash", "zsh", "dash", "env", "electron", "java", "wine",
    "python", "python3", "gjs", "node", "flatpak", "xdg-open",
])

// the executable a desktop entry actually runs: Exec= with env/VAR=/flag
// prefixes stripped, reduced to its basename
function execName(appInfo: GioUnix.DesktopAppInfo): string | null {
    const commandline = appInfo.get_commandline()
    if (!commandline) return null
    let argv: string[]
    try {
        argv = GLib.shell_parse_argv(commandline)[1]
    } catch {
        return null
    }
    let i = 0
    while (i < argv.length &&
        (argv[i] === "env" || argv[i].includes("=") || argv[i].startsWith("-"))) i++
    const word = argv[i]
    if (!word) return null
    const base = GLib.path_get_basename(word).toLowerCase()
    return GENERIC_EXECUTABLES.has(base) ? null : base
}

export function buildClassMap() {
    classToEntry.clear()
    entryToClass.clear()
    execToEntry.clear()
    titleMatchers.length = 0

    const apps = Gio.AppInfo.get_all() as GioUnix.DesktopAppInfo[]

    for (const appInfo of apps) {
        const id = appInfo.get_id()
        if (!id) continue

        const stem = id.replace(/\.desktop$/, "").toLowerCase()
        const wmClass = appInfo.get_startup_wm_class()

        if (!classToEntry.has(stem)) {
            classToEntry.set(stem, id)
            entryToClass.set(id, stem)
        }

        if (wmClass) {
            const wmClassLower = wmClass.toLowerCase()
            if (wmClassLower !== stem && !classToEntry.has(wmClassLower)) {
                classToEntry.set(wmClassLower, id)
            }
        }

        const exec = execName(appInfo)
        if (exec && !execToEntry.has(exec)) {
            execToEntry.set(exec, id)
        }

        const titleMatchRaw = appInfo.get_string("X-Kiwi-TitleMatch")
        if (titleMatchRaw) {
            try {
                titleMatchers.push({ entry: id, regex: new RegExp(titleMatchRaw, "i") })
            } catch (e) {
                log.error(`[ClassMap] Invalid X-Kiwi-TitleMatch in ${id}: ${titleMatchRaw}`, e)
            }
        }
    }

    // second pass so full-id matches always win over reverse-DNS aliases:
    // app ids like org.gnome.Nautilus also answer to the bare last segment
    // (windows report app_id both ways in the wild)
    for (const appInfo of apps) {
        const id = appInfo.get_id()
        if (!id) continue
        const stem = id.replace(/\.desktop$/, "").toLowerCase()
        const last = stem.split(".").pop()
        if (last && last !== stem && !classToEntry.has(last)) {
            classToEntry.set(last, id)
        }
    }

    log.debug(`[ClassMap] Built ${classToEntry.size} class entries, ${execToEntry.size} exec entries, ${titleMatchers.length} title matchers`)
    setMapVersion(v => v + 1)
}

function watchDir(path: string) {
    const dir = Gio.File.new_for_path(path)
    if (!dir.query_exists(null)) {
        log.debug(`[ClassMap] Skipping (does not exist): ${path}`)
        return
    }

    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_mon, _file, _other, eventType) => {
        if (
            eventType !== Gio.FileMonitorEvent.CREATED &&
            eventType !== Gio.FileMonitorEvent.CHANGED &&
            eventType !== Gio.FileMonitorEvent.DELETED
        ) return
        log.debug(`[ClassMap] Detected change in ${path}, rebuilding...`)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            buildClassMap()
            return GLib.SOURCE_REMOVE
        })
    })

    ;(globalThis as any).__classMapMonitors ??= []
    ;(globalThis as any).__classMapMonitors.push(monitor)

    log.debug(`[ClassMap] Watching ${path}`)
}

const dataDirs = [
    `${GLib.get_home_dir()}/.local/share/applications`,
    `/etc/profiles/per-user/${GLib.get_user_name()}/share/applications`,
    `/run/current-system/sw/share/applications`,
    `/run/current-system`,
]

for (const dir of dataDirs) watchDir(dir)

buildClassMap()