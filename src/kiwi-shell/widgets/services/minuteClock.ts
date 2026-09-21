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

aim()
