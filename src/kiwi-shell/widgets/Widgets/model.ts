import GLib from "gi://GLib"
import { createMemo, createState, type Accessor } from "ags"

import { conf, saveSetting } from "../config"
import { batteries } from "../services/batteries"

// ─── Widgets ──────────────────────────────────────────────────────────────────
// The widgets under the notifications in Notification Center, as on a Mac:
// a list in config.json ("widgets"), each a kind and a size, laid out in two
// columns. A small one takes a column, a medium one both, a large one both
// and twice the height. They're edited in place: right-click for a size or
// to remove one, Edit Widgets for the gallery.

export type WidgetSize = "small" | "medium" | "large"
export const SIZES: WidgetSize[] = ["small", "medium", "large"]
export const SIZE_NAMES: Record<WidgetSize, string> = { small: "Small", medium: "Medium", large: "Large" }

export type WidgetSpec = {
    id: string
    kind: string
    size: WidgetSize
    // where it's about, for the ones about a place (weather); none: the
    // place in Kiwi Settings, else the time zone's city
    city?: string
    // the world clock's cities: a zone (Europe/Zurich), or a city of
    // another name in it ({ "name": "Bern", "zone": "Europe/Zurich" })
    zones?: ClockCity[]
}

export type ClockCity = string | { name: string, zone: string }

const isClockCity = (c: unknown) => typeof c === "string"
    || (!!c && typeof c === "object" && typeof (c as any).name === "string" && typeof (c as any).zone === "string")

export type Kind = {
    kind: string
    // the app it belongs to in the gallery
    app: string
    name: string
    description: string
    icon: string
    sizes: WidgetSize[]
}

/** Every kind there is, in the gallery's order. */
export const KINDS: Kind[] = [
    {
        kind: "up-next", app: "Calendar", name: "Up Next", icon: "x-office-calendar-symbolic",
        description: "See the events coming up today and the next days.",
        sizes: ["small", "medium", "large"],
    },
    {
        kind: "month", app: "Calendar", name: "Month", icon: "x-office-calendar-symbolic",
        description: "See the month at a glance, and what's on any day of it.",
        sizes: ["small", "medium", "large"],
    },
    {
        kind: "weather", app: "Weather", name: "Forecast", icon: "weather-few-clouds-symbolic",
        description: "See the weather now, the next hours and the coming days.",
        sizes: ["small", "medium", "large"],
    },
    {
        kind: "batteries", app: "Batteries", name: "Batteries", icon: "battery-good-symbolic",
        description: "Keep an eye on the charge of this computer and the devices connected to it.",
        sizes: ["small", "medium", "large"],
    },
    {
        kind: "world-clock", app: "Clock", name: "World Clock", icon: "preferences-system-time-symbolic",
        description: "See the time in cities around the world.",
        sizes: ["small", "medium", "large"],
    },
    {
        kind: "note", app: "Notes", name: "Note", icon: "accessories-text-editor-symbolic",
        description: "Jot something down where it stays in view.",
        sizes: ["small", "medium", "large"],
    },
]

export const kindOf = (kind: string) => KINDS.find(k => k.kind === kind)

// ─── The list ─────────────────────────────────────────────────────────────────

// Kinds that aren't known (from a newer kiwi, mistyped) are left out, and
// entries without an id get one from their kind and place. A field of the
// wrong kind (written by hand) is dropped, the widget on its default.
function specsOf(raw: unknown): WidgetSpec[] {
    if (!Array.isArray(raw)) return []
    const taken = new Set<string>()
    const specs: WidgetSpec[] = []
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue
        const kind = kindOf((entry as any).kind)
        if (!kind) continue
        const size: WidgetSize = kind.sizes.includes((entry as any).size) ? (entry as any).size : kind.sizes[0]
        let id = typeof (entry as any).id === "string" ? (entry as any).id : ""
        for (let n = 1; !id || taken.has(id); n++) id = `${kind.kind}-${n}`
        taken.add(id)
        const spec: WidgetSpec = { ...(entry as any), id, size }
        if (spec.city !== undefined && typeof spec.city !== "string") delete spec.city
        if (spec.zones !== undefined && !(Array.isArray(spec.zones) && spec.zones.every(isClockCity))) delete spec.zones
        specs.push(spec)
    }
    return specs
}

