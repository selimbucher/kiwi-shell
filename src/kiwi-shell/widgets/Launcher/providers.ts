import { notify } from "../../notify"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Apps from "gi://AstalApps"
import Hyprland from "gi://AstalHyprland"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import Gdk from "gi://Gdk"
import { execAsync, subprocess } from "ags/process"
import { logger } from "../../log"
import { mapVersion } from "../desktopEntries"
import { entryForClient, giconForEntry } from "../appIcon"
import { focusClient, isMinimized, restoreClient } from "../Dock/dock-state"
import { openPath, openTerminal, revealPath } from "../Dock/dock-utils"
import { lock, logOut, restart, shutDown, sleep } from "../power"
import { openMissionControl } from "../MissionControl/MissionControl"
import { openNc } from "../Notifications/NotificationCenter"
import { nightShift, turnNightShift } from "../services/nightShiftSchedule"
import { network } from "../services/network"
import { setAdapter } from "../services/bluez"
import { conf } from "../config"
import { evaluate, formatNumber } from "./calc"
import { convert } from "./units"
import { learned } from "./learn"
import { findFiles, isPath, listPath, iconFor, shortPath, markUsed, expandPath, type Entry } from "./files"
import { asCommand, runInBackground, runInTerminal } from "./commands"

const log = logger("launcher")

// What the search box can find. Every source returns the same shape on one
// scale, 0 to 100, so the best of all of them can lead as the Top Hit and the
// rest follow by kind, as a Mac's Spotlight lists them: an app, its windows,
// files and folders, a setting, an action, a command to run, the web.
//
// What a source scores, roughly: the answer to a sum 95; a name that is the
// query 85–90; one it starts 75–80; a word in it it starts 45–70; a match
// inside a name 30–40. What was picked for the query before adds up to 30.

export type Group = "top" | "answer" | "apps" | "windows" | "files" | "folders" | "settings" | "actions" | "command" | "web"

export const GROUP_LABEL: Record<Group, string> = {
    top: "Top Hit",
    answer: "Result",
    apps: "Applications",
    windows: "Open Windows",
    files: "Files",
    folders: "Folders",
    settings: "Settings",
    actions: "Actions",
    command: "Command",
    web: "Search",
}

// the order the kinds come in after the Top Hit, and how many of each
const ORDER: [Group, number][] = [
    ["answer", 1], ["apps", 4], ["windows", 3], ["folders", 3], ["files", 4],
    ["settings", 3], ["actions", 3], ["command", 1],
]

export type Result = {
    key: string
    group: Group
    name: string
    detail?: string
    iconName?: string
    gicon?: Gio.Icon
    /** what Enter does, and what the row says it will do */
    verb: string
    activate: () => void
    /** Shift+Enter: the other thing (a new window, the folder, a terminal) */
    alt?: { verb: string, activate: () => void }
    /** Tab: what the query becomes (a folder's path, to go on typing in it) */
    complete?: string
    score: number
    /** a pick of it is remembered for the query */
    learn?: boolean
    /** shown under the Top Hit heading */
    top?: boolean
    /** a guess at a typo */
    guess?: boolean
}

// ─── Applications ─────────────────────────────────────────────────────────────

const apps = new Apps.Apps()
// only for the typo fallback below; the default (0) lets a two-letter query
// match half a Steam library
apps.minScore = 0.4

// desktopEntries already watches the application dirs — piggyback on it to
// keep the search index fresh
mapVersion.subscribe(() => apps.reload())

const hyprland = Hyprland.get_default()

// the app's windows, the one used last first
function windowsOf(application: Apps.Application): Hyprland.Client[] {
    const id = application.get_entry()
    return hyprland.get_clients()
        .filter(c => entryForClient(c) === id)
        .sort((a, b) => a.focusHistoryId - b.focusHistoryId)
}

