import { logger } from "../log"
import { notify } from "../notify"
const log = logger("config")
import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { createState } from "ags"
import { Gdk } from "ags/gtk4"
import App from "ags/app"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

// (kiwi-settings and the home-manager module write here too). Older kiwis
// kept it in ~/.config whatever XDG_CONFIG_HOME said: one there, and none
// where it says, is the one.
export const CONFIG_FOLDER = (() => {
    const folder = `${GLib.get_user_config_dir()}/kiwi-shell`
    const legacy = `${GLib.get_home_dir()}/.config/kiwi-shell`
    return !GLib.file_test(folder, GLib.FileTest.IS_DIR) && GLib.file_test(legacy, GLib.FileTest.IS_DIR) ? legacy : folder
})()
const CONFIG_FILE = `${CONFIG_FOLDER}/config.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

export const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir
const DEFAULT_CONFIG_FILE = `${ROOT}/defaultConfig.json`
const NIX_CONFIG_FILE = `${CONFIG_FOLDER}/nix-config.json`

GLib.mkdir_with_parents(CONFIG_FOLDER, 0o755)

const borderOpacity = 0.7

function nixConfigExists(): boolean {
    try { readFile(NIX_CONFIG_FILE); return true }
    catch { return false }
}

// What Home Manager sets (services.kiwi-shell.settings), laid over the
// user's own settings: only those, the rest left to Kiwi Settings. It used
// to be copied over config.json at every start, which undid every change
// made in Kiwi Settings, set in Home Manager or not.
function nixConfig(): Record<string, any> {
    try {
        return JSON.parse(readFile(NIX_CONFIG_FILE))
    } catch {
        return {}
    }
}

function effective(defaults: Record<string, any>, user: Record<string, any>) {
    return deepMerge(deepMerge(defaults, sane(defaults, migrate(user))), sane(defaults, nixConfig()))
}

// A setting of another kind than its default's (typed by hand, left by an
// older version: "island": null) is left out with a warning, the default in
// its place, rather than taking the shell down where it is read. A text may
// also be a list of texts (shortcuts); keys without a default pass as they are.
function sane(defaults: Record<string, any>, user: Record<string, any>, path = ""): Record<string, any> {
    if (!user || typeof user !== "object" || Array.isArray(user)) return {}
    const result: Record<string, any> = {}
    for (const key in user) {
        const fallback = defaults?.[key]
        const value = user[key]
        const kind = (v: unknown) => Array.isArray(v) ? "array" : v === null ? "null" : typeof v
        let ok = fallback === undefined || fallback === null || kind(value) === kind(fallback)
        if (kind(fallback) === "string" && Array.isArray(value)) ok = value.every(v => typeof v === "string")
        if (kind(fallback) === "number" && !Number.isFinite(value)) ok = false
        if (!ok) {
            log.warn(`ignoring ${path}${key}: ${JSON.stringify(value)} isn't a ${kind(fallback)}`)
            continue
        }
        result[key] = kind(fallback) === "object" ? sane(fallback, value, `${path}${key}.`) : value
    }
    return result
}

function deepMerge(defaults: Record<string, any>, overrides: Record<string, any>): Record<string, any> {
    const result = { ...defaults }
    for (const key in overrides) {
        if (
            overrides[key] !== null &&
            typeof overrides[key] === "object" &&
            !Array.isArray(overrides[key]) &&
            typeof defaults[key] === "object" &&
            defaults[key] !== null &&
            !Array.isArray(defaults[key])
        ) {
            result[key] = deepMerge(defaults[key], overrides[key])
        } else {
            result[key] = overrides[key]
        }
    }
    return result
}

const THEME_STYLES = ["granite", "acrylic", "tinted", "clear"]

