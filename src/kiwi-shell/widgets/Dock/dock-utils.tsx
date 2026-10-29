import { logger } from "../../log"
const log = logger("dock")
import { conf } from "../config"
import { notify } from "../../notify"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import { Gtk, Gdk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"

/**
 * Opens the app (on `files`). One that won't start says why, rather than
 * nothing happening; false then.
 */
export function launchApp(app: Gio.AppInfo, files: Gio.File[] = []): boolean {
    try {
        return app.launch(files, null)
    } catch (e) {
        log.error(`couldn't open ${app.get_id() ?? app.get_name()}:`, e as Error)
        notify(`“${app.get_display_name()}” couldn't be opened`, (e as Error).message ?? "",
            { icon: "dialog-error-symbolic" })
        return false
    }
}

/**
 * Whether the pointer is over `widget`, one of the dock's (a bottom-anchored
 * layer as wide as its display), as Hyprland has it: GTK can't tell once a
 * menu hanging off the widget has had the pointer.
 */
export function pointerOverDock(widget: Gtk.Widget): boolean {
    const root = widget.get_root() as Gtk.Widget & { gdkmonitor?: Gdk.Monitor } | null
    const monitor = root?.gdkmonitor
    if (!root || !monitor) return false
    let reply: string
    try {
        reply = Hyprland.get_default().message("cursorpos")
    } catch {
        return false
    }
    const at = reply.match(/(-?\d+),\s*(-?\d+)/)
    const [ok, bounds] = widget.compute_bounds(root)
    if (!at || !ok) return false
    const geo = monitor.get_geometry()
    const x = Number(at[1]) - geo.x
    const y = Number(at[2]) - (geo.y + geo.height - root.get_height())
    return x >= bounds.get_x() && x <= bounds.get_x() + bounds.get_width()
        && y >= bounds.get_y() && y <= bounds.get_y() + bounds.get_height()
}

/**
 * A menu hanging off a dock button takes the pointer while it's open, and GTK
 * never sees the pointer leave the button: an item chosen or a click
 * elsewhere left it lifted as if pointed at. Closed, it lets go, unless the
 * pointer is on the button.
 */
export function letGoOnClose(menu: Gtk.Popover, button: Gtk.Widget) {
    menu.connect("closed", () => {
        if (!pointerOverDock(button)) button.unset_state_flags(Gtk.StateFlags.PRELIGHT)
    })
}

const FILE_MANAGERS = [
    { bin: "nautilus", flag: "" },
    { bin: "dolphin",  flag: "" },
    { bin: "nemo",     flag: "" },
    { bin: "thunar",   flag: "" },
    { bin: "pcmanfm",  flag: "" },
]

export function resolveFileManager(): { bin: string; flag: string } {
    const configured: string = conf().file_manager
    if (configured && configured !== "auto") {
        const flag = FILE_MANAGERS.find(f => f.bin === configured)?.flag ?? ""
        return { bin: configured, flag }
    }
    return FILE_MANAGERS.find(fm => !!GLib.find_program_in_path(fm.bin))
        ?? { bin: "xdg-open", flag: "" }
}

// No two terminals spell "start in this directory" the same way, and a
// terminal handed a bare path treats it as the command to run — so the flag
// travels with the binary, same as the file managers above.
const TERMINALS = [
    { bin: "kitty",          flag: "--directory" },
    { bin: "ghostty",        flag: "--working-directory" },
    { bin: "alacritty",      flag: "--working-directory" },
    { bin: "foot",           flag: "--working-directory" },
    { bin: "wezterm",        flag: "start --cwd" },
    { bin: "gnome-terminal", flag: "--working-directory" },
    { bin: "konsole",        flag: "--workdir" },
    { bin: "xfce4-terminal", flag: "--working-directory" },
]

export function resolveTerminal(): { bin: string; flag: string } {
    const configured: string = conf().terminal
    if (configured && configured !== "auto") {
        const flag = TERMINALS.find(t => t.bin === configured)?.flag ?? ""
        return { bin: configured, flag }
    }
    return TERMINALS.find(t => !!GLib.find_program_in_path(t.bin))
        ?? { bin: "xterm", flag: "" }
}

export function openTerminal(path: string) {
    const { bin, flag } = resolveTerminal()
    // an unknown terminal opens on its own default directory rather than
    // being handed a path it would try to execute
    GLib.spawn_command_line_async(flag
        ? `${bin} ${flag} ${GLib.shell_quote(path)}`
        : bin)
}

export function openUri(uri: string) {
    const { bin, flag } = resolveFileManager()
    // shell-quote: paths/uris may contain spaces
    GLib.spawn_command_line_async(
        [bin, flag, GLib.shell_quote(uri)].filter(Boolean).join(" "))
}

export function openPath(path: string) {
    const { bin, flag } = resolveFileManager()
    GLib.spawn_command_line_async(
        [bin, flag, GLib.shell_quote(path)].filter(Boolean).join(" "))
}

// gio empties every trash, a removable drive's too, where gvfs is installed;
// without it (minimal setups) the home trash is emptied here
export function emptyTrash() {
    const trash = `${GLib.get_user_data_dir()}/Trash`
    execAsync(["gio", "trash", "--empty"])
        .catch(() => execAsync(["find", `${trash}/files`, `${trash}/info`, "-mindepth", "1", "-delete"]))
        .catch(error => log.error("Failed to empty trash:", error))
}
