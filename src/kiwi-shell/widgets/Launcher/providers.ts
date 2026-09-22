import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Apps from "gi://AstalApps"
import Hyprland from "gi://AstalHyprland"
import Gdk from "gi://Gdk"
import { execAsync } from "ags/process"
import { logger } from "../../log"
import { mapVersion } from "../desktopEntries"
import { entryForClient, giconForEntry } from "../appIcon"
import { clientSelector, focusWindow, exitSession } from "../../hypr"
import { conf } from "../config"

const log = logger("launcher")

// What the search box can find. Every source returns the same shape, so the
// panel is one list and the ranking is one comparison — the alternative is a
// tab per source, which is a filing cabinet, not a search box.
//
// Sources are deliberately few. A launcher earns its keystroke by answering
// the four things people actually open it for: an app, a window they already
// have, a sum, and a setting they'd otherwise go hunting for.

export type Group = "answer" | "apps" | "windows" | "actions" | "web"

export const GROUP_LABEL: Record<Group, string> = {
    answer: "Result",
    apps: "Applications",
    windows: "Open Windows",
    actions: "Actions",
    web: "Search",
}

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
}

// ─── Applications ─────────────────────────────────────────────────────────────

const apps = new Apps.Apps()
// only for the typo fallback below; the default (0) lets a two-letter query
// match half a Steam library
apps.minScore = 0.4

// desktopEntries already watches the application dirs — piggyback on it to
// keep the search index fresh
mapVersion.subscribe(() => apps.reload())

function appResult(application: Apps.Application): Result {
    return {
        key: `app:${application.get_entry()}`,
        group: "apps",
        name: application.get_name(),
        detail: application.get_description() || undefined,
        iconName: application.get_icon_name() || "application-x-executable",
        verb: "Open",
        activate: () => application.launch(),
    }
}

// How well an app answers the query, best first. AstalApps' fuzzy score put
// Icon Library, "bra" in the middle of a word, ahead of Brave Web Browser; a
// name the query starts is what someone typing it is after. Keywords, the
// command and the app id ("nau" for Files) come after the name's own words,
// and the description after anything in the name.
const words = (text: string) =>
    text.split(/[\s\-_.]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map(w => w.toLowerCase())

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

// Within a tier the apps opened from here most come first (AstalApps counts
// every launch() in its cache). A typo matches no tier; only then does the
// fuzzy score get a say.
function appResults(text: string, limit: number): Result[] {
    const needle = text.trim().toLowerCase()
    let scored = apps.get_list()
        .map(application => ({ application, tier: tier(application, needle) }))
        .filter(s => s.tier > 0)
    if (scored.length === 0)
        scored = apps.fuzzy_query(text).map(application => ({ application, tier: 0 }))
    return scored
        .sort((a, b) => b.tier - a.tier
            || b.application.frequency - a.application.frequency
            || a.application.name.length - b.application.name.length
            || a.application.name.localeCompare(b.application.name))
        .slice(0, limit)
        .map(s => appResult(s.application))
}

// ─── Open windows ─────────────────────────────────────────────────────────────

const hyprland = Hyprland.get_default()

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
        if (inClass < 0 && inTitle < 0) continue
        // a prefix beats a match in the middle, and the class beats the title:
        // window titles pick up whatever file happens to be open in them
        const score = (inClass === 0 ? 4 : inClass > 0 ? 2 : 0) + (inTitle === 0 ? 3 : inTitle > 0 ? 1 : 0)
        scored.push({ client, score })
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ client }) => {
            const entry = entryForClient(client)
            const workspace = client.workspace?.name
            const appName = (entry && GioUnix.DesktopAppInfo.new(entry)?.get_name()) || client.class
            return {
                key: `win:${client.address}`,
                group: "windows" as Group,
                name: client.title || appName,
                detail: workspace ? `${appName} — Workspace ${workspace}` : appName,
                gicon: entry ? giconForEntry(entry) : undefined,
                iconName: entry ? undefined : "window-symbolic",
                verb: "Switch",
                activate: () => { focusWindow(clientSelector(client)) },
            }
        })
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// The settings people go looking through menus for, plus the session controls
// that otherwise need the power button. Each one has to be asked for by name:
// see `actionResults`, which only matches from the start of a word.

