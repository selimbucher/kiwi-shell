import { logger } from "../log"
const log = logger("config")
import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { createState } from "ags"
import { exec } from "ags/process"
import { Gdk } from "ags/gtk4"
import App from "ags/app"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

const HOME = GLib.getenv("HOME")
const CONFIG_FOLDER = `${HOME}/.config/kiwi-shell`
const CONFIG_FILE = `${CONFIG_FOLDER}/config.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

export const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir
const DEFAULT_CONFIG_FILE = `${ROOT}/defaultConfig.json`
const NIX_CONFIG_FILE = `${CONFIG_FOLDER}/nix-config.json`

exec(`mkdir -p ${CONFIG_FOLDER}`)

const borderOpacity = 0.7

function nixConfigExists(): boolean {
    try { readFile(NIX_CONFIG_FILE); return true }
    catch { return false }
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

    if (nixConfigExists()) {
        exec(`cp --no-preserve=mode ${NIX_CONFIG_FILE} ${CONFIG_FILE}`)
    } else {
        try { readFile(CONFIG_FILE) }
        catch {
            exec(`cp --no-preserve=mode ${DEFAULT_CONFIG_FILE} ${CONFIG_FILE}`)
        }
    }

    const content = readFile(CONFIG_FILE)
    return deepMerge(defaultConfig, migrate(JSON.parse(content)))
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
        setConf(deepMerge(defaultConfig, migrate(JSON.parse(content))))
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