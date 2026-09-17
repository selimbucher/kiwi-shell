import { Accessor, createComputed, createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"

import { conf } from "../config"
import { dialect, enqueueBindJob, evalLua, keyword } from "../../hypr"
import { logger } from "../../log"

const log = logger("theme")
const hyprland = Hyprland.get_default()

// The shell's look is two settings: a style (theme) and an appearance.
//   granite  solid, black or white
//   acrylic  dense glass, the pane colour dominates
//   tinted   smoky or frosted glass
//   clear    barely tinted glass, the same in light and dark
// appearance: light, dark, or system (the color-scheme apps follow). Every
// themed window carries theme-<style> appearance-<light|dark>; the colours
// are tokens in style/_theme.scss.

export type ThemeStyle = "granite" | "acrylic" | "tinted" | "clear"
export type Appearance = "light" | "dark" | "system"

export const THEME_STYLES: ThemeStyle[] = ["granite", "acrylic", "tinted", "clear"]

// the one style that looks the same in light and dark
export const ignoresAppearance = (style: ThemeStyle) => style === "clear"

// The compositor blurs a whole layer surface at once, so a window's namespace
// is really a statement about what is drawn inside it.
//
//   panel   panes with nothing but a hairline around them
//   dock    the dock, which casts a drop shadow — and is the one surface
//           Granite blurs (style/_theme.scss)
//   cards   notification cards, which cast one too
//   scrim   the launcher's full-screen backdrop
//   plain   never blurred: the desktop, whose icons would otherwise blur the
//           wallpaper behind their own shadows, and the invisible surfaces
//           that exist only to catch clicks
export const LAYER = {
    panel: "kiwi",
    dock: "kiwi-dock",
    cards: "kiwi-cards",
    scrim: "kiwi-scrim",
    plain: "kiwi-plain",
} as const


const [colorScheme, setColorScheme] = createState("default")

const interfaceSettings = (() => {
    try {
        const source = Gio.SettingsSchemaSource.get_default()
        return source?.lookup("org.gnome.desktop.interface", true)
            ? new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
            : null
    } catch {
        return null
    }
})()
if (interfaceSettings) {
    setColorScheme(interfaceSettings.get_string("color-scheme"))
    interfaceSettings.connect("changed::color-scheme", () =>
        setColorScheme(interfaceSettings.get_string("color-scheme")))
}

export const themeStyle: Accessor<ThemeStyle> = conf(c =>
    THEME_STYLES.includes(c.theme) ? c.theme : "acrylic")

// light or dark, after the setting (and the system for "system")
export const resolvedAppearance: Accessor<"light" | "dark"> = createComputed(get => {
    const style = get(themeStyle)
    if (ignoresAppearance(style)) return "dark"
    const appearance = get(conf).appearance
    if (appearance === "light" || appearance === "dark") return appearance
    // "default" is no preference, which apps show as light
    return get(colorScheme) === "prefer-dark" ? "dark" : "light"
})

export const themeClasses: Accessor<string> = createComputed(get =>
    `theme-${get(themeStyle)} appearance-${get(resolvedAppearance)}`)

// ─── Compositor layer rules ───────────────────────────────────────────────────
// Glass needs the compositor to blur behind the shell's panels. The shell adds
// that for its own namespaces, so nobody has to write a layer rule by hand,
// and it never turns on blur for anything else.
//
// ignore_alpha is the whole game here. A drop shadow lives in the same surface
// as the panel it belongs to, so with a threshold below the shadow's alpha the
// compositor blurs the wallpaper under the shadow as well and the panel ends
// up wearing a blurred halo. The shadowed namespaces therefore sit just above
// --k-shadow's alpha (0.10) and just below the thinnest pane we have, Clear
// Glass at 0.12. Everything else can use a low threshold, which is what lets
// Clear Glass's barely-there tint blur at all.

const PANEL_ALPHA = 0.05
const SHADOW_ALPHA = 0.11

type Rule = { name: string, namespace: string, ignoreAlpha: number }

const RULES: Rule[] = [
    { name: "kiwi-panels", namespace: LAYER.panel, ignoreAlpha: PANEL_ALPHA },
    { name: "kiwi-dock", namespace: LAYER.dock, ignoreAlpha: SHADOW_ALPHA },
    { name: "kiwi-cards", namespace: LAYER.cards, ignoreAlpha: SHADOW_ALPHA },
    { name: "kiwi-scrim", namespace: LAYER.scrim, ignoreAlpha: SHADOW_ALPHA },
]

// Granite is solid and blurring it would only cost frames — except for the
// dock, which borrows Acrylic's pane so it doesn't read as a hole in the
// screen, and needs the blur that goes with it.
function rulesFor(style: ThemeStyle): Set<string> {
    if (style !== "granite") return new Set(RULES.map(r => r.namespace))
    return new Set([LAYER.dock])
}

// ─── Blur the shell even when the compositor's blur is off ───────────────────
// Layer surfaces stop blurring together with decoration:blur:enabled — there
// is no layers-only switch. The glass styles are not themselves without it, so
// the shell turns the pass back on and hands every window a no_blur rule,
// which leaves the blur running for its own surfaces and nothing else. Granite
// is exempt: it has nothing to blur but the dock, and that is not worth
// overriding somebody's setting for.

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

async function windowBlurRule(enabled: boolean) {
    if (await dialect() === "lua") {
        await evalLua(
            `hl.window_rule({ name = "${NO_WINDOW_BLUR}", enabled = ${enabled}, `
            + `match = { class = ".*" }, no_blur = true })`,
            "no window blur")
    } else {
        await keyword(`windowrule match:class .*, no_blur ${enabled ? "on" : "off"}`,
            "no window blur")
    }
}

async function setEnabled(on: boolean) {
    if (await dialect() === "lua") {
        await evalLua(`hl.config({ decoration = { blur = { enabled = ${on} } } })`, "blur enabled")
    } else {
        await keyword(`decoration:blur:enabled ${on ? "true" : "false"}`, "blur enabled")
    }
}

async function syncForcedBlur(style: ThemeStyle) {
    const wanted = style !== "granite"
    if (wanted && !forcedBlur && !await blurEnabled()) {
        await windowBlurRule(true)
        await setEnabled(true)
        forcedBlur = true
        log.info("compositor blur was off — on for the shell's layers only")
    } else if (!wanted && forcedBlur) {
        await setEnabled(false)
        await windowBlurRule(false)
        forcedBlur = false
        log.info("compositor blur handed back to its own setting")
    }
}

function ruleLua(rule: Rule, enabled: boolean): string {
    return `hl.layer_rule({ name = "${rule.name}", enabled = ${enabled}, `
        + `match = { namespace = "^(${rule.namespace})$" }, blur = ${enabled}, `
        + `blur_popups = ${enabled}, ignore_alpha = ${rule.ignoreAlpha} })`
}

function ruleHyprlang(rule: Rule, enabled: boolean): string {
    const on = enabled ? "on" : "off"
    return `layerrule match:namespace ^(${rule.namespace})$, `
        + `blur ${on}, blur_popups ${on}, ignore_alpha ${rule.ignoreAlpha}`
}

async function applyLayerRules() {
    const style = themeStyle()
    await syncForcedBlur(style)
    const wanted = rulesFor(style)
    const lua = await dialect() === "lua"
    for (const rule of RULES) {
        const enabled = wanted.has(rule.namespace)
        // a named rule is redefined rather than stacked, so this is safe to
        // run again on every style change and every config reload
        if (lua) await evalLua(ruleLua(rule, enabled), `layer rule ${rule.name}`)
        else await keyword(ruleHyprlang(rule, enabled), `layer rule ${rule.name}`)
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
