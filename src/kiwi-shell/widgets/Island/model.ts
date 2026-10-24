import { createComputed, createState, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { logger } from "../../log"

const log = logger("island")

// ─── The island ───────────────────────────────────────────────────────────────
// iPhone's Dynamic Island, in the middle of the bar. macOS has none: the Mac
// shows the same things as menu bar items (Now Playing, the privacy
// indicators, and since Tahoe the iPhone's Live Activities), so this part is
// iOS's, in iOS's rules (Apple's Human Interface Guidelines, Live
// Activities):
//
//  - The centre is what the island holds at rest, chosen in the settings:
//    the desktops, the date, the weather or nothing. It stands where the
//    iPhone's camera is, and everything else sits snug either side of it.
//  - An activity is something going on, for as long as it goes on: music
//    playing, the CPU busy for minutes. With one, it shows compact, its two
//    halves either side of the centre. With more, the first stays compact
//    and the next two are bubbles beside the island, one each side (iOS
//    makes the first minimal too, to save a phone's width). Which comes
//    first goes by priority, and between equals by which started first:
//    ActivityKit's relevanceScore. Clicking one opens its expanded card.
//  - An alert is a moment's news: a charger plugged in, headphones
//    connected. It takes the compact activity's place either side of the
//    centre for a few seconds, then gives it back (iOS's island grows into
//    it instead; here the centre stays). One at a time, in order of
//    arrival; a newer one of the same kind replaces the one waiting or
//    showing.
//  - The privacy dots (microphone, camera, screen) are always there while it
//    lasts, at the island's trailing end, whatever else it shows, as on iOS.
//    They are no activity: nothing can push them out.

export type View = () => Gtk.Widget

export type Activity = {
    // stable while the same thing goes on: the island rebuilds an activity's
    // views only when its id changes
    id: string
    // higher goes first (see PRIORITY)
    priority: number
    // compact: either side of the centre
    leading: View
    trailing?: View
    // a bubble beside the island
    minimal: View
    // the card a click opens
    expanded?: View
}

export type Alert = {
    id: string
    // either side of the middle, as an activity's compact halves
    leading: View
    trailing?: View
    // how long it shows
    ms: number
    // which showing this is: the same news again is built anew
    seq?: number
}

/**
 * Activities by priority. The ones that need acting on soon outrank the
 * ones that only keep you company: memory running out freezes the machine
 * within seconds, a hot CPU throttles, music just plays.
 */
export const PRIORITY = {
    memory: 70,
    temperature: 60,
    media: 50,
    cpu: 40,
} as const

// ─── Activities ───────────────────────────────────────────────────────────────

const sources: Accessor<Activity | null>[] = []
const [sourceCount, setSourceCount] = createState(0)

/** A source of one activity at a time; null while there's none. */
export function addActivitySource(source: Accessor<Activity | null>) {
    sources.push(source)
    setSourceCount(sources.length)
}

// when each activity started, by id
const started = new Map<string, number>()

export type Arrangement = {
    compact: Activity | null
    // right of the island, then left
    bubbles: Activity[]
}

export const arrangement: Accessor<Arrangement> = createComputed(get => {
    get(sourceCount)
    const live = sources.map(source => get(source)).filter((a): a is Activity => a !== null)
    const now = GLib.get_monotonic_time()
    for (const a of live) if (!started.has(a.id)) started.set(a.id, now)
    for (const id of [...started.keys()]) if (!live.some(a => a.id === id)) started.delete(id)
    live.sort((a, b) => (b.priority - a.priority) || (started.get(a.id)! - started.get(b.id)!))
    return { compact: live[0] ?? null, bubbles: live.slice(1, 3) }
})

export function activityById(id: string): Activity | null {
    const { compact, bubbles } = arrangement()
    return [compact, ...bubbles].find(a => a?.id === id) ?? null
}

// ─── Expanded ─────────────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; width: number; height: number }

// where each display's island is in its bar, and what it holds, for the
// card to grow out of
export const islandRects = new Map<string, Rect>()
export const islandBodies = new Map<string, Gtk.Widget>()

// the activity whose card is open, the display it opened on and what it
// grows out of there (the island, or the bubble clicked) and where that is
export type Origin = "island" | "bubble"
// what: the widget it grows out of, which the card shows while it is small
export type Opened = { id: string; monitor: string; from: Rect; origin: Origin; what: Gtk.Widget | null }
const [opened, setOpened] = createState<Opened | null>(null)
export { opened }

// the display a card is on, from the moment it opens until it has shrunk
// back into the island: the island itself stays out of sight meanwhile
const [cardOn, setCardOn] = createState<string | null>(null)
export { cardOn, setCardOn }
// what the card stands in for while it is open, from its first frame drawn
// until it has nearly shrunk back: the island, or a bubble (by activity)
export type Covered = { monitor: string; origin: Origin; id: string }
const [covered, setCovered] = createState<Covered | null>(null)
export { covered, setCovered }

export function expand(id: string, monitor: string, bubble?: { rect?: Rect; widget: Gtk.Widget }) {
    log.debug(`open ${id} on ${monitor}${bubble ? " from its bubble" : ""}`)
    setOpened({
        id, monitor, origin: bubble ? "bubble" : "island",
        from: bubble?.rect ?? islandRects.get(monitor) ?? { x: 0, y: 4, width: 0, height: 34 },
        what: bubble?.widget ?? islandBodies.get(monitor) ?? null,
    })
}

export function collapse() {
    log.debug(`close ${opened()?.id ?? "nothing"}`)
    if (!opened()) return
    setOpened(null)
    nextAlert()
}

// an activity that ends takes its card with it
arrangement.subscribe(() => {
    const open = opened()
    if (open && open.id !== PRIVACY_ID && !activityById(open.id)) collapse()
})

// the privacy dots' card, which isn't an activity's
export const PRIVACY_ID = "privacy"

// ─── Alerts ───────────────────────────────────────────────────────────────────

const queue: Alert[] = []
const [alert, setAlert] = createState<Alert | null>(null)
export { alert }
let alertTimer = 0
let alertSeq = 0

export function showAlert(next: Alert) {
    next = { ...next, seq: ++alertSeq }
    const showing = alert()
    if (showing?.id === next.id) {
        // the same news again: the new one, for its full time
        GLib.source_remove(alertTimer)
        alertTimer = 0
        setAlert(null)
        queue.unshift(next)
        nextAlert()
        return
    }
    const waiting = queue.findIndex(a => a.id === next.id)
    if (waiting >= 0) queue.splice(waiting, 1, next)
    else queue.push(next)
    if (!showing) nextAlert()
}

function nextAlert() {
    // an open card keeps the news waiting until it closes
    if (alertTimer || opened()) return
    const next = queue.shift() ?? null
    setAlert(next)
    if (!next) return
    alertTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, next.ms, () => {
        alertTimer = 0
        setAlert(null)
        nextAlert()
        return GLib.SOURCE_REMOVE
    })
}
