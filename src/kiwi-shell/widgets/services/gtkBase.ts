import { Gtk, Gdk } from "ags/gtk4"
import { logger } from "../../log"

const log = logger("theme")

// ─── The shell's own base ─────────────────────────────────────────────────────
// The shell's stylesheet styles its panes, but whatever it leaves unsaid about
// a widget (a switch's size, an off switch's track, a row's padding, a label's
// weight, a popover's edge) comes from underneath, and underneath was the
// desktop's:
//   - AGS starts libadwaita where it is installed (ags/gtk4/app), whose
//     stylesheet follows the desktop's light or dark: on a light desktop the
//     shell, always dark, stood on light widgets (an off switch a white bar);
//   - ~/.config/gtk-4.0/gtk.css, which GTK loads into every app at the same
//     priority as the shell's own stylesheet, and which themes like Dracula or
//     WhiteSur's libadwaita port fill with a whole stylesheet of their own;
//   - without libadwaita, the desktop's GTK theme itself.
//
// So the shell stands on one base of its own, the same everywhere, dark: this
// process alone (apps keep the desktop's look) is held at dark, and the base
// stylesheet is laid again over the user's gtk.css. The shell's stylesheet
// goes on top of both (app.tsx).

const Adw = await import("gi://Adw?version=1").then(m => m.default).catch(() => null)

// libadwaita's own stylesheet, and GTK's built-in theme where there is none
const ADWAITA_CSS = "/org/gnome/Adwaita/styles/gtk.css"
const GTK_THEME = "Default"
const GTK_THEME_CSS = "/org/gtk/libgtk/theme/Default/Default-dark.css"

export function standOnOwnBase() {
    if (Adw) {
        Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        layOver(ADWAITA_CSS)
    } else {
        holdGtkTheme()
        layOver(GTK_THEME_CSS)
    }
}

// The base stylesheet once more, over the user's gtk.css: GTK adds that at
// startup at the priority the shell's own goes in at, and of two at one
// priority the one added later wins.
function layOver(resource: string) {
    const display = Gdk.Display.get_default()
    if (!display) return
    const base = new Gtk.CssProvider()
    // (one stylesheet with both looks, chosen by a media query)
    const dark = (Gtk as any).InterfaceColorScheme?.DARK
    if (dark !== undefined && "prefers_color_scheme" in base) (base as any).prefers_color_scheme = dark
    try {
        base.load_from_resource(resource)
    } catch (e) {
        log.warn(`the base stylesheet isn't there (${resource}); the desktop's shows through:`, e as Error)
        return
    }
    Gtk.StyleContext.add_provider_for_display(display, base, Gtk.STYLE_PROVIDER_PRIORITY_USER)
}

// Without libadwaita the theme setting itself is the desktop's: held at
// GTK's built-in theme, dark, for this process.
function holdGtkTheme() {
    const settings = Gtk.Settings.get_default()
    if (!settings) return
    const hold = () => {
        try {
            if (settings.gtk_theme_name !== GTK_THEME) settings.gtk_theme_name = GTK_THEME
            const dark = (Gtk as any).InterfaceColorScheme?.DARK
            if (dark !== undefined && "gtk_interface_color_scheme" in settings) {
                if ((settings as any).gtk_interface_color_scheme !== dark) (settings as any).gtk_interface_color_scheme = dark
            } else if (!settings.gtk_application_prefer_dark_theme) {
                settings.gtk_application_prefer_dark_theme = true
            }
        } catch (e) {
            log.warn("couldn't hold GTK's theme at its own:", e as Error)
        }
    }
    hold()
    // the desktop's settings come back with every change of them
    settings.connect("notify::gtk-theme-name", hold)
    settings.connect("notify::gtk-application-prefer-dark-theme", hold)
    if ("gtk_interface_color_scheme" in settings) settings.connect("notify::gtk-interface-color-scheme", hold)
}