// An app already open is switched to, as a Mac's Spotlight brings it forward:
// opening it again gave some apps (a terminal, a browser) a second one. A new
// window is Shift+Enter away.
function appResult(application: Apps.Application, score: number): Result {
    // (AstalApps counts it, for the order above)
    const launch = () => {
        if (!application.launch())
            notify(`“${application.get_name()}” couldn't be opened`, "", { icon: "dialog-error-symbolic" })
    }
    const windows = windowsOf(application)
    const front = windows[0]
    return {
        key: `app:${application.get_entry()}`,
        group: "apps",
        name: application.get_name(),
        detail: front
            ? windows.length > 1 ? `${windows.length} windows` : "1 window"
            : application.get_description() || undefined,
        iconName: application.get_icon_name() || "application-x-executable",
        verb: front ? "Switch" : "Open",
        activate: front ? () => isMinimized(front) ? restoreClient(front) : focusClient(front) : launch,
        alt: front ? { verb: "New Window", activate: launch } : undefined,
        score,
        learn: true,
    }
}

// How well an app answers the query, best first. AstalApps' fuzzy score put
// Icon Library, "bra" in the middle of a word, ahead of Brave Web Browser; a
// name the query starts is what someone typing it is after. Keywords, the
// command and the app id ("nau" for Files) come after the name's own words,
// and the description after anything in the name.
const words = (text: string) =>
    text.split(/[\s\-_.]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map(w => w.toLowerCase())

const TIER_SCORE = [15, 25, 40, 55, 70, 80, 90]

function tier(application: Apps.Application, needle: string): number {
    const name = application.name.toLowerCase()
    if (name === needle) return 6
    if (name.startsWith(needle)) return 5
    if (words(application.name).some(w => w.startsWith(needle))) return 4
    const command = (application.executable ?? "").split(" ")[0].split("/").pop()!.toLowerCase()
    // the last part of a reverse-DNS id; the rest names the developer
    const id = (application.entry ?? "").replace(/\.desktop$/, "").split(".").pop()!.toLowerCase()
    const terms = [...(application.keywords ?? []).map(k => k.toLowerCase()), command, id]
    if (terms.some(t => t.startsWith(needle))) return 3
    if (name.includes(needle)) return 2
    if (words(application.description ?? "").some(w => w.startsWith(needle))) return 1
    return 0
}

// Within a tier the apps opened most come first (AstalApps counts launches),
// up to 8 more; a typo matches no tier, and only then does the fuzzy score
// get a say.
function appResults(text: string, limit: number): Result[] {
    const needle = text.trim().toLowerCase()
    let scored = apps.get_list()
        .map(application => ({ application, tier: tier(application, needle) }))
        .filter(s => s.tier > 0)
    if (scored.length === 0)
        scored = apps.fuzzy_query(text).slice(0, limit).map(application => ({ application, tier: 0 }))
    return scored
        .map(({ application, tier }) => ({
            ...appResult(application, TIER_SCORE[tier] + Math.min(8, Math.log2(1 + application.frequency) * 2)),
            guess: tier === 0,
        }))
        .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
        .slice(0, limit * 2)
}

// ─── Open windows ─────────────────────────────────────────────────────────────

function windowResults(text: string, limit: number): Result[] {
    const needle = text.toLowerCase()
    const scored: { client: Hyprland.Client, score: number }[] = []
    for (const client of hyprland.get_clients()) {
        const title = client.title ?? ""
        const appClass = client.class ?? ""
        if (!title && !appClass) continue
        // a window is worth offering on its title or its app's name; the class
        // matching is what makes "term" find the kitty you already have open
        const inClass = appClass.toLowerCase().indexOf(needle)
        const inTitle = title.toLowerCase().indexOf(needle)
        const titleWord = words(title).some(w => w.startsWith(needle))
        if (inClass < 0 && inTitle < 0) continue
        // a prefix beats a match in the middle, and the class beats the title:
        // window titles pick up whatever file happens to be open in them. Below
        // the app itself, which switches to its window already.
        const score = Math.max(inClass === 0 ? 50 : inClass > 0 ? 30 : 0,
            inTitle === 0 ? 48 : titleWord ? 42 : inTitle > 0 && needle.length >= 3 ? 30 : 0)
        if (score > 0) scored.push({ client, score })
    }
    return scored
        .sort((a, b) => b.score - a.score || a.client.focusHistoryId - b.client.focusHistoryId)
        .slice(0, limit)
        .map(({ client, score }) => {
            const entry = entryForClient(client)
            const appName = (entry && GioUnix.DesktopAppInfo.new(entry)?.get_name()) || client.class
            // brought forward, or out of the dock where minimized
            const minimized = isMinimized(client)
            const desktop = client.workspace?.id ?? 0
            const where = minimized ? "minimized" : desktop > 0 ? `Desktop ${desktop}` : ""
            return {
                key: `win:${client.address}`,
                group: "windows" as Group,
                name: client.title || appName,
                detail: where ? `${appName} · ${where}` : appName,
                gicon: entry ? giconForEntry(entry) : undefined,
                iconName: entry ? undefined : "window-symbolic",
                verb: "Switch",
                activate: () => minimized ? restoreClient(client) : focusClient(client),
                score,
            }
        })
}

// ─── Files and folders ────────────────────────────────────────────────────────

function openFile(entry: Entry) {
    if (entry.dir) return openPath(entry.path)
    markUsed(entry.path)
    Gio.AppInfo.launch_default_for_uri_async(Gio.File.new_for_path(entry.path).get_uri(), null, null, (_s, result) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(result)
        } catch (e) {
            notify(`“${entry.name}” couldn't be opened`, (e as Error).message, { icon: "dialog-error-symbolic" })
        }
    })
}

