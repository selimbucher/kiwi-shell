import { logger } from "../../log"
const log = logger("dock")
import { conf } from "../config"
import GLib from "gi://GLib"

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

export function emptyTrash() {
    try {
        GLib.spawn_command_line_async("gio trash --empty")
    } catch (error) {
        log.error("Failed to empty trash:", error)
    }
}
