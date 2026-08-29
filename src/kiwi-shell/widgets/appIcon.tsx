import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import { Binding } from "ags"
import { classToEntry, execToEntry, titleMatchers, mapVersion } from "./desktopEntries"
import { logger } from "../log"
const log = logger("app-icon")

/**
 * Resolves a Hyprland client to a .desktop entry ID.
 *   1. Class lookup (covers StartupWMClass, .desktop file stems and
 *      reverse-DNS aliases of both).
 *   2. Title regex against entries declaring X-Kiwi-TitleMatch — for apps
 *      whose class is generic, notably protontricks-launched games
 *      which all share `steam_proton`.
 *   3. /proc/<pid>/cmdline matched against the entries' executables — for
 *      apps launched through a shared runtime (electron apps report class
 *      `electron`, java apps report their AWT class name, …).
 *   4. Fallback: synthesize a .desktop name from the class.
 */
export function entryForClient(client: any): string {
    const cls = (client["initial-class"] ?? "").toLowerCase()

    const byClass = classToEntry.get(cls)
    if (byClass) {
        return byClass
    }

    // reverse-DNS app ids (md.Obsidian, org.gnome.Nautilus) often pair with
    // plainly-named desktop files — retry on the last segment
    if (cls.includes(".")) {
        const byLastSegment = classToEntry.get(cls.split(".").pop()!)
        if (byLastSegment) {
            return byLastSegment
        }
    }

    const title = client["initial-title"] ?? client.title ?? ""
    if (title) {
        const matched = titleMatchers.find(m => m.regex.test(title))
        if (matched) {
            return matched.entry
        }
    }

    const byPid = entryFromPid(client.pid)
    if (byPid) {
        log.debug(`class "${cls}" resolved via pid ${client.pid} → ${byPid}`)
        return byPid
    }

    const fallback = cls + ".desktop"
    log.debug(`unresolved class "${cls}" (pid ${client.pid}) → fallback ${fallback}`)
    return fallback
}

// ─── pid → entry ──────────────────────────────────────────────────────────────
// Matches the process command line against the entries' executables: first
// each argument's basename, then every path component — the runtime usually
// names the app somewhere in its arguments (electron loads
// …/share/obsidian/app.asar, java launchers carry the install dir on the
// classpath).

// only successful resolutions are cached: launchers like install4j swap
// processes at startup, and a miss cached against a transient state would
// stick to the pid forever (a /proc read costs microseconds anyway)
const pidEntryCache = new Map<number, string>()
mapVersion.subscribe(() => pidEntryCache.clear())

export function entryFromCmdline(cmdline: string): string | null {
    const argv = cmdline.split("\0").filter(Boolean)
    for (const token of argv) {
        const byBase = execToEntry.get(GLib.path_get_basename(token).toLowerCase())
        if (byBase) return byBase
    }
    for (const token of argv) {
        for (const part of token.toLowerCase().split(/[/:\s]+/)) {
            const byPart = execToEntry.get(part)
            if (byPart) return byPart
        }
    }
    return null
}

function entryFromPid(pid: number | undefined): string | null {
    if (!pid || pid <= 0) return null
    const cached = pidEntryCache.get(pid)
    if (cached) return cached
    let entry: string | null = null
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`)
        if (ok) entry = entryFromCmdline(new TextDecoder().decode(bytes))
    } catch (e) {
        log.debug(`pid ${pid}: /proc read failed (${e})`)
    }
    if (entry) pidEntryCache.set(pid, entry)
    return entry
}

// ─── entry → icon ─────────────────────────────────────────────────────────────
// A GIcon instead of an icon name: handles absolute Icon= paths, and falls
// back through the app-id-derived names when Icon= names nothing installed
// (packages forget to ship their icon more often than one would hope).
// Candidates are filtered through has_icon here because GTK walks the theme
// chain per *theme*, not per name — a generic name inside the ThemedIcon
// would shadow an app icon that only exists further down the chain.

export function giconForEntry(entry: string): Gio.Icon {
    const appInfo = GioUnix.DesktopAppInfo.new(entry)
    const iconStr = appInfo?.get_string("Icon")
    if (iconStr && GLib.path_is_absolute(iconStr)) {
        return Gio.FileIcon.new(Gio.File.new_for_path(iconStr))
    }

    const candidates: string[] = []
    const push = (n?: string | null) => {
        if (n && !candidates.includes(n)) candidates.push(n)
    }
    push(iconStr)
    const stem = entry.replace(/\.desktop$/, "")
    push(stem)
    push(stem.toLowerCase())
    if (stem.includes(".")) {
        const last = stem.split(".").pop()
        push(last)
        push(last?.toLowerCase())
    }
    push(appInfo?.get_startup_wm_class()?.toLowerCase())

    const display = Gdk.Display.get_default()
    const theme = display ? Gtk.IconTheme.get_for_display(display) : null
    const names = theme ? candidates.filter(n => theme.has_icon(n)) : candidates
    if (names.length === 0) {
        log.debug(`no icon for entry ${entry} (appInfo=${!!appInfo}, ` +
            `candidates=[${candidates.join(", ")}]) → generic`)
        // only as a lone fallback — inside a ThemedIcon with real
        // candidates, the active theme's generic icon would shadow app
        // icons that exist further down the theme chain (GTK searches per
        // theme, not per name)
        names.push("application-x-executable")
    }
    return Gio.ThemedIcon.new_from_names(names)
}

export function AppIconImage({ entry, pixelSize = 56, cssClass = "dock-app-icon" }: {
    entry: string
    pixelSize?: number | Binding<number>
    cssClass?: string
}) {
    return (
        <Gtk.Image
            gicon={giconForEntry(entry)}
            pixelSize={pixelSize}
            class={cssClass}
        />
    )
}
