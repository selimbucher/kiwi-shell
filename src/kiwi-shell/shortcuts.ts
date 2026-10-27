import { conf } from "./widgets/config"
import { rebindAll, enqueueBindJob, registerBindSetup, currentBinds, applyBinds, describeBind, type BindOp } from "./hypr"
import { notify } from "./notify"
import { logger } from "./log"
const log = logger("shortcuts")

// The shell's own shortcuts, configurable as "shortcuts": { "launcher": "Super", ... }.
// A lone modifier ("Super") is a tap; anything else is modifiers + key. A
// list ("mission_control": ["Ctrl+Up", "F3"]) gives an action several, as
// macOS's keyboard settings can't but plenty of keyboards want. The
// optional ones are unset ("") until the user sets them: the classic
// workspace switcher (held like the app switcher, through the desktops) and
// the notification center.
export type OptionalShortcutName = "workspace_switcher" | "notification_center"
export type ShortcutName =
    | "launcher" | "app_switcher" | "mission_control" | "desktop_left" | "desktop_right"
    | OptionalShortcutName

export const DEFAULT_SHORTCUTS: Record<ShortcutName, string> = {
    launcher: "Super",
    app_switcher: "Alt+Tab",
    mission_control: "Ctrl+Super+Up",
    desktop_left: "Ctrl+Super+Left",
    desktop_right: "Ctrl+Super+Right",
    workspace_switcher: "",
    notification_center: "",
}

// as the settings app names them (kiwi-settings, utils/shortcuts.py)
const TITLES: Record<ShortcutName, string> = {
    launcher: "Open Launcher",
    app_switcher: "Switch Apps",
    mission_control: "Mission Control",
    desktop_left: "Desktop on the Left",
    desktop_right: "Desktop on the Right",
    workspace_switcher: "Switch Desktops",
    notification_center: "Show Notifications",
}

const MODIFIERS: Record<string, { name: string; key: string; mask: number }> = {
    super: { name: "SUPER", key: "SUPER_L", mask: 64 },
    alt: { name: "ALT", key: "ALT_L", mask: 8 },
    ctrl: { name: "CTRL", key: "CONTROL_L", mask: 4 },
    shift: { name: "SHIFT", key: "SHIFT_L", mask: 1 },
}

export type Shortcut = {
    mods: string[]  // hyprland modifier names, e.g. ["SUPER"]
    key: string     // hyprland key name; for a tap, the modifier's own key
    modmask: number
    tap: boolean
}

export function parseShortcut(text: string): Shortcut | null {
    const parts = text.split("+").map(p => p.trim()).filter(Boolean)
    if (!parts.length) return null
    const mods: string[] = []
    let modmask = 0
    for (const part of parts.slice(0, -1)) {
        const mod = MODIFIERS[part.toLowerCase()]
        if (!mod || mods.includes(mod.name)) return null
        mods.push(mod.name)
        modmask |= mod.mask
    }
    const last = parts[parts.length - 1]
    const lastMod = MODIFIERS[last.toLowerCase()]
    if (lastMod) {
        if (mods.length) return null
        return { mods: [lastMod.name], key: lastMod.key, modmask: lastMod.mask, tap: true }
    }
    return { mods, key: last.toUpperCase(), modmask, tap: false }
}

// the combo a bind reported by `hyprctl binds` sits on
export function bindCombo(bind: { modmask: number; key: string }): string {
    const mods = Object.values(MODIFIERS).filter(m => bind.modmask & m.mask).map(m => m.name)
    return [...mods, bind.key].join(" + ")
}

const normalizeCombo = (c: string) => {
    const parts = c.split("+").map(p => p.trim().toUpperCase())
    const key = parts.pop()!
    return [...parts.sort(), key].join("+")
}

// "SUPER + TAB", as binds are spelled for applyBinds
export const combo = (s: Shortcut, ...extraMods: string[]) =>
    [...s.mods, ...extraMods, s.key].join(" + ")

// the key whose release ends a hold-to-switch shortcut
export const heldModifierKey = (s: Shortcut) =>
    MODIFIERS[s.mods[0].toLowerCase()].key

// The switchers are held: exactly one modifier, whose release confirms, and
// no Shift, which they add for going backwards. Only the launcher can be a
// tap; anything else needs a modifier, or a key of its own (F keys, XF86
// media keys).
function valid(name: ShortcutName, s: Shortcut | null): s is Shortcut {
    if (!s) return false
    if (name === "launcher") return true
    if (name === "app_switcher" || name === "workspace_switcher")
        return !s.tap && s.mods.length === 1 && s.mods[0] !== "SHIFT"
    return !s.tap && (s.mods.length > 0 || /^(F\d+|XF86)/i.test(s.key))
}