function fileResult(entry: Entry, score: number, completable = false): Result {
    return {
        key: `file:${entry.path}`,
        group: entry.dir ? "folders" : "files",
        name: entry.name,
        detail: shortPath(GLib.path_get_dirname(entry.path)),
        gicon: iconFor(entry),
        verb: "Open",
        activate: () => openFile(entry),
        // a folder: a terminal in it; a file: where it is
        alt: entry.dir
            ? { verb: "Terminal", activate: () => openTerminal(entry.path) }
            : { verb: "Show in Files", activate: () => revealPath(entry.path) },
        complete: completable && entry.dir ? shortPath(entry.path) + "/" : undefined,
        score,
        learn: true,
    }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// Kiwi Settings' pages, found by what is on them, opened on that page.

const SETTINGS: { name: string, page: string, icon: string, keywords: string[] }[] = [
    { name: "Appearance", page: "appearance", icon: "preferences-desktop-appearance-symbolic",
        keywords: ["theme", "style", "panel style", "glass", "blur", "font", "look", "dark mode", "light mode"] },
    { name: "Wallpaper", page: "appearance", icon: "preferences-desktop-wallpaper-symbolic",
        keywords: ["background", "desktop picture", "picture"] },
    { name: "Accent Color", page: "appearance", icon: "preferences-color-symbolic",
        keywords: ["accent", "colour", "highlight", "match wallpaper"] },
    { name: "Interface Size", page: "appearance", icon: "zoom-in-symbolic",
        keywords: ["scale", "zoom", "bigger", "smaller", "size of the bar"] },
    { name: "Desktop", page: "desktop", icon: "user-desktop-symbolic",
        keywords: ["desktop icons", "multiple monitors", "displays", "compositor"] },
    { name: "Search Engine", page: "desktop", icon: "system-search-symbolic",
        keywords: ["spotlight", "duckduckgo", "google", "web search", "brave search", "kagi"] },
    { name: "Dock", page: "dock", icon: "view-app-grid-symbolic",
        keywords: ["icon size", "auto-hide", "autohide", "pinned apps", "trash", "home folder"] },
    { name: "Status Bar", page: "bar", icon: "kiwi-status-bar-symbolic",
        keywords: ["menu bar", "clock", "24-hour time", "battery percentage", "bar"] },
    { name: "Dynamic Island", page: "bar", icon: "kiwi-status-bar-symbolic",
        keywords: ["island", "now playing", "weather", "activities", "alerts"] },
    { name: "Night Shift", page: "night-shift", icon: "night-light-symbolic",
        keywords: ["warmth", "blue light", "colour temperature", "color temperature", "schedule", "sunset"] },
    { name: "Keybinds", page: "keybinds", icon: "preferences-desktop-keyboard-shortcuts-symbolic",
        keywords: ["shortcuts", "keyboard", "hotkeys", "keys"] },
]

function nameScore(name: string, keywords: string[], needle: string, scores: [number, number, number, number]): number {
    const n = name.toLowerCase()
    if (n === needle) return scores[0]
    if (n.startsWith(needle)) return scores[1]
    if (words(name).some(w => w.startsWith(needle))) return scores[2]
    if (keywords.some(k => k.startsWith(needle) || k.split(" ").some(w => w.startsWith(needle)))) return scores[3]
    return 0
}

function settingResults(text: string, limit: number): Result[] {
    const needle = text.trim().toLowerCase()
    if (needle.length < 3) return []
    return SETTINGS
        .map(setting => ({ setting, score: nameScore(setting.name, setting.keywords, needle, [80, 68, 58, 45]) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ setting, score }) => ({
            key: `setting:${setting.name}`,
            group: "settings" as Group,
            name: setting.name,
            detail: "Kiwi Settings",
            iconName: setting.icon,
            verb: "Open",
            activate: () => { subprocess(["kiwi-settings", setting.page]) },
            score,
            learn: true,
        }))
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// The settings people go looking through menus for, the switches of the
// Control Center, and the session controls that otherwise need the power
// button. Each one has to be asked for by name: see `actionResults`, which
// only matches from the start of a word.

const INTERFACE_SCHEMA = "org.gnome.desktop.interface"
const interfaceSettings = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE_SCHEMA, true)
    ? new Gio.Settings({ schema_id: INTERFACE_SCHEMA })
    : null

const setColorScheme = (dark: boolean) =>
    interfaceSettings?.set_string("color-scheme", dark ? "prefer-dark" : "prefer-light")

const bluetooth = AstalBluetooth.get_default()
const notifd = AstalNotifd.get_default()

type Action = {
    name: string | (() => string)
    detail?: string
    icon: string
    /** extra words that should find it, beyond the name */
    keywords?: string[]
    verb?: string
    available?: () => boolean
    activate: () => void
}

const ACTIONS: Action[] = [
    // what is otherwise only a key or a swipe away, found by name
    {
        name: "Mission Control", icon: "view-grid-symbolic", verb: "Open",
        keywords: ["desktops", "spaces", "windows", "overview", "expose"], activate: openMissionControl,
    },
    {
        name: "Notification Center", icon: "notifications-symbolic", verb: "Open",
        keywords: ["notifications"], activate: openNc,
    },
    // the Control Center's switches, named for what they'll do
    {
        name: () => network().wifi?.enabled ? "Turn Wi-Fi Off" : "Turn Wi-Fi On", icon: "network-wireless-symbolic",
        keywords: ["wifi", "wi-fi", "wireless", "wlan", "internet"], verb: "Switch",
        available: () => !!network().wifi,
        activate: () => { const wifi = network().wifi; if (wifi) wifi.enabled = !wifi.enabled },
    },
    {
        name: () => bluetooth.adapter?.powered ? "Turn Bluetooth Off" : "Turn Bluetooth On", icon: "bluetooth-active-symbolic",
        keywords: ["bluetooth", "bt"], verb: "Switch",
        available: () => !!bluetooth.adapter,
        activate: () => {
            const adapter = bluetooth.adapter
            if (adapter) setAdapter(adapter, "Powered", !adapter.powered).catch(e => log.warn("bluetooth:", e))
        },
    },
    {
        name: () => notifd.dont_disturb ? "Turn Do Not Disturb Off" : "Turn Do Not Disturb On", icon: "notifications-disabled-symbolic",
        keywords: ["do not disturb", "dnd", "focus", "quiet", "silence"], verb: "Switch",
        activate: () => { notifd.dont_disturb = !notifd.dont_disturb },
    },
    {
        name: () => nightShift.get() ? "Turn Night Shift Off" : "Turn Night Shift On", icon: "night-light-symbolic",
        keywords: ["night shift", "night light", "warm", "blue light"], verb: "Switch",
        activate: () => turnNightShift(!nightShift.get()),
    },
    {
        name: "Lock Screen", icon: "system-lock-screen-symbolic",
        keywords: ["lock"], activate: lock,
    },
    {
        name: "Sleep", icon: "weather-clear-night-symbolic",
        keywords: ["suspend", "hibernate"], activate: sleep,
    },
    {
        name: "Log Out", icon: "system-log-out-symbolic",
        // the three that end everything ask first, as from the power menu
        keywords: ["logout", "sign out", "exit"], activate: logOut,
    },
    {
        name: "Restart", icon: "system-reboot-symbolic",
        keywords: ["reboot"], activate: restart,
    },
    {
        name: "Shut Down", icon: "system-shutdown-symbolic",
        keywords: ["poweroff", "power off"], activate: shutDown,
    },
    {
        name: "Light Appearance", icon: "weather-clear-symbolic",
        keywords: ["light", "theme"], verb: "Switch", activate: () => setColorScheme(false),
    },
    {
        name: "Dark Appearance", icon: "weather-clear-night-symbolic",
        keywords: ["dark", "theme"], verb: "Switch", activate: () => setColorScheme(true),
    },
]

// Only from the start of a word, and only from two characters up: "Shut Down"
// turning up because a query happened to contain a "u" is how a search box
// ends up powering the machine off.
function actionResults(text: string, limit: number): Result[] {
    if (text.trim().length < 2) return []
    const needle = text.trim().toLowerCase()
    const scored: { action: Action, name: string, score: number }[] = []
    for (const action of ACTIONS) {
        if (action.available && !action.available()) continue
        const name = typeof action.name === "function" ? action.name() : action.name
        const terms = [name, ...(action.keywords ?? [])].map(t => t.toLowerCase())
        let score = 0
        for (const term of terms) {
            if (term === needle) score = Math.max(score, 85)
            else if (term.startsWith(needle)) score = Math.max(score, 75)
            else if (term.split(" ").some(word => word.startsWith(needle))) score = Math.max(score, 60)
        }
        if (score > 0) scored.push({ action, name, score })
    }
    return scored
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map(({ action, name, score }) => ({
            key: `action:${typeof action.name === "string" ? action.name : (action.keywords ?? [name])[0]}`,
            group: "actions" as Group,
            name,
            detail: action.detail,
            iconName: action.icon,
            verb: action.verb ?? "Run",
            activate: action.activate,
            score,
            learn: true,
        }))
}

// ─── A command line ───────────────────────────────────────────────────────────
// Offered when the first word is a program (commands.ts): ahead of most only
// with arguments, since a bare word is likelier an app's or a file's name,
// and first only with ">" before it. None of it is learned.

function commandResult(text: string): Result | null {
    const command = asCommand(text)
    if (!command) return null
    const { line, terminal, explicit } = command
    const hasArgs = /\s/.test(line)
    return {
        key: "command",
        group: "command",
        name: line,
        detail: terminal ? "Runs in the terminal" : "Runs in the background; what it says, as a notification",
        iconName: "utilities-terminal-symbolic",
        verb: terminal ? "Run in Terminal" : "Run",
        activate: () => terminal ? runInTerminal(line) : runInBackground(line),
        alt: terminal ? undefined : { verb: "Terminal", activate: () => runInTerminal(line) },
        score: explicit ? 100 : hasArgs ? 52 : 20,
    }
}

// ─── An address ───────────────────────────────────────────────────────────────

const URL = /^(https?:\/\/)?(localhost|[\w-]+(\.[\w-]+)*\.[a-z]{2,})(:\d+)?(\/\S*)?$/i

function urlResult(text: string): Result | null {
    const trimmed = text.trim()
    if (!URL.test(trimmed) || /^\d+(\.\d+)+$/.test(trimmed)) return null
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    return {
        key: "url",
        group: "answer",
        name: trimmed,
        detail: "Open in the browser",
        iconName: "web-browser-symbolic",
        verb: "Open",
        activate: () => { execAsync(["xdg-open", url]).catch(e => log.error("couldn't open", url, e)) },
        score: 92,
    }
}

// ─── Web search ───────────────────────────────────────────────────────────────
// The last row, always: a search box that comes up empty is a dead end, and
// the next thing the user would do is open a browser and type it again. The
// engine is the search_engine setting (Kiwi Settings → Desktop).

export const SEARCH_ENGINES: Record<string, { name: string, url: string }> = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
    brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
    ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?query=" },
    kagi: { name: "Kagi", url: "https://kagi.com/search?q=" },
}

