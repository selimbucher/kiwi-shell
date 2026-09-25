// Hyprland IPC in both config dialects. Hyprland ≥0.56 runs either the lua
// config manager or the classic hyprlang one, and the socket dialect follows
// the config: `eval` and lua dispatch expressions exist only under lua ("eval
// is only supported with the lua config manager"), `keyword` and classic
// `dispatch <name> <args>` only under hyprlang ("keyword can't work with
// non-legacy parsers"), and older releases only know the classic one. Every
// request checks the reply text — the only failure signal there is.
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import { logger } from "./log"
import { notify } from "./notify"

const log = logger("hypr")
const hyprland = Hyprland.get_default()

// a lua double-quoted string literal
export function luaStr(s: string): string {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'
}

// Astal strips the leading 0x from client addresses; the address: selector
// needs it back
export const clientSelector = (client: Hyprland.Client) => `address:0x${client.address}`

function request(req: string): Promise<string> {
    return new Promise((resolve, reject) => {
        hyprland.message_async(req, (_src: any, res: any) => {
            try {
                resolve(hyprland.message_finish(res))
            } catch (e) {
                reject(e)
            }
        })
    })
}

// resolves true when every reply is "ok" (a [[BATCH]] answers once per
// command); failures are logged, never thrown
async function send(req: string, label: string, quiet = false): Promise<boolean> {
    try {
        const replies = (await request(req)).split("\n\n\n").map(r => r.trim())
        const failed = replies.filter(r => r !== "ok")
        if (failed.length === 0) {
            log.debug(`ok: ${label}`)
            return true
        }
        const msg = `${label}: ${failed.join(" | ")}`
        if (quiet) log.debug(msg)
        else log.error(msg)
    } catch (e) {
        log.error(`${label}:`, e as Error)
    }
    return false
}

// ─── dialect ──────────────────────────────────────────────────────────────────

export type Dialect = "lua" | "hyprlang"

let dialectProbe: Promise<Dialect> | null = null

// probed once: the config manager is fixed for the compositor's lifetime
export function dialect(): Promise<Dialect> {
    dialectProbe ??= request("eval return 1").then(
        reply => reply.trim() === "ok" ? "lua" : "hyprlang",
        () => "hyprlang" as Dialect,
    ).then(d => {
        log.info(`compositor config dialect: ${d}`)
        return d
    })
    return dialectProbe
}

// run a lua chunk in the compositor — atomic and ordered, the --batch of the
// lua world. Lua config only; binds made here are wiped on config reload.
export async function evalLua(code: string, label?: string): Promise<boolean> {
    if (await dialect() !== "lua") {
        log.error(`${label ?? "eval"}: needs a lua config`)
        return false
    }
    return send(`eval ${code}`, label ?? code.slice(0, 60))
}

// a hyprlang keyword (classic config only; lua configs use evalLua)
export function keyword(command: string, label?: string): Promise<boolean> {
    return send(`keyword ${command}`, label ?? command.slice(0, 60))
}

// one action, spelled for each dialect
async function dispatch(lua: string, hyprlang: string, quiet = false): Promise<boolean> {
    const cmd = await dialect() === "lua" ? lua : hyprlang
    return send(`dispatch ${cmd}`, cmd.slice(0, 60), quiet)
}

// ─── dispatch helpers ─────────────────────────────────────────────────────────

export const focusWindow = (selector: string) =>
    dispatch(`hl.dsp.focus({ window = ${luaStr(selector)} })`, `focuswindow ${selector}`)

export const focusWorkspace = (ws: string | number) =>
    dispatch(`hl.dsp.focus({ workspace = ${luaStr(String(ws))} })`, `workspace ${ws}`)

export const moveWindowToWorkspace = (
    ws: string | number,
    selector: string,
    opts: { follow?: boolean } = {},
) =>
    dispatch(
        `hl.dsp.window.move({ workspace = ${luaStr(String(ws))}, window = ${luaStr(selector)}` +
        (opts.follow === false ? `, follow = false` : ``) + ` })`,
        `${opts.follow === false ? "movetoworkspacesilent" : "movetoworkspace"} ${ws},${selector}`,
    )

// Client.kill() in AstalHyprland still speaks the pre-0.56 dialect
// ("dispatch killwindow address:..."), which the lua IPC rejects — every
// close must go through here instead.
export const closeWindow = (selector: string) =>
    dispatch(`hl.dsp.window.close({ window = ${luaStr(selector)} })`, `closewindow ${selector}`)

