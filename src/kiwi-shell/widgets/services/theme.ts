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

// every layer surface of the shell, for the compositor's layer rules
export const LAYER_NAMESPACE = "kiwi"

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
    THEME_STYLES.includes(c.theme) ? c.theme : "granite")

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
// Glass needs the compositor to blur behind the shell's panels. The shell
// adds that for its own namespace only, so nobody has to write a layer rule,
// and it never touches the global blur settings, which transparent apps
// share. A low ignore_alpha lets even Clear Glass's light tint blur. When a
// user has turned blur off, it stays off.

const LAYER_RULE_LUA =
    `hl.layer_rule({ match = { namespace = "^(${LAYER_NAMESPACE})$" }, blur = true, blur_popups = true, ignore_alpha = 0.05 })`
const LAYER_RULE_HYPRLANG =
    `layerrule match:namespace ^(${LAYER_NAMESPACE})$, blur on, blur_popups on, ignore_alpha 0.05`

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

async function addLayerRules() {
    if (!await blurEnabled()) {
        log.debug("compositor blur is off — no layer rules")
        return
    }
    if (await dialect() === "lua") await evalLua(LAYER_RULE_LUA, "shell layer rules")
    else await keyword(LAYER_RULE_HYPRLANG, "shell layer rules")
}

// runtime rules are gone after a config reload; add them again
enqueueBindJob("layer rules", addLayerRules)
let reloadSource = 0
hyprland.connect("config-reloaded", () => {
    if (reloadSource) GLib.source_remove(reloadSource)
    reloadSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        reloadSource = 0
        enqueueBindJob("layer rules", addLayerRules)
        return GLib.SOURCE_REMOVE
    })
})
