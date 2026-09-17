import GLib from "gi://GLib"
import Notifd from "gi://AstalNotifd"
import Hyprland from "gi://AstalHyprland"
import { createBinding, createComputed, createState } from "ags"
import { logger } from "../../log"

const log = logger("notifications")
const notifd = Notifd.get_default()
const hyprland = Hyprland.get_default()

const DEFAULT_TIMEOUT = 5000
// banners resume with at least this much time after the pointer leaves
const RESUME_MIN_MS = 1500
const MAX_BANNERS = 3
const MAX_HISTORY = 50
// focus has to rest on an app's window this long before its notifications
// count as seen; with focus-follows-mouse, passing over a window doesn't
const FOCUS_DWELL_MS = 1500

// banner: on screen as a toast; history: only listed in the center
type Place = "banner" | "history"

interface Entry {
    place: Place
    // monotonic ms; 0 for notifications kept from a previous shell instance
    arrived: number
}

const now = () => GLib.get_monotonic_time() / 1000

export const [centerOpen, setCenterOpen] = createState(false)
const [expandedGroups, setExpandedGroups] = createState<ReadonlySet<string>>(new Set())
const dnd = createBinding(notifd, "dont-disturb")

// ─── Identity ─────────────────────────────────────────────────────────────────

// Center entries are grouped by app; within an app, notifications with the
// same text collapse into one card with a count.
const groupKeyOf = (n: Notifd.Notification) =>
    n.appName || n.desktopEntry || "unknown"

const contentKeyOf = (n: Notifd.Notification) =>
    [groupKeyOf(n), n.summary, n.body].join("\u0001")

// A card keeps its key while duplicates come and go, and when an app replaces
// its only notification with new text, so neither restarts its animation.
const cardKeys = new Map<number, string>()

function assignCardKey(n: Notifd.Notification) {
    const current = cardKeys.get(n.id)
    const shared = current !== undefined &&
        [...cardKeys].some(([id, key]) => id !== n.id && key === current)
    if (current === undefined || shared) cardKeys.set(n.id, `c${contentKeyOf(n)}`)
}

// Notifications the daemon kept from a previous shell instance go straight
// to history, newest first.
function seedExisting(): Map<number, Entry> {
    try {
        const existing = [...(notifd.get_notifications() ?? [])]
        existing.sort((a, b) => b.time - a.time || b.id - a.id)
        for (const n of existing) cardKeys.set(n.id, `c${contentKeyOf(n)}`)
        return new Map(existing.map(n => [n.id, { place: "history" as const, arrived: 0 }]))
    } catch (error) {
        log.error("Failed to read stored notifications:", error)
        return new Map()
    }
}

// newest first
const [entries, setEntries] = createState<ReadonlyMap<number, Entry>>(seedExisting())

// ─── Banner timers ────────────────────────────────────────────────────────────

interface Timer {
    source: number
    remaining: number
    startedAt: number
}

const timers = new Map<number, Timer>()
let hovering = false

function clearTimer(id: number) {
    const timer = timers.get(id)
    if (!timer) return
    if (timer.source) GLib.source_remove(timer.source)
    timers.delete(id)
}

function armTimer(id: number, timer: Timer) {
    timer.startedAt = now()
    timer.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(timer.remaining)), () => {
        timer.source = 0
        timers.delete(id)
        expire(id)
        return GLib.SOURCE_REMOVE
    })
}

function startTimer(n: Notifd.Notification) {
    clearTimer(n.id)
    // critical notifications stay until acted upon, like macOS alerts
    if (n.urgency === Notifd.Urgency.CRITICAL) return
    const timer: Timer = {
        source: 0,
        remaining: n.expireTimeout > 0 ? n.expireTimeout : DEFAULT_TIMEOUT,
        startedAt: 0,
    }
    timers.set(n.id, timer)
    if (!hovering) armTimer(n.id, timer)
}