export const raiseWindow = (selector: string) =>
    dispatch(`hl.dsp.window.alter_zorder({ mode = "top", window = ${luaStr(selector)} })`,
        `alterzorder top,${selector}`)

export const toggleSpecialWorkspace = (name: string) =>
    dispatch(`hl.dsp.workspace.toggle_special(${luaStr(name)})`, `togglespecialworkspace ${name}`)

export const exitSession = () => dispatch(`hl.dsp.exit()`, `exit`)

// hyprexpo's overview, if the plugin is loaded; quietly nothing otherwise.
// Under lua the plugin exposes no dispatcher, only its lua API.
export async function toggleExpo(): Promise<boolean> {
    if (await dialect() === "lua")
        return evalLua(`if hl.plugin.hyprexpo then hl.plugin.hyprexpo.expo("toggle") end`, "expo toggle")
    return dispatch("", "hyprexpo:expo toggle", true)
}

// ─── bind registration ────────────────────────────────────────────────────────
// Every kiwi bind carries a "kiwi: ..." description — with dispatchers
// reported as "__lua" under lua, descriptions are the only identity
// introspection has. Binds are declared once as data and spelled for the
// compositor's dialect.

export type BindFlags = {
    repeating?: boolean
    release?: boolean
    transparent?: boolean
    locked?: boolean
}

export type BindAction = { exec: string } | { global: string } | { submap: string }

export type BindOp =
    // "MOD + MOD + KEY", as lua writes it
    | { bind: string; action: BindAction; description: string; flags?: BindFlags }
    // clears every bind on a key combo, in every submap; tolerates absence
    | { unbind: string }
    // ops that apply inside a submap
    | { submap: string; ops: BindOp[] }

function luaAction(a: BindAction): string {
    if ("exec" in a) return `hl.dsp.exec_cmd(${luaStr(a.exec)})`
    if ("global" in a) return `hl.dsp.global(${luaStr(a.global)})`
    return `hl.dsp.submap(${luaStr(a.submap)})`
}

function luaOps(ops: BindOp[]): string[] {
    return ops.flatMap(op => {
        if ("unbind" in op) return [`hl.unbind(${luaStr(op.unbind)})`]
        if ("submap" in op && "ops" in op)
            return [`hl.define_submap(${luaStr(op.submap)}, function()`, ...luaOps(op.ops), `end)`]
        const opts = [`description = ${luaStr(op.description)}`]
        for (const [k, v] of Object.entries(op.flags ?? {})) if (v) opts.push(`${k} = true`)
        return [`hl.bind(${luaStr(op.bind)}, ${luaAction(op.action)}, { ${opts.join(", ")} })`]
    })
}

// "SUPER + SHIFT + TAB" -> "SUPER SHIFT, TAB"
function hyprlangKeys(keys: string): string {
    const parts = keys.split("+").map(p => p.trim())
    const key = parts.pop()!
    return `${parts.join(" ")}, ${key}`
}

const HYPRLANG_FLAG: Record<keyof BindFlags, string> = {
    locked: "l", release: "r", repeating: "e", transparent: "t",
}

function hyprlangOps(ops: BindOp[]): string[] {
    return ops.flatMap(op => {
        if ("unbind" in op) return [`keyword unbind ${hyprlangKeys(op.unbind)}`]
        if ("submap" in op && "ops" in op)
            return [`keyword submap ${op.submap}`, ...hyprlangOps(op.ops), `keyword submap reset`]
        const flags = Object.entries(op.flags ?? {})
            .filter(([, v]) => v).map(([k]) => HYPRLANG_FLAG[k as keyof BindFlags]).join("")
        const [dispatcher, arg] =
            "exec" in op.action ? ["exec", op.action.exec] :
            "global" in op.action ? ["global", op.action.global] :
            ["submap", op.action.submap]
        return [`keyword bind${flags}d ${hyprlangKeys(op.bind)}, ${op.description}, ${dispatcher}, ${arg}`]
    })
}

// applies the ops atomically and in order: one lua chunk, or one [[BATCH]]
export async function applyBinds(ops: BindOp[], label: string): Promise<boolean> {
    if (await dialect() === "lua")
        return send(`eval ${luaOps(ops).join("\n")}`, label)
    return send(`[[BATCH]]${hyprlangOps(ops).join(";")}`, label)
}