const INTERFACE_SCHEMA = "org.gnome.desktop.interface"
const interfaceSettings = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE_SCHEMA, true)
    ? new Gio.Settings({ schema_id: INTERFACE_SCHEMA })
    : null

const setColorScheme = (dark: boolean) =>
    interfaceSettings?.set_string("color-scheme", dark ? "prefer-dark" : "prefer-light")

const run = (command: string) =>
    execAsync(command).catch(e => log.error(`action "${command}" failed:`, e))

type Action = {
    name: string
    detail?: string
    icon: string
    /** extra words that should find it, beyond the name */
    keywords?: string[]
    verb?: string
    activate: () => void
}

const ACTIONS: Action[] = [
    {
        name: "Lock Screen", icon: "system-lock-screen-symbolic",
        keywords: ["lock"], activate: () => run("hyprlock"),
    },
    {
        name: "Sleep", icon: "weather-clear-night-symbolic",
        keywords: ["suspend"], activate: () => run("systemctl sleep"),
    },
    {
        name: "Log Out", icon: "system-log-out-symbolic",
        keywords: ["logout", "sign out", "exit"], activate: () => { exitSession() },
    },
    {
        name: "Restart", icon: "system-reboot-symbolic",
        keywords: ["reboot"], activate: () => run("reboot"),
    },
    {
        name: "Shut Down", icon: "system-shutdown-symbolic",
        keywords: ["poweroff", "power off"], activate: () => run("poweroff"),
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
    if (text.length < 2) return []
    const needle = text.toLowerCase()
    const scored: { action: Action, score: number }[] = []
    for (const action of ACTIONS) {
        const terms = [action.name, ...(action.keywords ?? [])].map(t => t.toLowerCase())
        let score = 0
        for (const term of terms) {
            if (term === needle) score = Math.max(score, 4)
            else if (term.startsWith(needle)) score = Math.max(score, 3)
            else if (term.split(" ").some(word => word.startsWith(needle))) score = Math.max(score, 2)
        }
        if (score > 0) scored.push({ action, score })
    }
    return scored
        .sort((a, b) => b.score - a.score || a.action.name.localeCompare(b.action.name))
        .slice(0, limit)
        .map(({ action }) => ({
            key: `action:${action.name}`,
            group: "actions" as Group,
            name: action.name,
            detail: action.detail,
            iconName: action.icon,
            verb: action.verb ?? "Run",
            activate: action.activate,
        }))
}

// ─── Web search ───────────────────────────────────────────────────────────────
// The last row, always: a search box that comes up empty is a dead end, and
// the next thing the user would do is open a browser and type it again. The
// engine is the search_engine setting.

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
        name: text,
        detail: `Search with ${engine.name}`,
        iconName: "system-search-symbolic",
        verb: "Search",
        activate: () => run(`xdg-open ${GLib.shell_quote(engine.url + encodeURIComponent(text))}`),
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

// ─── The one list ─────────────────────────────────────────────────────────────

export type Answer = { name: string, detail: string }

/**
 * Everything matching `text`, grouped and capped.
 *
 * `answer` is a calculated value the caller has already worked out; it leads
 * the list because it is the reply to the query rather than a place to go.
 */
export function search(text: string, answer: Answer | null, limit: number): Result[] {
    const results: Result[] = []
    if (answer) {
        results.push({
            key: "answer",
            group: "answer",
            name: answer.name,
            detail: answer.detail,
            iconName: "accessories-calculator-symbolic",
            verb: "Copy",
            activate: () => copyToClipboard(answer.name),
        })
    }
    // apps take most of the room: they are what the box is opened for
    const room = limit - results.length
    const windows = windowResults(text, 3)
    const actions = actionResults(text, 3)
    results.push(...appResults(text, Math.max(2, Math.min(4, room - windows.length - actions.length - 1))))
    results.push(...windows)
    results.push(...actions)
    const trimmed = results.slice(0, limit - 1)
    trimmed.push(webResult(text))
    return trimmed
}
