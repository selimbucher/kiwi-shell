import GLib from "gi://GLib"
import { createState } from "ags"

// Leveled, scoped logging: `HH:MM:SS.mmm LEVEL scope: message`.
// Default level is info; KIWI_LOG=<level> or `kiwictl debug` changes it.
export type LogLevel = "debug" | "info" | "warn" | "error"

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const env = GLib.getenv("KIWI_LOG") as LogLevel | null
let threshold: LogLevel = env && env in RANK ? env : "info"

// reactive debug-mode flag for UI behavior (e.g. popovers staying open
// for inspection while debugging)
const [debugMode, setDebugMode] = createState(threshold === "debug")
export { debugMode }

export function setLogLevel(level: LogLevel) {
    threshold = level
    setDebugMode(level === "debug")
}

function fmt(v: unknown): string {
    if (typeof v === "string") return v
    // GLib.Error (everything bluez/gio throws) is NOT an Error subclass, and
    // its message/domain live on the prototype — JSON.stringify used to render
    // it as a bare stack with the actual error text missing.
    if (v instanceof Error || v instanceof GLib.Error)
        return v.stack ? `${v.message}\n${v.stack}` : v.message
    try {
        return JSON.stringify(v)
    } catch {
        return String(v)
    }
}

function emit(level: LogLevel, scope: string, args: unknown[]) {
    if (RANK[level] < RANK[threshold]) return
    const now = GLib.DateTime.new_now_local()
    const ms = String(Math.floor(now.get_microsecond() / 1000)).padStart(3, "0")
    const line = `${now.format("%H:%M:%S")}.${ms} ${level.toUpperCase().padEnd(5)} ${scope}: ${args.map(fmt).join(" ")}`
    if (RANK[level] >= RANK.warn) printerr(line)
    else print(line)
}

export function logger(scope: string) {
    return {
        debug: (...args: unknown[]) => emit("debug", scope, args),
        info: (...args: unknown[]) => emit("info", scope, args),
        warn: (...args: unknown[]) => emit("warn", scope, args),
        error: (...args: unknown[]) => emit("error", scope, args),
    }
}