export const isKiwiBind = (b: any) => (b.description ?? "").startsWith("kiwi:")

// bind identity for log lines (dispatcher/arg are an opaque __lua/index)
export function describeBind(b: any): string {
    const desc = b.description ? ` "${b.description}"` : ""
    return `mod=${b.modmask} key=${b.key}${desc} (${b.dispatcher} ${b.arg})`
}

export async function currentBinds(): Promise<any[]> {
    return JSON.parse(await request("j/binds"))
}

// ─── bind setup scheduling ────────────────────────────────────────────────────
// Binds made over IPC are wiped on every config reload, so every setup runs
// again after one. A single rebuild can fire several reloads within the same
// millisecond (the config file changing, a plugin being swapped, that plugin's
// own reloadConfig()). Run concurrently, each setup's "is our bind there
// yet?" check saw nothing and every run added its own copy: four launcher
// toggles open-close-open-close on one Super tap, media keys stepping five
// times. So all setups share one queue, and a burst of reloads is collapsed
// into a single pass once it has been quiet for a moment.

const RELOAD_SETTLE_MS = 250

const setups: { name: string; run: () => Promise<void>; unbind?: () => BindOp[] }[] = []
let queue: Promise<void> = Promise.resolve()
let settleTimer = 0

function enqueue(name: string, run: () => Promise<void>) {
    queue = queue.then(run).catch(e => log.error(`${name} bind setup failed:`, e as Error))
}

// a one-off job in the same queue as the setups
export function enqueueBindJob(name: string, job: () => Promise<void>) {
    enqueue(name, job)
}

// runs `run` now and again after every config reload, never overlapping
// with any other setup. `unbind` lists what `run` last bound, for rebindAll.
export function registerBindSetup(name: string, run: () => Promise<void>, unbind?: () => BindOp[]) {
    setups.push({ name, run, unbind })
    enqueue(name, run)
}

// After a shortcut changes: drop every setup's old binds, then run them all
// again. Unbinds go first and together, since setups share combos (a Super
// tap and the Super+Tab confirm are both SUPER + SUPER_L releases).
export function rebindAll() {
    enqueue("unbind", async () => {
        const ops = setups.flatMap(s => s.unbind?.() ?? [])
        if (ops.length) await applyBinds(ops, "old shortcut unbinds")
    })
    for (const s of setups) enqueue(s.name, s.run)
}

hyprland.connect("config-reloaded", () => {
    if (settleTimer) GLib.source_remove(settleTimer)
    settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_SETTLE_MS, () => {
        settleTimer = 0
        log.debug("config reloaded — re-registering binds")
        for (const s of setups) enqueue(s.name, s.run)
        return GLib.SOURCE_REMOVE
    })
})

// kiwi's own Hyprland plugin (src/hyprland-plugin), loaded by the shell so
// nobody has to add it to their compositor config. It carries what the shell
// needs from inside the compositor:
//
//   window geometry  moves and resizes on the event socket, which Hyprland
//                    doesn't announce; the dock's auto-hide follows them
//   previews         the switchers' tiles, drawn from the windows themselves
//                    rather than captured
//   genie            minimized windows pouring into their dock icon and back
//
// Loading is all this ever does. A copy that is already in the compositor,
// from an older kiwi or from the user's own config, stays: it does the same
// thing, and taking a plugin out of a running compositor can take the whole
// session with it. The copy this build ships loads at the next login. Older
// kiwis carried the two halves as separate plugins, which count here as
// whichever half they are.
//
// Hyprland asks the user first when its plugin permissions are enforced, and
// a plugin built for another Hyprland refuses to load. Either way the shell
// carries on without it, and the reason is in the log.

/** What the plugin does for the shell, and which plugins provide it. */
const FEATURES = {
    geometry: ["kiwi", "geometry-events"],
    previews: ["kiwi", "kiwi-previews"],
    genie: ["kiwi"],
} as const

// What the shell and kiwi's plugin say to each other, numbered; the plugin
// says its own with `hyprctl kiwi-version` (src/hyprland-plugin/kiwi.hpp).
// One that says another number, or nothing, isn't used: its requests or
// events differ, and what it would do is guesswork.
const PLUGIN_PROTOCOL = 4

