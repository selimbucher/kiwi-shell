import { Accessor } from "ags"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"

import { conf } from "../config"
import { dialect, enqueueBindJob, evalLua, keyword } from "../../hypr"
import { logger } from "../../log"

const log = logger("theme")
const hyprland = Hyprland.get_default()

// The shell's look is one setting, a style (theme), and it is always dark —
// apps can be light, the shell is not:
//   granite  solid black
//   acrylic  dense glass, the pane colour dominates
//   tinted   smoky glass
//   clear    barely tinted glass
// Every themed window carries theme-<style>; the colours are tokens in
// style/_theme.scss.

export type ThemeStyle = "granite" | "acrylic" | "tinted" | "clear"

export const THEME_STYLES: ThemeStyle[] = ["granite", "acrylic", "tinted", "clear"]

// The compositor blurs a whole layer surface at once, so a window's namespace
// is really a statement about what is drawn inside it.
//
//   panel   panes with nothing but a hairline around them
//   dock    the dock, which Granite blurs as well
//   cards   notification cards, which Granite does not
//   switcher  the app and workspace switchers: panes like panel, which appear
//           and go without the compositor's fade — they are on screen for
//           as long as a modifier is held, and a fade only delays them
//   scrim   the launcher's full-screen window, Spotlight's panel in it —
//           blurred in Granite too
//   plain   never blurred: the desktop, whose icons would otherwise blur the
//           wallpaper behind their own shadows, and the invisible surfaces
//           that exist only to catch clicks
export const LAYER = {
    panel: "kiwi",
    dock: "kiwi-dock",
    cards: "kiwi-cards",
    switcher: "kiwi-switcher",
    scrim: "kiwi-scrim",
    plain: "kiwi-plain",
} as const

export const themeStyle: Accessor<ThemeStyle> = conf(c =>
    THEME_STYLES.includes(c.theme) ? c.theme : "acrylic")

export const themeClasses: Accessor<string> = themeStyle(style => `theme-${style}`)

// ─── Compositor layer rules ───────────────────────────────────────────────────
// Glass needs the compositor to blur behind the shell's panels. The shell adds
// that for its own namespaces, so nobody has to write a layer rule by hand,
// and it never turns on blur for anything else.
//
// ignore_alpha is the whole game here. A layer surface is not blurred by its
// shape but through a mask: every pixel whose alpha clears the threshold gets
// blurred wallpaper behind it, every other pixel gets none, with nothing in
// between. So the mask should be the pane and only the pane:
//
//   - A drop shadow in the same surface either falls inside the mask, and the
//     panel wears a blurred halo, or forces a threshold above the shadow's
//     alpha. That threshold then cuts across the anti-aliased ring of a
//     rounded corner and leaves a stepped edge around it, and while a card
//     fades in, its text clears the threshold frames before its pane does and
//     glyph-shaped patches of blur flash through the card. So a blurred
//     surface casts no shadow (--k-shadow in style/_theme.scss).
//   - With no shadow, a low threshold puts the mask's edge on the outermost
//     ring of the pane's own anti-aliasing, and it still lets Clear Glass's
//     barely-there tint (0.12) blur at all.

const IGNORE_ALPHA = 0.05

type Rule = { name: string, namespace: string, noAnim?: boolean }

const RULES: Rule[] = [
    { name: "kiwi-panels", namespace: LAYER.panel },
    { name: "kiwi-switchers", namespace: LAYER.switcher, noAnim: true },
    { name: "kiwi-dock", namespace: LAYER.dock },
    { name: "kiwi-cards", namespace: LAYER.cards },
    { name: "kiwi-scrim", namespace: LAYER.scrim },
]

// Granite is solid and blurring it would only cost frames — except for
// Spotlight and the dock, which are never more solid than Tinted Glass
// (style/_theme.scss) and need the blur that goes with it.
function rulesFor(style: ThemeStyle): Set<string> {
    if (style !== "granite") return new Set(RULES.map(r => r.namespace))
    return new Set([LAYER.dock, LAYER.scrim])
}

// ─── Blur the shell even when the compositor's blur is off ───────────────────
// Layer surfaces stop blurring together with decoration:blur:enabled — there
// is no layers-only switch. Glass is not itself without it, and every style
// has some (Granite's Spotlight and dock), so the shell turns the pass back
// on and hands every window a no_blur rule, which leaves the blur running for
// its own surfaces and nothing else.

const NO_WINDOW_BLUR = "kiwi-no-window-blur"
let forcedBlur = false

function blurEnabled(): Promise<boolean> {
    return new Promise(resolve => {
        hyprland.message_async("j/getoption decoration:blur:enabled", (_src: any, res: any) => {
            try {
                const reply = JSON.parse(hyprland.message_finish(res))
                resolve(Boolean(reply.int ?? reply.bool ?? 1))
            } catch {
                resolve(true)
            }
        })
    })
}

