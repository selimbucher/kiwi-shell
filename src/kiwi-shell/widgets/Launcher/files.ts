import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import { logger } from "../../log"

const log = logger("launcher")

// ─── Files and folders ────────────────────────────────────────────────────────
// What Spotlight finds by name in the home folder. The names are gathered
// when Spotlight is first asked for one, kept for ten minutes and gathered
// again only when it's asked after that: nothing watches the disk meanwhile.
// Bounded, so a big home costs a moment, once: seven folders deep, no hidden
// folders and none of the ones tools fill (node_modules, build output), at
// most 80 000 names. Files used lately (GTK's list) count for more; a path
// typed (/…, ~/…) lists its folder instead.

const HOME = GLib.get_home_dir()
const FRESH_MS = 10 * 60 * 1000
const DEEPEST = 7
const MOST = 80_000
const BATCH = 256
const SKIPPED = new Set([
    "node_modules", "__pycache__", "site-packages", "target", "build", "dist", "out",
    "venv", "env", "vendor", "bower_components", "Trash",
])
const ATTRIBUTES = "standard::name,standard::type,standard::is-hidden,time::modified"

export type Entry = { path: string, name: string, lower: string, dir: boolean, depth: number, modified: number }

let entries: Entry[] = []
let gatheredAt = 0
let gathering = false
// the results look again as the names come in
const [version, setVersion] = createState(0)
export const filesVersion = version

/** The names gathered, if they're old or missing: Spotlight is about to search. */
export function prepareFiles() {
    if (gathering || Date.now() - gatheredAt < FRESH_MS) return
    gathering = true
    const started = GLib.get_monotonic_time()
    const found: Entry[] = []
    const queue: { file: Gio.File, depth: number }[] = [{ file: Gio.File.new_for_path(HOME), depth: 0 }]
    let shown = 0

    const finish = () => {
        entries = found
        gatheredAt = Date.now()
        gathering = false
        setVersion(v => v + 1)
        log.debug(`Spotlight: ${found.length} names in ${Math.round((GLib.get_monotonic_time() - started) / 1000)} ms`)
    }

    const next = () => {
        const folder = queue.shift()
        if (!folder || found.length >= MOST) return finish()
        folder.file.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, null, (_file, result) => {
                let enumerator: Gio.FileEnumerator
                try {
                    enumerator = folder.file.enumerate_children_finish(result)
                } catch {
                    return next()
                }
                const more = () => enumerator.next_files_async(BATCH, GLib.PRIORITY_LOW, null, (_e, res) => {
                    let infos: Gio.FileInfo[] = []
                    try {
                        infos = enumerator.next_files_finish(res)
                    } catch { /* unreadable: what came so far */ }
                    for (const info of infos) {
                        const name = info.get_name()
                        if (info.get_is_hidden() || name.startsWith(".")) continue
                        const type = info.get_file_type()
                        const dir = type === Gio.FileType.DIRECTORY
                        if (!dir && type !== Gio.FileType.REGULAR) continue
                        const child = folder.file.get_child(name)
                        found.push({
                            path: child.get_path()!, name, lower: name.toLowerCase(), dir,
                            depth: folder.depth + 1,
                            modified: info.get_modification_date_time()?.to_unix() ?? 0,
                        })
                        if (dir && folder.depth + 1 < DEEPEST && !SKIPPED.has(name))
                            queue.push({ file: child, depth: folder.depth + 1 })
                    }
                    // a first lot to search, before the rest is in
                    if (!entries.length && found.length - shown > 4000) {
                        shown = found.length
                        entries = found.slice()
                        setVersion(v => v + 1)
                    }
                    if (infos.length === BATCH) return more()
                    enumerator.close_async(GLib.PRIORITY_LOW, null, null)
                    next()
                })
                more()
            })
    }
    next()
}

// ─── Recently used ────────────────────────────────────────────────────────────

let recentAt = 0
let recent = new Map<string, number>()

// GTK's list of files opened lately, path → when, read once a minute at most
function recentlyUsed(): Map<string, number> {
    if (Date.now() - recentAt < 60_000) return recent
    recentAt = Date.now()
    recent = new Map()
    for (const item of Gtk.RecentManager.get_default().get_items()) {
        const uri = item.get_uri()
        if (!uri.startsWith("file://")) continue
        const path = Gio.File.new_for_uri(uri).get_path()
        if (path) recent.set(path, item.get_visited()?.to_unix() ?? item.get_modified()?.to_unix() ?? 0)
    }
    return recent
}

/** A file opened from Spotlight goes on the list, as an app would put it. */
export function markUsed(path: string) {
    try {
        Gtk.RecentManager.get_default().add_item(Gio.File.new_for_path(path).get_uri())
        recentAt = 0
    } catch { /* no list to put it on */ }
}

