import { conf } from "./widgets/config"
import { rebindAll, enqueueBindJob, currentBinds, applyBinds, type BindOp } from "./hypr"
import { logger } from "./log"
const log = logger("shortcuts")

// The shell's own shortcuts, configurable as "shortcuts": { "launcher": "Super", ... }.
// A lone modifier ("Super") is a tap; anything else is modifiers + key.
export type ShortcutName = "launcher" | "app_switcher" | "workspace_switcher"

export const DEFAULT_SHORTCUTS: Record<ShortcutName, string> = {
    launcher: "Super",
    app_switcher: "Alt+Tab",
    workspace_switcher: "Super+Tab",
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

// Switchers are held: exactly one modifier, whose release confirms, and no
// Shift, which the workspace switcher adds for going backwards.
function valid(name: ShortcutName, s: Shortcut | null): s is Shortcut {
    if (!s) return false
    if (name === "launcher") return true
    return !s.tap && s.mods.length === 1 && s.mods[0] !== "SHIFT"
}

export function shortcut(name: ShortcutName): Shortcut {
    const configured: string | undefined = conf().shortcuts?.[name]
    if (configured) {
        const parsed = parseShortcut(configured)
        if (valid(name, parsed)) return parsed
        log.warn(`ignoring shortcuts.${name} = "${configured}", using ${DEFAULT_SHORTCUTS[name]}`)
    }
    return parseShortcut(DEFAULT_SHORTCUTS[name])!
}

// ─── binds left by a kiwi that ran with other shortcuts ──────────────────────
// Only possible when the config changed while kiwi wasn't running (a reload
// wipes all dynamic binds). Leftovers can't be removed selectively: an unbind
// takes every bind on the combo, and combos are shared (a launcher tap and a
// switcher confirm). So when there are any, all of kiwi's shortcut binds are
// cleared before the setups run; they add everything back. This runs before
// the setups: shortcuts.ts is imported ahead of the modules registering them.

const DESCRIPTIONS: Record<ShortcutName, string[]> = {
    launcher: ["kiwi: launcher toggle"],
    app_switcher: ["kiwi: apps open", "kiwi: apps submap enter", "kiwi: apps confirm", "kiwi: apps submap reset"],
    workspace_switcher: [
        "kiwi: workspaces next", "kiwi: workspaces prev", "kiwi: workspaces confirm", "kiwi: workspaces escape",
    ],
}

function wantedCombos(name: ShortcutName): string[] {
    const s = shortcut(name)
    const release = s.tap ? combo(s) : `${s.mods[0]} + ${heldModifierKey(s)}`
    if (name === "launcher") return [combo(s)]
    if (name === "app_switcher") return [combo(s), release]
    return [combo(s), combo(s, "SHIFT"), release, `${s.mods[0]} + escape`]
}

enqueueBindJob("leftover shortcut binds", async () => {
    const binds = await currentBinds()
    const names = Object.keys(DESCRIPTIONS) as ShortcutName[]
    const ours = (b: any) => names.some(n => DESCRIPTIONS[n].includes(b.description))
    const leftover = binds.some((b: any) => b.submap === "" && names.some(n =>
        DESCRIPTIONS[n].includes(b.description) &&
        !wantedCombos(n).map(normalizeCombo).includes(normalizeCombo(bindCombo(b)))))
    if (!leftover) return

    log.info("found binds from other shortcuts, clearing kiwi's shortcut binds")
    const root = new Set(binds.filter((b: any) => b.submap === "" && ours(b)).map(bindCombo))
    const switcher = new Set(binds.filter((b: any) => b.submap === "app_switcher" && isKiwi(b)).map(bindCombo))
    const ops: BindOp[] = [...root].map(c => ({ unbind: c }))
    if (switcher.size) ops.push({ submap: "app_switcher", ops: [...switcher].map(c => ({ unbind: c })) })
    await applyBinds(ops, "leftover shortcut binds")
})

const isKiwi = (b: any) => (b.description ?? "").startsWith("kiwi:")

const resolved = () =>
    JSON.stringify((Object.keys(DEFAULT_SHORTCUTS) as ShortcutName[]).map(shortcut))

let current = resolved()
conf.subscribe(() => {
    const next = resolved()
    if (next === current) return
    current = next
    log.info("shortcuts changed, re-registering binds")
    rebindAll()
})
