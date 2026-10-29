import { logger } from "../../log"
const log = logger("nightshift")
import { conf } from "../config";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { execAsync } from "ags/process";
import { createState, type Accessor } from "ags";
import { minuteNow } from "./minuteClock";

export const [nightShift, setNightShift] = createState(false);

function timeToMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function isWithinTimeframe(start: string, end: string): boolean {
    const now = GLib.DateTime.new_now_local();
    const current = now.get_hour() * 60 + now.get_minute();
    const s = timeToMinutes(start);
    const e = timeToMinutes(end);

    return s <= e
        ? current >= s && current < e          // same-day range
        : current >= s || current < e;         // wraps past midnight
}

function subscribeChanged<T>(accessor: Accessor<T>, callback: () => void) {
    let prev = accessor.get();
    return accessor.subscribe(() => {
        const current = accessor.get();
        if (current === prev) return;
        prev = current;
        callback();
    });
}

// Night Shift is hyprsunset, this compositor's: on is one running, its
// temperature set through its socket (one per compositor), off is it
// stopped. Another session's (a second login, a nested Hyprland) is left
// alone; stopped by name, turning it off here turned that one off too.
const SIGNATURE = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE") ?? ""
const DISPLAY = GLib.getenv("WAYLAND_DISPLAY") ?? ""
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
        await new Promise(resolve => setTimeout(resolve, 50))
}

// What the state asks for, one step at a time: a schedule change and a
// temperature change in one settings write each turned it on, and the second
// start stopped the first and then failed.
let applying: Promise<void> = Promise.resolve()

async function apply() {
    if (!nightShift()) return stopHyprsunset()
    const temperature = String(Math.round(Number(conf().nightshift_intensity)) || 4000)
    // the one running takes the new temperature; none (or one gone quiet) and one starts
    try {
        await execAsync(["hyprctl", "hyprsunset", "temperature", temperature])
        return
    } catch { /* none answering */ }
    await stopHyprsunset()
    try {
        Gio.Subprocess.new(["hyprsunset", "-t", temperature], Gio.SubprocessFlags.NONE)
        // (up once its socket answers: the next step waits for that)
        for (let waited = 0; waited < 1000; waited += 50) {
            await new Promise(resolve => setTimeout(resolve, 50))
            if (await execAsync(["hyprctl", "hyprsunset", "temperature"]).then(() => true, () => false)) break
        }
    } catch (e) {
        log.error("couldn't run hyprsunset:", e as Error);
        setNightShift(false);
    }
}

export function turnNightShift(on: boolean) {
    setNightShift(on);
    applying = applying.then(apply, apply);
}

function enableNightShift() {
    if (!nightShift()) turnNightShift(true);
}

function disableNightShift() {
    turnNightShift(false);
}

export default function nightShiftService() {
    // null = unknown / needs sync (first run or auto just re-enabled)
    let wasInTimeframe: boolean | null = null;

    function tick() {
        const config = conf();

        if (!config.auto_nightshift) {
            wasInTimeframe = null;
            return;
        }

        const inTimeframe = isWithinTimeframe(config.nightshift_start, config.nightshift_end);

        if (wasInTimeframe === null) {
            // first tick under auto — force sync to schedule
            if (inTimeframe) enableNightShift();
            else disableNightShift();
        } else if (inTimeframe && !wasInTimeframe) {
            enableNightShift();   // entered window
        } else if (!inTimeframe && wasInTimeframe) {
            disableNightShift();  // left window
        }
        // inTimeframe === wasInTimeframe → do nothing, respect manual toggle

        wasInTimeframe = inTimeframe;
    }

    tick();
    // without the schedule, this compositor's left running is on
    if (!conf().auto_nightshift && ourHyprsunsets().length) setNightShift(true);

    subscribeChanged(conf.as(c => c.auto_nightshift), tick);
    subscribeChanged(conf.as(c => c.nightshift_start), tick);
    subscribeChanged(conf.as(c => c.nightshift_end), tick);
    // a new temperature, on now: the running hyprsunset takes it
    subscribeChanged(conf.as(c => c.nightshift_intensity), () => { if (nightShift()) turnNightShift(true) });

    // schedule boundaries are minute-granular, like the shell's clock
    minuteNow.subscribe(tick);
}