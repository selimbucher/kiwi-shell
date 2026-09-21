import { logger } from "../../log"
const log = logger("nightshift")
import { conf } from "../config";
import GLib from "gi://GLib";
import { execAsync } from "ags/process";
import { nightShift, setNightShift } from "../Bar/SystemMenu/tabs/SystemTab";
import type { Accessor } from "ags";
import { minuteNow } from "./minuteClock";

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

function enableNightShift() {
    if (nightShift()) return;
    try {
        GLib.spawn_command_line_async(`hyprsunset -t ${conf().nightshift_intensity}`);
    } catch (e) {
        log.error("nightshift: failed to spawn hyprsunset:", e);
        return;
    }
    setNightShift(true);
}

function disableNightShift() {
    if (!nightShift()) return;
    try {
        GLib.spawn_command_line_async("killall hyprsunset");
    } catch (e) {
        log.error("nightshift: failed to spawn killall:", e);
        return;
    }
    setNightShift(false);
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

    subscribeChanged(conf.as(c => c.auto_nightshift), tick);
    subscribeChanged(conf.as(c => c.nightshift_start), tick);
    subscribeChanged(conf.as(c => c.nightshift_end), tick);

    // schedule boundaries are minute-granular, like the shell's clock
    minuteNow.subscribe(tick);
}