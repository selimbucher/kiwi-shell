import { logger } from "../../log"
const log = logger("nightshift")
import { conf } from "../config";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { execAsync } from "ags/process";
import { createComputed, createState, type Accessor } from "ags";
import { minuteNow, clockTime } from "./minuteClock";
import { sun } from "./sun";

// ─── Night Shift ──────────────────────────────────────────────────────────────
// As on a Mac: on a schedule (sunset to sunrise, or set times) or by hand,
// on by hand until the schedule's next end, off by hand until its next
// start. The colours change gradually: the schedule's over half a minute,
// the switch's over two seconds. The warmth shows while it is being chosen,
// off or on, and goes back to what it was once let go of.

export const [nightShift, setNightShift] = createState(false);

const MANUAL_MS = 2000
const SCHEDULED_MS = 30_000
const BACK_FROM_PREVIEW_MS = 1500
// no warmth: what hyprsunset starts at before it fades in, and fades to
// before it stops, so neither shows as a jump
const NEUTRAL = 6500

const warmth = () => Math.round(Number(conf().nightshift_intensity)) || 4000

// ─── hyprsunset, this compositor's ───────────────────────────────────────────
// On is one running, its temperature set through its socket (one per
// compositor); off is it stopped. Another session's (a second login, a
// nested Hyprland) is left alone: stopped by name, turning it off here turned
// that one off too.
const SIGNATURE = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE") ?? ""
const DISPLAY = GLib.getenv("WAYLAND_DISPLAY") ?? ""
const SOCKET = `${GLib.get_user_runtime_dir()}/hypr/${SIGNATURE}/.hyprsunset.sock`
const decoder = new TextDecoder()

function ourHyprsunsets(): string[] {
    const pids: string[] = []
    let dir: GLib.Dir
    try {
        dir = GLib.Dir.open("/proc", 0)
    } catch {
        return pids
    }
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (!/^\d+$/.test(name)) continue
        try {
            if (decoder.decode(GLib.file_get_contents(`/proc/${name}/comm`)[1]).trim() !== "hyprsunset") continue
            const env = decoder.decode(GLib.file_get_contents(`/proc/${name}/environ`)[1]).split("\0")
            const signature = env.find(v => v.startsWith("HYPRLAND_INSTANCE_SIGNATURE="))
            if (signature ? signature === `HYPRLAND_INSTANCE_SIGNATURE=${SIGNATURE}` : env.includes(`WAYLAND_DISPLAY=${DISPLAY}`))
                pids.push(name)
        } catch { /* gone meanwhile, or not ours to read */ }
    }
    dir.close()
    return pids
}

// gone, or after a second: one stopped holds the screen's colours until it
// has quit, and the next couldn't start meanwhile
async function stopHyprsunset() {
    const pids = ourHyprsunsets()
    if (!pids.length) return
    await execAsync(["kill", ...pids]).catch(e => log.error("couldn't stop hyprsunset:", e as Error))
    for (let waited = 0; waited < 1000 && pids.some(pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)); waited += 50)
        await sleep(50)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// One request on its socket ("temperature 4000"), its answer: what hyprctl
// hyprsunset does, without a process for each of a fade's steps.
// (a hyprsunset that doesn't answer within a second is taken for none)
function ask(request: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const cancel = new Gio.Cancellable()
        const timeout = setTimeout(() => cancel.cancel(), 1000)
        // (a GLib.Error isn't an Error: what failed is told apart by the call)
        const fail = (e: unknown) => { clearTimeout(timeout); reject(e) }
        const client = new Gio.SocketClient()
        client.connect_async(new Gio.UnixSocketAddress({ path: SOCKET }), cancel, (_c, connecting) => {
            let connection: Gio.SocketConnection
            try {
                connection = client.connect_finish(connecting)
            } catch (e) {
                return fail(e)
            }
            const close = () => connection.close_async(GLib.PRIORITY_DEFAULT, null, null)
            connection.get_output_stream().write_all_async(new TextEncoder().encode(request), GLib.PRIORITY_DEFAULT, cancel, (out, writing) => {
                try {
                    out!.write_all_finish(writing)
                } catch (e) {
                    close()
                    return fail(e)
                }
                connection.get_input_stream().read_bytes_async(64, GLib.PRIORITY_DEFAULT, cancel, (input, reading) => {
                    let answer: string
                    try {
                        answer = decoder.decode(input!.read_bytes_finish(reading).toArray()).trim()
                    } catch (e) {
                        close()
                        return fail(e)
                    }
                    close()
                    clearTimeout(timeout)
                    resolve(answer)
                })
            })
        })
    })
}

// the temperature on the screen now; null with none running
let shown: number | null = null

// one running, at `start` if it has to be started; false if none could be.
// One start at a time: a slider's ticks each asked, and each start stopped
// the one before it as it came up.
let starting: Promise<boolean> | null = null
function running(start: number): Promise<boolean> {
    starting ??= start_(start).finally(() => { starting = null })
    return starting
}

async function start_(start: number): Promise<boolean> {
    const answer = await ask("temperature").catch(() => null)
    if (answer !== null) {
        // (one left running by the shell before: from what it shows)
        if (shown === null && Number(answer) > 0) shown = Number(answer)
        return true
    }
    await stopHyprsunset()
    try {
        Gio.Subprocess.new(["hyprsunset", "-t", String(start)], Gio.SubprocessFlags.NONE)
    } catch (e) {
        log.error("couldn't run hyprsunset:", e as Error)
        return false
    }
    for (let waited = 0; waited < 1500; waited += 50) {
        await sleep(50)
        if (await ask("temperature").then(() => true, () => false)) {
            shown = start
            return true
        }
    }
    log.error("hyprsunset didn't come up")
    return false
}