// the pointer resting on any banner holds all of them
export function setBannerHover(hover: boolean) {
    if (hover === hovering) return
    hovering = hover
    for (const [id, timer] of timers) {
        if (hover) {
            if (!timer.source) continue
            GLib.source_remove(timer.source)
            timer.source = 0
            timer.remaining -= now() - timer.startedAt
        } else if (!timer.source) {
            timer.remaining = Math.max(timer.remaining, RESUME_MIN_MS)
            armTimer(id, timer)
        }
    }
}

function expire(id: number) {
    const n = notifd.get_notification(id)
    if (n?.transient) {
        // transient hint: never kept in history
        n.dismiss()
        return
    }
    moveToHistory([id])
}

// ─── State changes ────────────────────────────────────────────────────────────

// duplicates that arrived while the banner was on screen, per content key
const bursts = new Map<string, number>()
// when that banner first appeared: repeats keep its place in the stack
const burstStarts = new Map<string, number>()

function moveToHistory(ids: readonly number[]) {
    const current = entries()
    const next = new Map(current)
    let changed = false
    for (const id of ids) {
        const entry = current.get(id)
        clearTimer(id)
        if (entry?.place !== "banner") continue
        next.set(id, { ...entry, place: "history" })
        changed = true
    }
    if (!changed) return
    setEntries(next)
    forgetBursts()
    trimHistory()
}

function forgetBursts() {
    const onScreen = new Set<string>()
    for (const [id, entry] of entries()) {
        if (entry.place !== "banner") continue
        const n = notifd.get_notification(id)
        if (n) onScreen.add(contentKeyOf(n))
    }
    for (const key of [...bursts.keys()]) {
        if (onScreen.has(key)) continue
        bursts.delete(key)
        burstStarts.delete(key)
    }
}

function trimHistory() {
    const history = [...entries()].filter(([, e]) => e.place === "history")
    for (const [id] of history.slice(MAX_HISTORY)) {
        const n = notifd.get_notification(id)
        if (n) n.dismiss()
        else removeEntry(id)
    }
}

// Removals are applied together one idle later: dismissing a card with 30
// duplicates, or clearing all, resolves notifications one by one, and each
// step would otherwise lay out and animate a state that lasts no time.
const pendingRemovals = new Set<number>()
let removalSource = 0

function removeEntry(id: number) {
    clearTimer(id)
    pendingRemovals.add(id)
    if (removalSource) return
    removalSource = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
        removalSource = 0
        const next = new Map(entries())
        for (const removed of pendingRemovals) {
            next.delete(removed)
            cardKeys.delete(removed)
        }
        pendingRemovals.clear()
        if (next.size !== entries().size) {
            setEntries(next)
            forgetBursts()
        }
        return GLib.SOURCE_REMOVE
    })
}

notifd.connect("notified", (_, id: number) => {
    const n = notifd.get_notification(id)
    if (!n) return
    pendingRemovals.delete(id)
    assignCardKey(n)
    const asBanner = !centerOpen() && !dnd()
    const rest = new Map(entries())
    rest.delete(id)
    const next = new Map<number, Entry>([[id, { place: asBanner ? "banner" : "history", arrived: now() }]])
    for (const [otherId, entry] of rest) next.set(otherId, entry)

    if (!asBanner) {
        clearTimer(id)
        setEntries(next)
        trimHistory()
        return
    }

    // the same text again while its banner is up: the banner stays and counts
    const key = contentKeyOf(n)
    const repeats: number[] = []
    const bannerKeys: string[] = []
    for (const [otherId, entry] of rest) {
        if (entry.place !== "banner") continue
        const other = notifd.get_notification(otherId)
        if (!other) continue
        const otherKey = contentKeyOf(other)
        if (otherKey === key) repeats.push(otherId)
        else if (!bannerKeys.includes(otherKey)) bannerKeys.push(otherKey)
    }
    bursts.set(key, repeats.length > 0 ? (bursts.get(key) ?? 1) + 1 : 1)
    if (repeats.length === 0) burstStarts.set(key, now())
    for (const otherId of repeats) {
        clearTimer(otherId)
        next.set(otherId, { ...next.get(otherId)!, place: "history" })
    }

    // only a few banners at once; the oldest ones move on to the center
    bannerKeys.sort((a, b) => (burstStarts.get(b) ?? 0) - (burstStarts.get(a) ?? 0))
    const overflow = new Set(bannerKeys.slice(MAX_BANNERS - 1))
    if (overflow.size > 0) {
        for (const [otherId, entry] of next) {
            if (otherId === id || entry.place !== "banner") continue
            const other = notifd.get_notification(otherId)
            if (!other || !overflow.has(contentKeyOf(other))) continue
            clearTimer(otherId)
            next.set(otherId, { ...entry, place: "history" })
        }
    }

    setEntries(next)
    startTimer(n)
    forgetBursts()
    trimHistory()
})

