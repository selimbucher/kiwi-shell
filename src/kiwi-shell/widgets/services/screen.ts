import Hyprland from "gi://AstalHyprland"
import { createState } from "ags"

// ─── Whether the screen is seen ───────────────────────────────────────────────
// Not while the session is locked (the lock screen covers everything), nor
// with every display switched off. kiwi's plugin says when (screen.cpp:
// kiwiscreen>>locked|unlocked, kiwiscreen>>dpms,<monitor>,0|1); without it
// the screen counts as seen. What only shows on screen — the island's music
// bars, listening to the speakers — rests meanwhile.

const hyprland = Hyprland.get_default()

const [seen, setSeen] = createState(true)
export const screenSeen = seen

let locked = false
/** Whether the session is locked, as the plugin last said. */
export const isLocked = () => locked
// the displays switched off, by name
const off = new Set<string>()

function judge() {
    const on = hyprland.get_monitors().filter(m => !m.disabled && !off.has(m.name))
    setSeen(!locked && on.length > 0)
}

hyprland.connect("event", (_h: unknown, event: string, args: string) => {
    if (event !== "kiwiscreen") return
    if (args === "locked") locked = true
    else if (args === "unlocked") locked = false
    else if (args.startsWith("dpms,")) {
        const [, name, state] = args.split(",")
        if (state === "0") off.add(name)
        else off.delete(name)
    } else return
    judge()
})
// a display gone takes its state with it
hyprland.connect("monitor-removed", (_h: unknown, id: number) => {
    for (const name of [...off]) if (!hyprland.get_monitors().some(m => m.name === name)) off.delete(name)
    void id
    judge()
})