function webResult(text: string): Result {
    const engine = SEARCH_ENGINES[conf().search_engine] ?? SEARCH_ENGINES.duckduckgo
    return {
        key: "web",
        group: "web",
        name: text.trim(),
        detail: `Search with ${engine.name}`,
        iconName: "system-search-symbolic",
        verb: "Search",
        activate: () => { execAsync(["xdg-open", engine.url + encodeURIComponent(text.trim())]).catch(e => log.error("web search:", e)) },
        score: 0,
    }
}

// ─── Copying an answer ────────────────────────────────────────────────────────

export function copyToClipboard(text: string) {
    const display = Gdk.Display.get_default()
    if (!display) return
    // through a content provider rather than the GJS `set()` shorthand, which
    // has to guess at the GValue type it is handed
    display.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(text))
}

function answerResult(text: string): Result | null {
    const conversion = convert(text)
    if (conversion) return {
        key: "answer", group: "answer", name: conversion.name, detail: conversion.detail,
        iconName: "accessories-calculator-symbolic", verb: "Copy",
        activate: () => copyToClipboard(conversion.value),
        alt: { verb: "Copy with Unit", activate: () => copyToClipboard(conversion.name) },
        score: 95,
    }
    const value = evaluate(text)
    if (value === null) return null
    const shown = formatNumber(value)
    return {
        key: "answer", group: "answer", name: shown, detail: text.trim(),
        iconName: "accessories-calculator-symbolic", verb: "Copy",
        activate: () => copyToClipboard(shown),
        score: 95,
    }
}