// the keys a shortcut is pressed on, which no other action may have: a
// switcher goes backwards with Shift too. Its confirm on the modifier's
// release isn't one: a tap on that modifier and any switcher held on it
// share the release (shadowing tells them apart, see Launcher.tsx).
function pressedOn(name: ShortcutName, s: Shortcut): string[] {
    if (name === "app_switcher" || name === "workspace_switcher") return [combo(s), combo(s, "SHIFT")]
    return [combo(s)]
}

// config.json's text for one action: a string, or a list of them
function configuredTexts(name: ShortcutName): string[] {
    const value: unknown = conf().shortcuts?.[name]
    const texts = Array.isArray(value) ? value : [value]
    return texts.filter((t): t is string => typeof t === "string" && t.trim() !== "")
}

// Every action's shortcuts, worked out once per change of the setting. The
// unusable are left out, with a warning; one with none left falls back to
// its default (none, for the optional ones). Keys set for two actions go to
// the one listed first in DEFAULT_SHORTCUTS: one key, one thing, as the
// Hyprland config's binds on kiwi's keys are taken off too.
let resolvedFor = ""
let resolvedShortcuts = {} as Record<ShortcutName, Shortcut[]>

function allShortcuts(): Record<ShortcutName, Shortcut[]> {
    const key = JSON.stringify(conf().shortcuts ?? {})
    if (key === resolvedFor) return resolvedShortcuts
    resolvedFor = key

    const claimed = new Map<string, ShortcutName>()
    const result = {} as Record<ShortcutName, Shortcut[]>
    for (const name of Object.keys(DEFAULT_SHORTCUTS) as ShortcutName[]) {
        const configured = configuredTexts(name)
        let list = configured.flatMap(text => {
            const parsed = parseShortcut(text)
            if (valid(name, parsed)) return [parsed]
            log.warn(`ignoring shortcuts.${name} "${text}"`)
            return []
        })
        if (!list.length) {
            if (configured.length) log.warn(`no usable shortcuts.${name}, using ${DEFAULT_SHORTCUTS[name] || "none"}`)
            const fallback = parseShortcut(DEFAULT_SHORTCUTS[name])
            list = fallback ? [fallback] : []
        }
        result[name] = []
        for (const s of list) {
            const keys = pressedOn(name, s).map(normalizeCombo)
            const owner = keys.map(k => claimed.get(k)).find(Boolean)
            if (owner === name) continue // the same keys twice
            if (owner) {
                log.warn(`shortcuts.${name} ${combo(s)} is ${owner}'s already, leaving it out`)
                continue
            }
            for (const k of keys) claimed.set(k, name)
            result[name].push(s)
        }
    }
    resolvedShortcuts = result
    return result
}

/** The shortcuts of an action that always has one, as set or by default. */
export function shortcuts(name: Exclude<ShortcutName, OptionalShortcutName>): Shortcut[] {
    return allShortcuts()[name]
}

/** An optional action's shortcuts, none when it isn't set. */
export function optionalShortcuts(name: OptionalShortcutName): Shortcut[] {
    return allShortcuts()[name]
}

// the modifiers a held switcher's shortcuts hold, each once: its confirm
// and its escape are the modifier's, however many keys go with it
export const heldModifiers = (list: Shortcut[]): Shortcut[] =>
    list.filter((s, i) => list.findIndex(o => o.mods[0] === s.mods[0]) === i)

// ─── binds left by a kiwi that ran with other shortcuts ──────────────────────
// Only possible when the config changed while kiwi wasn't running (a reload
// wipes all dynamic binds). Leftovers can't be removed selectively: an unbind
// takes every bind on the combo, and combos are shared (a launcher tap and a
// switcher confirm). So when there are any, all of kiwi's shortcut binds are
// cleared before the setups run; they add everything back. This runs before
// the setups: shortcuts.ts is imported ahead of the modules registering them.

const DESCRIPTIONS: Record<ShortcutName, string[]> = {
    launcher: ["kiwi: launcher"],
    app_switcher: ["kiwi: apps open", "kiwi: apps open backwards", "kiwi: apps submap enter", "kiwi: apps confirm", "kiwi: apps submap reset"],
    mission_control: ["kiwi: mission control"],
    desktop_left: ["kiwi: desktop left"],
    desktop_right: ["kiwi: desktop right"],
    workspace_switcher: ["kiwi: workspaces next", "kiwi: workspaces prev", "kiwi: workspaces switch", "kiwi: workspaces close"],
    notification_center: ["kiwi: notification center"],
}