notifd.connect("resolved", (_, id: number) => removeEntry(id))

dnd.subscribe(() => {
    if (!dnd()) return
    moveToHistory([...entries()].filter(([, e]) => e.place === "banner").map(([id]) => id))
})

// ─── Center ───────────────────────────────────────────────────────────────────

// the window that had focus when the center opened
let focusedAtOpen: string | null = null

export function openCenter() {
    if (centerOpen()) return
    focusedAtOpen = hyprland.get_focused_client()?.get_address() ?? null
    // open first: the center lists banners too, so their cards stay put
    // while they move to history
    setCenterOpen(true)
    moveToHistory([...entries()].filter(([, e]) => e.place === "banner").map(([id]) => id))
}

export function closeCenter() {
    if (!centerOpen()) return
    setCenterOpen(false)
    setExpandedGroups(new Set())
}

export function toggleGroup(groupKey: string) {
    const next = new Set(expandedGroups())
    if (next.has(groupKey)) next.delete(groupKey)
    else next.add(groupKey)
    setExpandedGroups(next)
}

export function clearAll() {
    for (const id of [...entries().keys()]) {
        const n = notifd.get_notification(id)
        if (n) n.dismiss()
        else removeEntry(id)
    }
}

export function dismissAll(members: readonly Notifd.Notification[]) {
    for (const n of members) {
        if (notifd.get_notification(n.id) === n) n.dismiss()
    }
}

// ─── Seen on focus ────────────────────────────────────────────────────────────

// Resting on a window of the sending app counts as having seen what it sent
// before that moment (GNOME clears an app's notifications the same way).
// Critical and resident notifications stay.
export function appMatchesClient(n: Notifd.Notification, client: Hyprland.Client): boolean {
    const targets = [n.desktopEntry?.replace(/\.desktop$/i, ""), n.appName]
        .filter(Boolean)
        .map(s => String(s).toLowerCase())
    const classes = [client.get_initial_class(), client.get_class()]
        .filter(Boolean)
        .map(s => s.toLowerCase())
    return targets.some(t => classes.includes(t))
}

let dwellSource = 0
hyprland.connect("notify::focused-client", () => {
    if (dwellSource) GLib.source_remove(dwellSource)
    dwellSource = 0
    const client = hyprland.get_focused_client()
    if (!client) return
    // Another window took focus while the center is open: a click that went
    // past the backdrop to a window, or a keybind. Either way, it's done.
    if (centerOpen() && client.get_address() !== focusedAtOpen) closeCenter()
    const address = client.get_address()
    const since = now()
    dwellSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_DWELL_MS, () => {
        dwellSource = 0
        if (hyprland.get_focused_client()?.get_address() !== address) return GLib.SOURCE_REMOVE
        for (const [id, entry] of entries()) {
            if (entry.arrived >= since) continue
            const n = notifd.get_notification(id)
            if (!n || n.urgency === Notifd.Urgency.CRITICAL || n.resident) continue
            if (appMatchesClient(n, client)) n.dismiss()
        }
        return GLib.SOURCE_REMOVE
    })
})

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface CardRow {
    kind: "card"
    key: string
    // same app and text, newest first
    members: Notifd.Notification[]
    count: number
    banner: boolean
    groupKey: string
    // collapsed head of a group: rows hidden behind it
    hiddenRows: number
    foldInto?: string
}

