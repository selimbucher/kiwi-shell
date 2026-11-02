import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import { conf } from "../config"
import { logger } from "../../log"

const log = logger("font")

// ─── The shell's font ─────────────────────────────────────────────────────────
// Quicksand, unless the settings say the desktop's own font ("system") or
// another by name. The shell's stylesheet is drawn for Quicksand; another
// font is laid over it here, for every widget of the shell (`*`, after the
// stylesheet: of two rules alike the later wins).
//
// Quicksand comes with the shell (the build's QUICKSAND) but is installed
// only for the shell, and only where it isn't installed already: loaded into
// the shell's own font map, not the system's.

export const QUICKSAND_FAMILY = "Quicksand"
export const SYSTEM_FONT = "system"

function hasFamily(map: Pango.FontMap, family: string): boolean {
    const wanted = family.toLowerCase()
    return map.list_families().some(f => f.get_name().toLowerCase() === wanted)
}

function bringQuicksand() {
    const map = PangoCairo.FontMap.get_default()
    if (hasFamily(map, QUICKSAND_FAMILY)) return
    const file = typeof QUICKSAND === "string" ? QUICKSAND : ""
    if (!file || !GLib.file_test(file, GLib.FileTest.EXISTS)) {
        log.warn("Quicksand isn't installed, nor shipped with this build: the shell falls back to the desktop's sans-serif")
        return
    }
    try {
        // (Pango 1.56 and later)
        if (map.add_font_file(file)) log.info("Quicksand isn't installed: the shell's own copy is loaded for it")
    } catch (e) {
        log.warn("couldn't load the shell's Quicksand:", e as Error)
    }
}

// the desktop's interface font, by family ("Inter 11" → "Inter")
function systemFamily(): string {
    const name = Gtk.Settings.get_default()?.gtk_font_name ?? ""
    return Pango.FontDescription.from_string(name).get_family() || "sans-serif"
}

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`

// ─── Matched ahead ────────────────────────────────────────────────────────────
// Each size and weight Pango meets for the first time is a fontconfig match,
// a search through every font installed: with a big collection (all of
// Google Fonts is ~10 000 files) several ms each, and the first opening of
// Spotlight spent 70 ms on its sizes. The shell's own (style/_theme.scss,
// and the widgets' big numbers) are matched while nothing happens, one at a
// time, a moment after the start.

const SIZES = [9, 10, 11, 12, 13, 15, 17, 22, 26, 30, 40]
const WEIGHTS = [Pango.Weight.LIGHT, Pango.Weight.NORMAL, Pango.Weight.MEDIUM, Pango.Weight.SEMIBOLD, Pango.Weight.BOLD]
let matching = 0

function matchAhead(family: string) {
    if (matching) GLib.source_remove(matching)
    const queue = SIZES.flatMap(size => WEIGHTS.map(weight => {
        const desc = Pango.FontDescription.from_string(family)
        desc.set_absolute_size(size * Pango.SCALE)
        desc.set_weight(weight)
        return desc
    }))
    matching = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
        // a widget's context: the font options and resolution a label's have
        const context = new Gtk.Label().get_pango_context()
        const language = Pango.Language.get_default()
        matching = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const desc = queue.shift()
            if (desc) context.load_fontset(desc, language)
            if (queue.length) return GLib.SOURCE_CONTINUE
            matching = 0
            return GLib.SOURCE_REMOVE
        })
        return GLib.SOURCE_REMOVE
    })
}

export function useShellFont() {
    bringQuicksand()
    const display = Gdk.Display.get_default()
    if (!display) return
    const provider = new Gtk.CssProvider()
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    let applied: string | null = null
    const apply = () => {
        const chosen = String(conf.peek().font ?? "").trim()
        const family = !chosen || chosen.toLowerCase() === QUICKSAND_FAMILY.toLowerCase() ? ""
            : chosen === SYSTEM_FONT ? systemFamily()
            : chosen
        // Quicksand is the stylesheet's own: nothing laid over it
        const css = family ? `* { font-family: ${quote(family)}, sans-serif; }` : ""
        if (css === applied) return
        applied = css
        provider.load_from_string(css)
        log.info(family ? `the shell's font: ${family}` : "the shell's font: Quicksand")
        matchAhead(family || QUICKSAND_FAMILY)
    }
    apply()
    conf.subscribe(apply)
    Gtk.Settings.get_default()?.connect("notify::gtk-font-name", apply)
}
