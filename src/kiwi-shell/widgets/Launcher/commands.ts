import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix"
import { notify } from "../../notify"
import { logger } from "../../log"
import { resolveTerminal } from "../Dock/dock-utils"

const log = logger("launcher")

// ─── Commands ─────────────────────────────────────────────────────────────────
// Spotlight runs a command line, as Alt+F2 does, without turning into a poor
// terminal: the panel shows no output, since it can't scroll, take input or
// keep colours, and closes as the command starts. What a command says goes
// where it's useful:
//   - a line that changes something (nmcli radio wifi off, kiwictl quit,
//     systemctl --user restart wireplumber) runs in the background. Gone well
//     and quiet, nothing comes back; what it printed comes back as a
//     notification, its first lines, and so does a failure, its last ones;
//   - a program that talks to you or keeps running (ssh, sudo, htop, vim,
//     ping, a bare python) opens in a terminal, as anything does with
//     Shift+Enter. The shell stays open after it, for what comes next.

/** Programs that need a terminal: they ask, draw a screen, or never end. */
const IN_TERMINAL = new Set([
    "ssh", "mosh", "sudo", "su", "doas", "passwd", "htop", "btop", "top", "atop", "nvtop", "iotop",
    "vim", "nvim", "vi", "nano", "micro", "hx", "helix", "less", "more", "man", "ping", "watch",
    "tmux", "screen", "ranger", "nnn", "lf", "yazi", "mc", "ncdu", "bluetoothctl", "nmtui", "cmus",
    "python", "python3", "ipython", "node", "irb", "ghci", "lua", "gjs", "bash", "zsh", "fish", "sh",
    "journalctl", "dmesg", "tail", "nix-shell", "nix", "nix-build", "cargo", "make", "claude",
])
// these only with arguments; bare, they'd wait for input or print usage
const BARE_IN_TERMINAL = new Set(["python", "python3", "node", "lua", "gjs", "bash", "zsh", "fish", "sh"])

export type Command = { line: string, program: string, explicit: boolean, terminal: boolean }

/**
 * `text` as a command line: ">" before it says it is one; otherwise its first
 * word has to be a program on the PATH.
 */
export function asCommand(text: string): Command | null {
    const trimmed = text.trim()
    const explicit = trimmed.startsWith(">")
    const line = explicit ? trimmed.slice(1).trim() : trimmed
    if (!line) return null
    const program = line.split(/\s+/)[0]
    if (!explicit && (!/^[\w.+-]+$/.test(program) || !GLib.find_program_in_path(program))) return null
    const bare = !/\s/.test(line)
    const terminal = (BARE_IN_TERMINAL.has(program) ? bare : IN_TERMINAL.has(program)) || terminalApp(program)
    return { line, program, explicit, terminal }
}

// an app whose own .desktop file says it runs in a terminal (htop, ranger);
// asked once a program
const terminalApps = new Map<string, boolean>()
function terminalApp(program: string): boolean {
    let known = terminalApps.get(program)
    if (known === undefined) {
        known = Gio.AppInfo.get_all().some(info => info instanceof GioUnix.DesktopAppInfo
            && (info.get_executable() ?? "").split("/").pop() === program && info.get_boolean("Terminal"))
        terminalApps.set(program, known)
    }
    return known
}

const SHELL = GLib.getenv("SHELL") || "sh"

/** The line in the desktop's terminal, its shell staying after it. */
export function runInTerminal(line: string) {
    const { bin } = resolveTerminal()
    // the user's shell, as typed into it: its aliases and functions too
    const shell = [SHELL, "-i", "-c", `${line}; exec ${GLib.shell_quote(SHELL)}`]
    const start: Record<string, string[]> = {
        kitty: [], foot: [], alacritty: ["-e"], ghostty: ["-e"], wezterm: ["start", "--"],
        "gnome-terminal": ["--"], kgx: ["--"], konsole: ["-e"], "xfce4-terminal": ["-x"], xterm: ["-e"],
    }
    const argv = [bin, ...(start[GLib.path_get_basename(bin)] ?? ["-e"]), ...shell]
    try {
        const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE })
        launcher.set_cwd(GLib.get_home_dir())
        const process = launcher.spawnv(argv)
        process.wait_async(null, () => {})
    } catch (e) {
        log.error(`couldn't open ${bin} for "${line}":`, e as Error)
        notify("The terminal couldn't be opened", `${bin}: ${(e as Error).message}`, { icon: "dialog-error-symbolic" })
    }
}

// what's kept of what a command prints: its start, and the end of its errors
const KEPT = 16 * 1024
// past this a command is taken for one left running (a program it started):
// only a failure is told then, not what it printed
const QUICK_US = 10 * 1000 * 1000

function collect(stream: Gio.InputStream, keepEnd: boolean, done: (text: string) => void) {
    // bytes, decoded once at the end (GJS's decoder doesn't stream)
    let kept = new Uint8Array(0)
    const read = () => stream.read_bytes_async(8192, GLib.PRIORITY_LOW, null, (_s, result) => {
        let bytes: GLib.Bytes | null = null
        try {
            bytes = stream.read_bytes_finish(result)
        } catch { /* closed */ }
        const data = bytes?.toArray()
        if (!data || data.length === 0) return done(new TextDecoder().decode(kept))
        if (keepEnd || kept.length < KEPT) {
            const joined = new Uint8Array(kept.length + data.length)
            joined.set(kept)
            joined.set(data, kept.length)
            kept = keepEnd ? joined.slice(-KEPT) : joined.slice(0, KEPT)
        }
        read()
    })
    read()
}

const lines = (text: string, count: number, fromEnd: boolean) => {
    const all = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map(l => l.trimEnd()).filter(Boolean)
    const shown = fromEnd ? all.slice(-count) : all.slice(0, count)
    const more = all.length - shown.length
    return shown.join("\n") + (more > 0 ? `\n… ${more} more line${more === 1 ? "" : "s"}` : "")
}

/** The line in the background; what it says, if anything, as a notification. */
export function runInBackground(line: string) {
    const started = GLib.get_monotonic_time()
    let process: Gio.Subprocess
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        })
        launcher.set_cwd(GLib.get_home_dir())
        process = launcher.spawnv(["sh", "-c", line])
    } catch (e) {
        notify(`“${line}” couldn't run`, (e as Error).message, { icon: "dialog-error-symbolic" })
        return
    }
    let out = "", err = "", open = 2, exited = false
    const report = () => {
        if (open > 0 || !exited) return
        const quick = GLib.get_monotonic_time() - started < QUICK_US
        const ok = process.get_if_exited() && process.get_exit_status() === 0
        if (!ok) {
            const how = process.get_if_exited() ? `exit status ${process.get_exit_status()}`
                : `stopped by signal ${process.get_term_sig()}`
            notify(`“${line}” failed`, lines(err || out, 6, true) || how, { icon: "dialog-error-symbolic", app: "Spotlight" })
        } else if (quick && (out.trim() || err.trim())) {
            notify(`“${line}”`, lines(out.trim() ? out : err, 8, false), { icon: "utilities-terminal-symbolic", app: "Spotlight" })
        }
    }
    collect(process.get_stdout_pipe()!, false, text => { out = text; open--; report() })
    collect(process.get_stderr_pipe()!, true, text => { err = text; open--; report() })
    process.wait_async(null, () => { exited = true; report() })
}
