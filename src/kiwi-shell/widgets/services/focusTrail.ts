import app from "ags/gtk4/app"
import { Astal } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import { logger } from "../../log"

const log = logger("focus")

// ─── Who has the keyboard ─────────────────────────────────────────────────────
// For the times nothing seems to: Hyprland says which window has the
// keyboard each time it changes (activewindowv2, empty for none, or a layer
// surface), and with it go kiwi's own surfaces that are up and could take it.
// The moment it went missing is then in the log, found after the fact (Alt+Tab
// puts the keyboard back before anyone can look). Only on a change: nothing
// runs in between.

const hyprland = Hyprland.get_default()

hyprland.connect("event", (_h: unknown, event: string, data: string) => {
    if (event !== "activewindowv2") return
    const client = data ? hyprland.get_client(data) : null
    const takers = app.get_windows()
        .filter((w): w is Astal.Window => w instanceof Astal.Window && w.get_visible() && w.keymode !== Astal.Keymode.NONE)
        .map(w => `${w.name} (${w.keymode === Astal.Keymode.EXCLUSIVE ? "exclusive" : "on demand"})`)
    const who = client ? `${client.class} 0x${data}` : data ? `0x${data}` : "no window"
    log.info(`keyboard to ${who}${takers.length ? `; kiwi up and able to take it: ${takers.join(", ")}` : ""}`)
})