// ─── Searching ────────────────────────────────────────────────────────────────

const words = (text: string) => text.split(/[\s\-_.]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map(w => w.toLowerCase())

export type Found = { entry: Entry, score: number }

/**
 * The files and folders whose names answer `text`, best first: a name that
 * is the query, then one it starts, a word in it it starts, then one it's in.
 * Several words find a file by the folders it is in too ("kiwi zoom").
 */
export function findFiles(text: string, limit: number): Found[] {
    const needle = text.trim().toLowerCase()
    if (needle.length < 2) return []
    const used = recentlyUsed()
    const now = Date.now() / 1000
    const parts = needle.split(/\s+/)
    const last = parts[parts.length - 1]
    const known = new Set<string>()
    const found: Found[] = []

    const score = (entry: Entry): number => {
        let base = 0
        if (parts.length === 1) {
            const stem = entry.lower.replace(/\.[^.]+$/, "")
            if (entry.lower === needle || stem === needle) base = 65
            else if (entry.lower.startsWith(needle)) base = 55
            else if (words(entry.name).some(w => w.startsWith(needle))) base = 45
            else if (needle.length >= 3 && entry.lower.includes(needle)) base = 30
        } else {
            const relative = entry.path.slice(HOME.length).toLowerCase()
            if (!parts.every(p => relative.includes(p))) return 0
            base = entry.lower.startsWith(last) || words(entry.name).some(w => w.startsWith(last)) ? 50 : 35
        }
        if (!base) return 0
        const when = used.get(entry.path)
        // opened lately: up to 15 more, over a month; changed lately: up to 5
        if (when) base += 15 * Math.max(0, 1 - (now - when) / (30 * 86400))
        base += 5 * Math.max(0, 1 - (now - entry.modified) / (7 * 86400))
        // deep inside a tree is less likely what was meant
        base -= Math.max(0, entry.depth - 3)
        return base
    }

    for (const entry of entries) {
        const s = score(entry)
        if (s > 0) {
            found.push({ entry, score: s })
            known.add(entry.path)
        }
    }
    // used lately but outside what's gathered (a drive, a hidden folder)
    for (const [path] of used) {
        if (known.has(path)) continue
        const name = GLib.path_get_basename(path)
        const entry: Entry = { path, name, lower: name.toLowerCase(), dir: false, depth: 3, modified: 0 }
        const s = score(entry)
        if (s > 0 && GLib.file_test(path, GLib.FileTest.EXISTS)) found.push({ entry, score: s })
    }
    found.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length)
    return found.slice(0, limit)
}

// ─── A path typed ─────────────────────────────────────────────────────────────

/** Whether `text` is a path being typed. */
export const isPath = (text: string) => /^(~|\/)/.test(text.trim())

export const expandPath = (text: string) => text.trim().replace(/^~(?=\/|$)/, HOME)

/** The entries of the folder a typed path is in that start as its last part. */
export function listPath(text: string, limit: number): Entry[] {
    const full = expandPath(text)
    const slash = full.lastIndexOf("/")
    const folder = full.slice(0, slash + 1) || "/"
    const start = full.slice(slash + 1).toLowerCase()
    const listed: Entry[] = []
    try {
        const enumerator = Gio.File.new_for_path(folder).enumerate_children(ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, null)
        for (let info = enumerator.next_file(null); info && listed.length < 400; info = enumerator.next_file(null)) {
            const name = info.get_name()
            // hidden ones once a dot is typed
            if (name.startsWith(".") && !start.startsWith(".")) continue
            if (!name.toLowerCase().startsWith(start)) continue
            listed.push({
                path: folder + name, name, lower: name.toLowerCase(),
                dir: info.get_file_type() === Gio.FileType.DIRECTORY, depth: 0,
                modified: info.get_modification_date_time()?.to_unix() ?? 0,
            })
        }
        enumerator.close(null)
    } catch {
        return []
    }
    listed.sort((a, b) => Number(b.dir) - Number(a.dir) || a.lower.localeCompare(b.lower))
    return listed.slice(0, limit)
}

/** The path shown short: ~ for the home folder. */
export const shortPath = (path: string) => path.startsWith(HOME) ? "~" + path.slice(HOME.length) : path

/** A file's icon by its name's type: a picture, a PDF, a folder. */
export function iconFor(entry: Entry): Gio.Icon {
    if (entry.dir) return Gio.ThemedIcon.new("folder")
    const [type] = Gio.content_type_guess(entry.name, null)
    return Gio.content_type_get_icon(type)
}