const WITHOUT = {
    geometry: "the dock won't see windows moved by hand",
    previews: "the switchers capture their previews instead of showing them live",
    genie: "windows vanish into the dock and reappear instead of pouring in and out of it",
}

const loadedPlugins = new Set<string>()

let pluginsLoaded = () => {}
/** Settles once loadPlugins() knows what the compositor can do. */
export const pluginsReady = new Promise<void>(resolve => { pluginsLoaded = resolve })

/**
 * Tell the plugin which workspace minimized windows are kept in. From then on
 * it posts `kiwigenie>>minimize,ADDRESS` for every window moved there from the
 * screen and `kiwigenie>>restore,ADDRESS` for every one moved back, and holds
 * the window's picture until it hears where the window's icon is (genieTo).
 */
export function genieWatch(workspace: string) {
    if (hasFeature("genie")) void send(`kiwi-genie watch ${workspace}`, "watch minimized windows")
}

/**
 * Where the window the plugin asked about should pour into or out of: the
 * rectangle `icon`, in logical pixels from the top-left of the layer surface
 * called `namespace` — or nowhere, and it just goes or appears.
 */
export function genieTo(address: string, target: { namespace: string; icon: { x: number; y: number; width: number; height: number } } | null) {
    const where = target
        ? `${target.namespace} ${[target.icon.x, target.icon.y, target.icon.width, target.icon.height].map(Math.round).join(",")}`
        : "none"
    void send(`kiwi-genie 0x${address} ${where}`, "place the genie", true)
}

/** Whether the compositor can do this for the shell. Answers after loadPlugins(). */
export const hasFeature = (feature: keyof typeof FEATURES) =>
    FEATURES[feature].some(name => loadedPlugins.has(name))

export async function loadPlugins() {
    const path = typeof PLUGIN === "string" ? PLUGIN : ""
    let loaded: { name: string }[]
    try {
        loaded = JSON.parse(await request("j/plugin list"))
    } catch (e) {
        log.error("could not list the compositor's plugins:", e as Error)
        pluginsLoaded()
        return
    }

    for (const plugin of loaded) loadedPlugins.add(plugin.name)

    const known = new Set(Object.values(FEATURES).flat())
    if ([...loadedPlugins].some(name => known.has(name)))
        log.debug(`kiwi plugins already loaded: ${[...loadedPlugins].filter(name => known.has(name)).join(", ")}`)
    else if (!path)
        log.info("this build ships no kiwi plugin")
    else if (await send(`plugin load ${path}`, "load the kiwi plugin")) {
        loadedPlugins.add("kiwi")
        log.info("kiwi plugin loaded")
    }

    if (loadedPlugins.has("kiwi")) await checkPluginProtocol(path !== "")

    for (const feature of Object.keys(FEATURES) as (keyof typeof FEATURES)[]) {
        if (!hasFeature(feature))
            log.info(`without the kiwi plugin, ${WITHOUT[feature]}`)
    }
    pluginsLoaded()
}

// A plugin from another version stays loaded until the next login (see
// above): a Nix rebuild without logging out, or on Arch a plugin rebuilt by
// hyprpm from the repository ahead of the release the shell came from, or
// behind it. The user is told which of the two to do.
async function checkPluginProtocol(shipsPlugin: boolean) {
    const reply = await request("kiwi-version").catch(() => "")
    const version = /^\d+$/.test(reply.trim()) ? Number(reply.trim()) : null
    if (version === PLUGIN_PROTOCOL) return

    loadedPlugins.delete("kiwi")
    log.warn(`kiwi's plugin speaks protocol ${version ?? "(none, too old to say)"}, this shell ${PLUGIN_PROTOCOL}: not using it`)
    // Everything keeps working meanwhile, the way it does without the plugin
    // (previews are captured, windows vanish into the dock rather than
    // pouring in), so this is a note to finish the update, not a warning.
    const [summary, body] = shipsPlugin
        ? ["Log out to finish updating Kiwi Shell", "Its compositor plugin updates when you log back in."]
        : version !== null && version > PLUGIN_PROTOCOL
            ? ["Update Kiwi Shell", "Its compositor plugin is newer than the shell. Update the shell, then log out and back in."]
            : ["Finish updating Kiwi Shell", "Run hyprpm update, then log out and back in."]
    notify(summary, body, { icon: "system-software-update-symbolic" })
}