// above an expanded group: app name, "Show Less" and clear
export interface GroupRow {
    kind: "group"
    key: string
    groupKey: string
    // every notification of the app, newest first
    members: Notifd.Notification[]
    foldInto: string
}

export type Row =
    | CardRow
    | GroupRow
    | { kind: "header"; key: "header"; foldInto?: undefined }
    | { kind: "empty"; key: "empty"; foldInto?: undefined }

export interface Layout {
    rows: Row[]
    // hidden row key → key of the group head it collapsed behind
    foldsInto: Map<string, string>
}

// one card per text, so a banner and its later center entry are the same card
function dedupe(notifs: Notifd.Notification[], usedKeys: Set<string>) {
    const cards = new Map<string, Notifd.Notification[]>()
    for (const n of notifs) {
        const key = contentKeyOf(n)
        const card = cards.get(key)
        if (card) card.push(n)
        else cards.set(key, [n])
    }
    return [...cards].map(([contentKey, members]) => {
        const oldest = members[members.length - 1]
        let key = cardKeys.get(oldest.id) ?? `c${contentKey}`
        // a replaced notification can still hold the key of its old text
        if (usedKeys.has(key)) key = `${key}#${oldest.id}`
        usedKeys.add(key)
        return { key, contentKey, members }
    })
}

export const layout = createComputed<Layout>(get => {
    const state = get(entries)
    const open = get(centerOpen)
    const expanded = get(expandedGroups)
    const foldsInto = new Map<string, string>()

    const notifs: Notifd.Notification[] = []
    for (const id of state.keys()) {
        const n = notifd.get_notification(id)
        if (n) notifs.push(n)
    }
    const usedKeys = new Set<string>()

    if (!open) {
        const banners = notifs.filter(n => state.get(n.id)?.place === "banner")
        const cards = dedupe(banners, usedKeys)
            .sort((a, b) => (burstStarts.get(b.contentKey) ?? 0) - (burstStarts.get(a.contentKey) ?? 0))
        const rows: Row[] = cards.slice(0, MAX_BANNERS).map(card => ({
            kind: "card",
            key: card.key,
            members: card.members,
            count: bursts.get(card.contentKey) ?? 1,
            banner: true,
            groupKey: groupKeyOf(card.members[0]),
            hiddenRows: 0,
        }))
        return { rows, foldsInto }
    }

    const rows: Row[] = [{ kind: "header", key: "header" }]
    if (notifs.length === 0) {
        rows.push({ kind: "empty", key: "empty" })
        return { rows, foldsInto }
    }

    const groups = new Map<string, Notifd.Notification[]>()
    for (const n of notifs) {
        const key = groupKeyOf(n)
        const group = groups.get(key)
        if (group) group.push(n)
        else groups.set(key, [n])
    }
    for (const [groupKey, members] of groups) {
        const cards = dedupe(members, usedKeys)
        const head = cards[0]
        const isExpanded = expanded.has(groupKey) && cards.length > 1
        const groupHeaderKey = `g${groupKey}`
        if (isExpanded) {
            rows.push({ kind: "group", key: groupHeaderKey, groupKey, members, foldInto: head.key })
        } else {
            foldsInto.set(groupHeaderKey, head.key)
        }
        cards.forEach((card, index) => {
            if (index > 0 && !isExpanded) {
                foldsInto.set(card.key, head.key)
                return
            }
            rows.push({
                kind: "card",
                key: card.key,
                members: card.members,
                count: card.members.length,
                banner: false,
                groupKey,
                hiddenRows: index === 0 && !isExpanded ? cards.length - 1 : 0,
                foldInto: index > 0 ? head.key : undefined,
            })
        })
    }
    return { rows, foldsInto }
})