// ─── Fading ───────────────────────────────────────────────────────────────────
// Hyprland fades each change of the colours by itself, over half a second
// (CTMControl: linearly, from the last change's end), so a fade is a change
// every half second along an ease, each one taking off where the one before
// ended: a smooth curve, a few dozen requests for the schedule's half minute.
const STEP_MS = 500

let fading = 0

async function fadeTo(target: number | null, ms: number) {
    const fade = ++fading
    const to = target ?? NEUTRAL
    // (off and none running: nothing to fade. One left running by the shell
    // before is faded from what it shows)
    if (shown === null && target === null && !ourHyprsunsets().length) return
    // (in from no warmth when it takes a while, at once when it doesn't)
    if (!await running(shown ?? (ms > STEP_MS ? NEUTRAL : to))) {
        if (fade === fading) setNightShift(false)
        return
    }
    const from = shown ?? NEUTRAL
    const steps = Math.max(1, Math.round(ms / STEP_MS))
    for (let i = 1; i <= steps; i++) {
        if (fade !== fading) return
        const t = i / steps
        const kelvin = Math.round(from + (to - from) * t * t * (3 - 2 * t))
        if (kelvin !== shown) {
            // (gone meanwhile, stopped by a fade before this one: started again)
            if (!await ask(`temperature ${kelvin}`).then(() => true, () => false)) {
                shown = null
                if (!await running(kelvin)) return
            }
            shown = kelvin
        }
        if (i < steps) await sleep(STEP_MS)
    }
    if (target === null && fade === fading) {
        await stopHyprsunset()
        if (fade === fading) shown = null
    }
}

// ─── What it is ───────────────────────────────────────────────────────────────

let previewing = false

function show(ms: number) {
    if (!previewing) void fadeTo(nightShift() ? warmth() : null, ms)
}

/** On or off by hand (the system menu), gradually. */
export function turnNightShift(on: boolean) {
    setNightShift(on);
    show(MANUAL_MS)
}

/**
 * A warmth shown while it is being chosen (Kiwi Settings' slider), on or
 * off; null for the choosing done, the screen fading back to what it is.
 */
export function previewNightShift(kelvin: number | null) {
    if (kelvin === null) {
        if (!previewing) return
        previewing = false
        show(BACK_FROM_PREVIEW_MS)
        return
    }
    previewing = true
    void fadeTo(Math.min(NEUTRAL, Math.max(1000, Math.round(kelvin))), 0)
}

// ─── The schedule ─────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string) => {
    const [h, m] = String(hhmm).split(":").map(Number)
    return (h || 0) * 60 + (m || 0)
}

// the schedule's start and end, in minutes after midnight; "always" or
// "never" for a sun that doesn't set or rise today, null without a schedule
type Window = { start: number, end: number } | "always" | "never" | null

const schedule: Accessor<Window> = createComputed(get => {
    const c = get(conf)
    if (!c.auto_nightshift) return null
    if (c.nightshift_schedule !== "sunset") return { start: minutesOf(c.nightshift_start), end: minutesOf(c.nightshift_end) }
    const times = get(sun)
    if (times === "day") return "never"
    if (times === "night") return "always"
    // (no place known: the set times meanwhile)
    return times ? { start: times.sunset, end: times.sunrise } : { start: minutesOf(c.nightshift_start), end: minutesOf(c.nightshift_end) }
})

function within(window: Window, now: GLib.DateTime): boolean {
    if (window === "always") return true
    if (window === null || window === "never") return false
    const current = now.get_hour() * 60 + now.get_minute()
    return window.start <= window.end
        ? current >= window.start && current < window.end
        : current >= window.start || current < window.end
}

// minutes after midnight as the clock shows a time
const timeOfDay = (minutes: number) => {
    const now = GLib.DateTime.new_now_local()
    return clockTime(GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(),
        Math.floor(minutes / 60) % 24, minutes % 60, 0))
}

/**
 * What the switch would say under its name, as a Mac's Control Center does:
 * how long it stays as it is ("On until 06:00", "Off until sunset"), with a
 * schedule; nothing without one.
 */
export const nightShiftUntil: Accessor<string> = createComputed(get => {
    const window = get(schedule)
    const on = get(nightShift)
    get(minuteNow)
    if (window === null || window === "always" || window === "never") return ""
    const sunset = get(conf).nightshift_schedule === "sunset" && get(sun) !== null
    if (on) return `On until ${sunset ? "sunrise" : timeOfDay(window.end)}`
    return `Off until ${sunset ? "sunset" : timeOfDay(window.start)}`
})

export default function nightShiftService() {
    // the schedule's side last seen: crossing it switches, as a Mac's does;
    // between crossings a hand's switch stands. null: not looked yet
    let wasWithin: boolean | null = null

    function tick() {
        const window = schedule.peek()
        if (window === null) {
            wasWithin = null
            return
        }
        const inside = within(window, minuteNow.peek())
        if (wasWithin === null) {
            // the schedule just set, or the shell just started: as it says, at once
            setNightShift(inside)
            show(0)
        } else if (inside !== wasWithin) {
            setNightShift(inside)
            show(SCHEDULED_MS)
        }
        wasWithin = inside
    }

    // without a schedule, one left running is on
    if (!conf().auto_nightshift && ourHyprsunsets().length) setNightShift(true)

    tick()
    // a schedule changed (switched on, other times, today's sun): it switches
    // only where now falls on its other side, a hand's switch kept otherwise
    schedule.subscribe(tick)
    minuteNow.subscribe(tick)

    // a new warmth, while on: shown at once (Hyprland's own half second)
    let lastWarmth = warmth()
    conf.subscribe(() => {
        if (warmth() === lastWarmth) return
        lastWarmth = warmth()
        if (nightShift()) show(0)
    })
}