// ─── The one list ─────────────────────────────────────────────────────────────

/**
 * Everything matching `text`: the best of all as the Top Hit, the rest by
 * kind, the web search last.
 */
export function search(text: string, limit: number): Result[] {
    const query = text.trim()
    if (!query) return []

    // ">" first: a command line, nothing else
    if (query.startsWith(">")) {
        const command = commandResult(query)
        return command ? [command] : []
    }

    let found: Result[]
    if (isPath(query)) {
        // a path being typed: what's in its folder, and the path itself
        const full = expandPath(query).replace(/(.)\/+$/, "$1")
        found = listPath(query, 10).map((entry, i) => fileResult(entry, 60 - i, true))
        if (GLib.file_test(full, GLib.FileTest.EXISTS) && !found.some(r => r.key === `file:${full}`)) {
            const dir = GLib.file_test(full, GLib.FileTest.IS_DIR)
            const name = GLib.path_get_basename(full) || full
            found.unshift(fileResult({ path: full, name, lower: name.toLowerCase(), dir, depth: 0, modified: 0 }, 70))
        }
        const command = commandResult(query)
        if (command) found.push(command)
    } else {
        found = [
            ...[answerResult(query), urlResult(query), commandResult(query)].filter((r): r is Result => !!r),
            ...appResults(query, 4),
            ...windowResults(query, 3),
            ...findFiles(query, 8).map(f => fileResult(f.entry, f.score)),
            ...settingResults(query, 3),
            ...actionResults(query, 3),
        ]
    }

    // what was picked for this query before, up to 30 more
    for (const result of found)
        if (result.learn) result.score += 30 * learned(query, result.key)
    // a guess at a typo (an app's fuzzy match) only where nothing answers
    if (found.some(r => r.score >= 40)) found = found.filter(r => !r.guess)

    // The Top Hit: the best of all, if it answers the query at all (a match
    // in the middle of a word isn't one)
    found.sort((a, b) => b.score - a.score)
    const best = found[0]
    const rows: Result[] = []
    if (best && best.score >= 40) rows.push({ ...best, top: true })

    const rest = rows.length ? found.filter(r => r.key !== rows[0].key) : found
    for (const [group, most] of ORDER)
        rows.push(...rest.filter(r => r.group === group).slice(0, most))
    const trimmed = rows.slice(0, limit - 1)
    trimmed.push(webResult(query))
    return trimmed
}