// binds an older kiwi left, from before the global shortcuts (they ran
// kiwictl). The setups keep a bind with the current description in place,
// so these would otherwise stay until the next config reload.
const RETIRED = ["kiwi: launcher toggle", "kiwi: workspaces confirm", "kiwi: workspaces escape"]

// every combo kiwi binds in the root submap for the shortcuts
function wantedCombos(name: ShortcutName): string[] {
    return allShortcuts()[name].flatMap(s => {
        if (name === "workspace_switcher")
            return [combo(s), combo(s, "SHIFT"), `${s.mods[0]} + ${heldModifierKey(s)}`, `${s.mods[0]} + escape`]
        if (name === "app_switcher") return [combo(s), combo(s, "SHIFT"), `${s.mods[0]} + ${heldModifierKey(s)}`]
        return [combo(s)]
    })
}

enqueueBindJob("leftover shortcut binds", async () => {
    const binds = await currentBinds()
    const names = Object.keys(DESCRIPTIONS) as ShortcutName[]
    const ours = (b: any) => RETIRED.includes(b.description) ||
        names.some(n => DESCRIPTIONS[n].includes(b.description))
    const leftover = binds.some((b: any) => b.submap === "" && (RETIRED.includes(b.description) ||
        names.some(n => DESCRIPTIONS[n].includes(b.description) &&
            !wantedCombos(n).map(normalizeCombo).includes(normalizeCombo(bindCombo(b))))))
    if (!leftover) return

    log.info("found binds from other shortcuts or an older kiwi, clearing kiwi's shortcut binds")
    const root = new Set(binds.filter((b: any) => b.submap === "" && ours(b)).map(bindCombo))
    const switcher = new Set(binds.filter((b: any) => b.submap === "app_switcher" && isKiwi(b)).map(bindCombo))
    const ops: BindOp[] = [...root].map(c => ({ unbind: c }))
    if (switcher.size) ops.push({ submap: "app_switcher", ops: [...switcher].map(c => ({ unbind: c })) })
    await applyBinds(ops, "leftover shortcut binds")
})

const isKiwi = (b: any) => (b.description ?? "").startsWith("kiwi:")

// ─── binds of the Hyprland config on kiwi's shortcuts ────────────────────────
// kiwi's shortcuts are set in kiwi (its settings app, or the home-manager
// module's services.kiwi-shell.settings.shortcuts). A bind of the Hyprland
// config on the same keys would fire as well, two things on one key, so while
// kiwi runs its shortcuts take their keys: the config's bind is taken off
// them, and the user is told once which one it was. An unbind takes every
// bind on the keys, kiwi's too, so this runs ahead of every setup, which put
// kiwi's back — at startup, after a reload, after a shortcut changes.

const toldAbout = new Set<string>()

registerBindSetup("shortcut keys", async () => {
    const binds = await currentBinds()
    const names = Object.keys(DEFAULT_SHORTCUTS) as ShortcutName[]
    const owner = new Map<string, ShortcutName>()
    for (const name of names) for (const c of wantedCombos(name)) owner.set(normalizeCombo(c), name)
    const foreign = binds.filter((b: any) =>
        b.submap === "" && !isKiwi(b) && owner.has(normalizeCombo(bindCombo(b))))
    if (!foreign.length) return

    const combos = [...new Set(foreign.map(bindCombo))]
    if (!await applyBinds(combos.map(c => ({ unbind: c })), "shortcut keys")) return
    for (const b of foreign) {
        const name = owner.get(normalizeCombo(bindCombo(b)))!
        log.warn(`took ${bindCombo(b)} from the Hyprland config for ${name}:`, describeBind(b))
        if (toldAbout.has(bindCombo(b))) continue
        toldAbout.add(bindCombo(b))
        notify("Shortcut taken over",
            `${spoken(bindCombo(b))} is Kiwi Shell's ${TITLES[name]}, so your Hyprland config's bind on it is off.`)
    }
})

// "CTRL + Left" as the settings write it, "Ctrl+Left"; a modifier's own key
// ("SUPER + SUPER_L") is its tap, "Super"
function spoken(keys: string): string {
    const parts = keys.split(" + ")
    const key = parts.pop()!
    const word = (w: string) => w.charAt(0) + w.slice(1).toLowerCase()
    const mods = parts.map(m => m === "CTRL" ? "Ctrl" : word(m))
    if (Object.values(MODIFIERS).some(m => m.key === key)) return mods.join("+")
    return [...mods, key.length > 1 && key === key.toUpperCase() ? word(key) : key].join("+")
}

const resolved = () =>
    JSON.stringify(allShortcuts())

let current = resolved()
conf.subscribe(() => {
    const next = resolved()
    if (next === current) return
    current = next
    log.info("shortcuts changed, re-registering binds")
    rebindAll()
})
