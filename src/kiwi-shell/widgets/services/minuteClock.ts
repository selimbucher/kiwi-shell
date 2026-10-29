import { createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

// The shell's one clock. Everything that follows the time of day shows or
// acts on it to the minute (the bar, the system menu, the night shift
// schedule, "5m ago" on notifications), so it ticks once per minute, on the
// minute, rather than each of them polling on its own.
//
// A GLib timeout runs on the monotonic clock, which stands still while the
// machine sleeps, so after a resume the next tick would come as late as the
// sleep was long. logind announces the wake-up, and the clock re-reads the
// time and re-aims at the next minute then.

const now = () => GLib.DateTime.new_now_local()

const [minuteNow, setMinuteNow] = createState(now())
export { minuteNow }

let tickId = 0

function aim() {
    if (tickId) GLib.source_remove(tickId)
    const t = now()
    const ms = (60 - t.get_second()) * 1000 - Math.floor(t.get_microsecond() / 1000)
    // a few ms past the boundary, so the tick never lands just before it
    tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms) + 5, () => {
        tickId = 0
        tick()
        return GLib.SOURCE_REMOVE
    })
}

function tick() {
    setMinuteNow(now())
    aim()
}

// (no system bus, a container say: the next tick puts it right instead)
try {
    Gio.DBus.system.signal_subscribe(
        "org.freedesktop.login1",
        "org.freedesktop.login1.Manager",
        "PrepareForSleep",
        "/org/freedesktop/login1",
        null,
        Gio.DBusSignalFlags.NONE,
        (_conn, _sender, _path, _iface, _signal, params) => {
            const [goingToSleep] = params.deepUnpack() as [boolean]
            if (!goingToSleep) tick()
        },
    )
} catch { /* no wake-ups heard */ }

aim()

// ─── 12 or 24 hours ───────────────────────────────────────────────────────────
// The desktop's clock-format (Kiwi Settings' switch, GNOME's Settings), 24
// unless it says 12. Not the language's: en_US is most Linux setups' English,
// counting to 24 or not.
const INTERFACE = "org.gnome.desktop.interface"
const interfaceSchema = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE, true)
const interfaceSettings = interfaceSchema?.has_key("clock-format") ? new Gio.Settings({ schema_id: INTERFACE }) : null
const reads12 = () => interfaceSettings?.get_string("clock-format") === "12h"
const [twelveHours, setTwelveHours] = createState(reads12())
interfaceSettings?.connect("changed::clock-format", () => setTwelveHours(reads12()))
export { twelveHours }

/** "14:05", or "2:05 PM" where the clock counts to 12; `suffix` false leaves the PM off. */
export function clockTime(t: GLib.DateTime, suffix = true): string {
    if (!twelveHours.get()) return t.format("%H:%M") ?? ""
    return (t.format(suffix ? "%l:%M %p" : "%l:%M") ?? "").trim()
}

/** The hour alone: "14", or "2 PM". */
export function clockHour(t: GLib.DateTime): string {
    return (twelveHours.get() ? t.format("%l %p") : t.format("%H"))?.trim() ?? ""
}
