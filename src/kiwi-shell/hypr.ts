// Hyprland ≥0.56 lua-config IPC: dispatch payloads are lua expressions and
// `keyword` is gone (rejected with exit 0!), so every request checks the
// reply text — the only failure signal there is.
import Hyprland from "gi://AstalHyprland"
import { logger } from "./log"

const log = logger("hypr")
const hyprland = Hyprland.get_default()

// a lua double-quoted string literal
export function luaStr(s: string): string {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'
}

// Astal strips the leading 0x from client addresses; the address: selector
// needs it back
export const clientSelector = (client: Hyprland.Client) => `address:0x${client.address}`

// resolves true on "ok"; failures are logged, never thrown
function send(request: string, label: string): Promise<boolean> {
    return new Promise(resolve => {
        hyprland.message_async(request, (_src: any, res: any) => {
            try {
                const reply = hyprland.message_finish(res)
                if (reply.trim() === "ok") {
                    log.debug(`ok: ${label}`)
                    resolve(true)
                } else {
                    log.error(`${label}: ${reply}`)
                    resolve(false)
                }
            } catch (e) {
                log.error(`${label}:`, e as Error)
                resolve(false)
            }
        })
    })
}

// run a lua chunk in the compositor — atomic and ordered, the --batch of
// the lua world. Binds made here are wiped on config reload.
export function evalLua(code: string, label?: string): Promise<boolean> {
    return send(`eval ${code}`, label ?? code.slice(0, 60))
}

// execute a single dispatcher, e.g. dispatchLua('hl.dsp.window.close()')
export function dispatchLua(dispatcher: string): Promise<boolean> {
    return send(`dispatch ${dispatcher}`, dispatcher.slice(0, 60))
}

// ─── dispatch helpers ─────────────────────────────────────────────────────────

export const focusWindow = (selector: string) =>
    dispatchLua(`hl.dsp.focus({ window = ${luaStr(selector)} })`)

export const focusWorkspace = (ws: string | number) =>
    dispatchLua(`hl.dsp.focus({ workspace = ${luaStr(String(ws))} })`)

export const moveWindowToWorkspace = (
    ws: string | number,
    selector: string,
    opts: { follow?: boolean } = {},
) =>
    dispatchLua(
        `hl.dsp.window.move({ workspace = ${luaStr(String(ws))}, window = ${luaStr(selector)}` +
        (opts.follow === false ? `, follow = false` : ``) + ` })`,
    )

// Client.kill() in AstalHyprland still speaks the pre-0.56 dialect
// ("dispatch killwindow address:..."), which the lua IPC rejects — every
// close must go through here instead.
export const closeWindow = (selector: string) =>
    dispatchLua(`hl.dsp.window.close({ window = ${luaStr(selector)} })`)

export const raiseWindow = (selector: string) =>
    dispatchLua(`hl.dsp.window.alter_zorder({ mode = "top", window = ${luaStr(selector)} })`)

export const toggleSpecialWorkspace = (name: string) =>
    dispatchLua(`hl.dsp.workspace.toggle_special(${luaStr(name)})`)

// ─── bind registration ────────────────────────────────────────────────────────
// Every kiwi bind carries a "kiwi: ..." description — with all dispatchers
// reported as "__lua", descriptions are the only identity introspection has.

export type BindFlags = {
    repeating?: boolean
    release?: boolean
    transparent?: boolean
    locked?: boolean
}

// lua source for one hl.bind() call; `action` is a lua dispatcher expression
export function luaBind(keys: string, action: string, description: string, flags: BindFlags = {}): string {
    const opts = [`description = ${luaStr(description)}`]
    for (const [k, v] of Object.entries(flags)) if (v) opts.push(`${k} = true`)
    return `hl.bind(${luaStr(keys)}, ${action}, { ${opts.join(", ")} })`
}

// clears every bind on a key combo, tolerates absence
export const luaUnbind = (keys: string) => `hl.unbind(${luaStr(keys)})`

export const isKiwiBind = (b: any) => (b.description ?? "").startsWith("kiwi:")

// bind identity for log lines (dispatcher/arg are an opaque __lua/index)
export function describeBind(b: any): string {
    const desc = b.description ? ` "${b.description}"` : ""
    return `mod=${b.modmask} key=${b.key}${desc} (${b.dispatcher} ${b.arg})`
}
