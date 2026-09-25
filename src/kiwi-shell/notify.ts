import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { logger } from "./log"

const log = logger("notify")

type Options = {
    app?: string
    icon?: string
    // 0 low, 1 normal, 2 critical
    urgency?: 0 | 1 | 2
}

// A desktop notification, sent over D-Bus to whoever shows them — kiwi
// itself, usually — so nothing like notify-send has to be installed. Early at
// startup kiwi may not have taken the name yet, so a failed send is tried once
// more a moment later.
export function notify(summary: string, body: string, options: Options = {}, retry = true) {
    const hints = { urgency: new GLib.Variant("y", options.urgency ?? 1) }
    Gio.DBus.session.call(
        "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications", "Notify",
        new GLib.Variant("(susssasa{sv}i)",
            [options.app ?? "Kiwi Shell", 0, options.icon ?? "", summary, body, [], hints, -1]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (_connection, result) => {
            try {
                Gio.DBus.session.call_finish(result)
            } catch (e) {
                if (!retry) return log.warn(`could not show "${summary}":`, e as Error)
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    notify(summary, body, options, false)
                    return GLib.SOURCE_REMOVE
                })
            }
        },
    )
}
