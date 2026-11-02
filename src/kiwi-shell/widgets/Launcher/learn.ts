import GLib from "gi://GLib"
import { readFile, writeFileAsync } from "ags/file"
import { logger } from "../../log"

const log = logger("launcher")

// ─── What was picked for what was typed ───────────────────────────────────────
// Spotlight learns as a Mac's does: the row chosen for a query comes first the
// next time that query, or the start of it, is typed. Kept for every start of
// the query ("b", "br", "bra"), counted and dated, in the state directory;
// a pick fades over a month and the least recent queries go past a few
// hundred. Commands, sums and the web search aren't learned: what a command
// line did once is no reason to put it first.

const FILE = `${GLib.get_user_state_dir()}/kiwi-shell/spotlight.json`
const MAX_QUERIES = 400
const LONGEST = 16
const HALF_LIFE_DAYS = 30

type Pick = { count: number, last: number }
type Picks = Record<string, Record<string, Pick>>

let picks: Picks = load()
let saving = 0

function load(): Picks {
    try {
        const parsed = JSON.parse(readFile(FILE))
        return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
        return {}
    }
}

const normalized = (query: string) => query.trim().toLowerCase().replace(/\s+/g, " ")
const now = () => Math.floor(Date.now() / 1000)

function save() {
    if (saving) GLib.source_remove(saving)
    saving = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
        saving = 0
        // the oldest queries go first
        const queries = Object.keys(picks)
        if (queries.length > MAX_QUERIES) {
            const latest = (q: string) => Math.max(...Object.values(picks[q]).map(p => p.last))
            queries.sort((a, b) => latest(b) - latest(a))
            for (const q of queries.slice(MAX_QUERIES)) delete picks[q]
        }
        GLib.mkdir_with_parents(GLib.path_get_dirname(FILE), 0o755)
        writeFileAsync(FILE, JSON.stringify(picks)).catch(e => log.warn("couldn't keep Spotlight's picks:", e))
        return GLib.SOURCE_REMOVE
    })
}

/** `key` was chosen for `query`. */
export function remember(query: string, key: string) {
    const q = normalized(query)
    if (!q) return
    const time = now()
    for (let length = 1; length <= Math.min(q.length, LONGEST); length++) {
        const start = q.slice(0, length)
        const seen = picks[start] ??= {}
        const pick = seen[key] ??= { count: 0, last: time }
        pick.count++
        pick.last = time
    }
    save()
}

/** How strongly `key` was chosen for `query` before, 0 to 1. */
export function learned(query: string, key: string): number {
    const q = normalized(query).slice(0, LONGEST)
    const pick = picks[q]?.[key]
    if (!pick) return 0
    const days = (now() - pick.last) / 86400
    return Math.min(pick.count, 5) / 5 * 0.5 ** (days / HALF_LIFE_DAYS)
}