// (told of only when they change, not with every other setting)
const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)
export const widgetSpecs: Accessor<WidgetSpec[]> = createMemo(() => specsOf(conf().widgets), { equals: same })

// entries of kinds this kiwi doesn't know (a newer one's): written back as
// they were, after the rest
const unknown = () => {
    const raw = conf.peek().widgets
    return Array.isArray(raw) ? raw.filter(e => !e || typeof e !== "object" || !kindOf((e as any).kind)) : []
}

const save = (specs: WidgetSpec[]) => saveSetting("widgets", [...specs, ...unknown()])

// what a widget leaves behind (a note's text) goes with it
const removedListeners: ((id: string) => void)[] = []
export const whenRemoved = (listener: (id: string) => void) => removedListeners.push(listener)

const newId = (kind: string) => `${kind}-${GLib.uuid_string_random().slice(0, 8)}`

/** A widget from the gallery, at the top. */
export function addWidget(kind: string, size: WidgetSize) {
    save([{ id: newId(kind), kind, size }, ...widgetSpecs.peek()])
}

export async function removeWidget(id: string) {
    // (what it leaves goes only once it's gone from the file too)
    if (await save(widgetSpecs.peek().filter(s => s.id !== id))) removedListeners.forEach(l => l(id))
}

export function changeWidget(id: string, change: Partial<Omit<WidgetSpec, "id" | "kind">>) {
    save(widgetSpecs.peek().map(s => {
        if (s.id !== id) return s
        const next = { ...s, ...change }
        // (undefined: back to the default, so not written)
        for (const key of Object.keys(next) as (keyof WidgetSpec)[]) if (next[key] === undefined) delete next[key]
        return next
    }))
}

/** A widget taken to another place in the list: before `before`, or last. */
export function moveWidget(id: string, before: string | null) {
    const specs = widgetSpecs.peek()
    const moving = specs.find(s => s.id === id)
    if (!moving || before === id) return
    const rest = specs.filter(s => s.id !== id)
    const at = before ? rest.findIndex(s => s.id === before) : -1
    rest.splice(at < 0 ? rest.length : at, 0, moving)
    // (dropped where it was: nothing to write)
    if (rest.every((s, i) => s === specs[i])) return
    save(rest)
}

// ─── Laid out ─────────────────────────────────────────────────────────────────

export const COLUMN_GAP = 12
export const LINE_WIDTH = 340
export const SMALL = (LINE_WIDTH - COLUMN_GAP) / 2

export function sizeOf(size: WidgetSize): [number, number] {
    return size === "small" ? [SMALL, SMALL]
        : size === "medium" ? [LINE_WIDTH, SMALL]
        : [LINE_WIDTH, LINE_WIDTH]
}

export type Line = { key: string, specs: WidgetSpec[] }

/** The widgets in lines: two small ones side by side, a bigger one alone. */
export function linesOf(specs: WidgetSpec[]): Line[] {
    const lines: Line[] = []
    for (let i = 0; i < specs.length; i++) {
        const line = [specs[i]]
        if (specs[i].size === "small" && specs[i + 1]?.size === "small") line.push(specs[++i])
        // (a weather widget's place in its key too: a new one builds it
        // again; a clock follows its cities itself, its picker open)
        lines.push({ key: `w:${line.map(s => `${s.id}/${s.size}/${s.city ?? ""}`).join("+")}`, specs: line })
    }
    return lines
}

// ─── Editing ──────────────────────────────────────────────────────────────────

const [editing, setEditing] = createState(false)
export { editing as editingWidgets, setEditing as setEditingWidgets }

// ─── Shown ────────────────────────────────────────────────────────────────────

const anyBattery = createMemo(() => batteries().length > 0)

/**
 * The widgets Notification Center shows: all but a Batteries widget with
 * nothing to show (a desktop with nothing connected), until they're edited.
 */
export const shownWidgets: Accessor<WidgetSpec[]> = createMemo(() => {
    const specs = widgetSpecs()
    if (anyBattery() || editing()) return specs
    return specs.filter(s => s.kind !== "batteries")
}, { equals: same })