// The shell used to have two panel styles, "dark" and "glass". Glass became
// Clear Glass, dark became Granite. The panels also had a light appearance
// once; they are dark only now, so the setting is dropped.
function migrate(user: Record<string, any>): Record<string, any> {
    const { appearance: _dropped, ...rest } = user
    if (THEME_STYLES.includes(rest.theme)) return rest
    if (rest.theme === "glass") return { ...rest, theme: "clear" }
    return { ...rest, theme: "granite" }
}

function loadConfig() {
    const defaultContent = readFile(DEFAULT_CONFIG_FILE)
    const defaultConfig = JSON.parse(defaultContent)

    if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
        try {
            GLib.file_set_contents(CONFIG_FILE, defaultContent)
        } catch (e) {
            log.error(`could not write ${CONFIG_FILE}:`, e as Error)
        }
    }

    // A file that doesn't read (a comma too many typed by hand, a write cut
    // short) leaves the shell on its defaults, not without a bar, dock and
    // shortcuts: the file stays as it is, and is taken up as soon as it's
    // saved again (reloadConfig).
    try {
        return effective(defaultConfig, JSON.parse(readFile(CONFIG_FILE)))
    } catch (e) {
        log.error(`could not read ${CONFIG_FILE}, using the defaults:`, e as Error)
        notify("Settings could not be read", `kiwi is using its default settings until config.json reads again: ${(e as Error).message}`, { urgency: 2 })
        return deepMerge(defaultConfig, sane(defaultConfig, nixConfig()))
    }
}

async function writeHypr(primaryColor: string) {
    try {
        const rgba = new Gdk.RGBA()
        rgba.parse(primaryColor)

        const kiwiColor = rgba.to_string()
        rgba.alpha = borderOpacity
        const kiwiColorTransparent = rgba.to_string()

        const hyprString = `$kiwiColor = ${kiwiColor}\n$kiwiColorLight = ${kiwiColorTransparent}`
        await writeFileAsync(HYPR_FILE, hyprString)
    } catch (error) {
        log.error("Failed to save hypr colors:", error)
    }
}

const initialConfig = loadConfig()

export const [conf, setConf] = createState(initialConfig)

if (nixConfigExists()) {
    writeHypr(initialConfig.primary_color)
}

let reloadTimeout: number | null = null

function reloadConfig() {
    try {
        const content = readFile(CONFIG_FILE)
        if (!content.trim()) return
        const defaultContent = readFile(DEFAULT_CONFIG_FILE)
        const defaultConfig = JSON.parse(defaultContent)
        setConf(effective(defaultConfig, JSON.parse(content)))
    } catch (error) {
        log.error("Failed to reload config:", error)
    }
}

function scheduleReload() {
    if (reloadTimeout !== null) {
        GLib.source_remove(reloadTimeout)
    }
    reloadTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        reloadTimeout = null
        reloadConfig()
        return GLib.SOURCE_REMOVE
    })
}

// A file monitor follows the file's inode. Editors (and writeFileAsync) save
// by renaming a new file over config.json, after which in-place writes, like
// kiwi-settings', went unseen. So re-watch whenever the file is replaced.
// (monitorFile also keeps the monitor referenced; a bare Gio monitor held in
// a module variable was garbage-collected within seconds.)
let configMonitor: Gio.FileMonitor | null = null

function watchConfig() {
    configMonitor?.cancel()
    configMonitor = monitorFile(CONFIG_FILE, (_path, event) => {
        // (a plain CREATED is re-watched by monitorFile itself)
        if (event === Gio.FileMonitorEvent.RENAMED || event === Gio.FileMonitorEvent.MOVED_IN) {
            watchConfig()
        }
        scheduleReload()
    })
}

watchConfig()

export async function writeConf() {
    const currentConf = conf()
    const jsonString = JSON.stringify(currentConf, null, 2)

    try {
        await writeFileAsync(CONFIG_FILE, jsonString)
    } catch (error) {
        log.error("Failed to save config:", error)
    }

    await writeHypr(currentConf.primary_color)
}