async function forceBlur() {
    if (forcedBlur || await blurEnabled()) return
    if (await dialect() === "lua") {
        await evalLua(
            `hl.window_rule({ name = "${NO_WINDOW_BLUR}", enabled = true, `
            + `match = { class = ".*" }, no_blur = true })`,
            "no window blur")
        await evalLua("hl.config({ decoration = { blur = { enabled = true } } })", "blur enabled")
    } else {
        await keyword("windowrule match:class .*, no_blur on", "no window blur")
        await keyword("decoration:blur:enabled true", "blur enabled")
    }
    forcedBlur = true
    log.info("compositor blur was off — on for the shell's layers only")
}

// ─── The blur itself ──────────────────────────────────────────────────────────
// The glass styles are mixed for one blur: how far it reaches (size, each pass
// doubling it), how much colour it keeps (vibrancy, contrast) and its grain
// (noise). Size 3 with 2 passes was imperceptible behind the panes; at size 10
// it smears in colour from well outside a panel. Hyprland has a single blur
// for windows and layers alike, so the shell sets it rather than leaving its
// panels to whatever the compositor's config says. kiwi_blur: false keeps the
// compositor's own.
//
// xray: windows blur the wallpaper, which Hyprland blurs once and reuses,
// rather than re-blurring whatever is behind them on every frame something
// moves. On an Iris Xe at 2880x1800 that halved the GPU's work while a window
// moved or anything animated. Layers ignore it, so the shell's own glass still
// shows the windows beneath it.
const BLUR = {
    size: 6,
    passes: 4,
    vibrancy: 0.1696,
    contrast: 1.4,
    noise: 0.01,
    new_optimizations: true,
    xray: true,
}

async function applyBlur() {
    if (!conf().kiwi_blur) return
    if (await dialect() === "lua") {
        const fields = Object.entries(BLUR).map(([key, value]) => `${key} = ${value}`).join(", ")
        await evalLua(`hl.config({ decoration = { blur = { ${fields} } } })`, "blur")
    } else {
        for (const [key, value] of Object.entries(BLUR))
            await keyword(`decoration:blur:${key} ${value}`, `blur ${key}`)
    }
}

function ruleLua(rule: Rule, blur: boolean): string {
    const noAnim = rule.noAnim ? ", no_anim = true" : ""
    return `hl.layer_rule({ name = "${rule.name}", enabled = ${blur || !!rule.noAnim}, `
        + `match = { namespace = "^(${rule.namespace})$" }, blur = ${blur}, `
        + `blur_popups = ${blur}, ignore_alpha = ${IGNORE_ALPHA}${noAnim} })`
}

function ruleHyprlang(rule: Rule, blur: boolean): string {
    const on = blur ? "on" : "off"
    const noAnim = rule.noAnim ? ", no_anim on" : ""
    return `layerrule match:namespace ^(${rule.namespace})$, `
        + `blur ${on}, blur_popups ${on}, ignore_alpha ${IGNORE_ALPHA}${noAnim}`
}

async function applyLayerRules() {
    await forceBlur()
    await applyBlur()
    const wanted = rulesFor(themeStyle())
    const lua = await dialect() === "lua"
    for (const rule of RULES) {
        const blur = wanted.has(rule.namespace)
        // a named rule is redefined rather than stacked, so this is safe to
        // run again on every style change and every config reload
        if (lua) await evalLua(ruleLua(rule, blur), `layer rule ${rule.name}`)
        else await keyword(ruleHyprlang(rule, blur), `layer rule ${rule.name}`)
    }
    log.debug(`layer rules: ${[...wanted].join(", ") || "none"}`)
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

enqueueBindJob("layer rules", async () => {
    await applyLayerRules()
})

// Granite blurs almost nothing, the glass styles blur nearly everything, so
// the rules follow the style
let styleSource = 0
themeStyle.subscribe(() => {
    if (styleSource) GLib.source_remove(styleSource)
    styleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
        styleSource = 0
        enqueueBindJob("layer rules", applyLayerRules)
        return GLib.SOURCE_REMOVE
    })
})

// kiwi_blur switched on: the shell's blur now; switched off: the compositor's
// own values are only in its config, so it reads that again
let kiwiBlur = conf().kiwi_blur
conf.subscribe(() => {
    if (conf().kiwi_blur === kiwiBlur) return
    kiwiBlur = conf().kiwi_blur
    if (kiwiBlur) enqueueBindJob("layer rules", applyLayerRules)
    else hyprland.message_async("reload", (_src: any, res: any) => {
        try {
            hyprland.message_finish(res)
        } catch (e) {
            log.error("reload for the compositor's own blur:", e as Error)
        }
    })
})

// runtime rules are gone after a config reload; add them again
let reloadSource = 0
hyprland.connect("config-reloaded", () => {
    if (reloadSource) GLib.source_remove(reloadSource)
    reloadSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        reloadSource = 0
        enqueueBindJob("layer rules", async () => {
            forcedBlur = false
            await applyLayerRules()
        })
        return GLib.SOURCE_REMOVE
    })
})
