import KiwiShortcuts from "gi://KiwiShortcuts"
import type { BindAction } from "../../hypr"

// ─── Global shortcuts ─────────────────────────────────────────────────────────
// The shell's binds reach it as global shortcuts (hyprland-global-shortcuts-v1):
// the compositor sends the key down a Wayland connection the shell holds
// open. `exec kiwictl …` had the compositor start a shell, which ran the
// kiwictl script, which started the ags client, which asked the shell over
// D-Bus — 30-100 ms before a switcher could begin to open, and again on
// every Tab while it was open.
//
// A press bind sends "activated" and a release bind "released". The global
// dispatcher of a hyprlang config sends both for every bind, so each id
// answers exactly one of the two.

export type Edge = "press" | "release"

const handlers = new Map<string, { edge: Edge; run: () => void }>()
let manager: KiwiShortcuts.Manager | null = null

function fire(edge: Edge, id: string) {
    const handler = handlers.get(id)
    if (handler?.edge === edge) handler.run()
}

// Registers `id` and returns the action that triggers it from a bind. An id
// is registered with the compositor once: a second registration is a
// protocol error, and that takes every shortcut of the connection with it.
export function globalShortcut(id: string, description: string, edge: Edge, run: () => void): BindAction {
    if (!manager) {
        manager = new KiwiShortcuts.Manager()
        manager.connect("activated", (_: unknown, id: string) => fire("press", id))
        manager.connect("released", (_: unknown, id: string) => fire("release", id))
    }
    if (!handlers.has(id)) manager.register(id, description)
    handlers.set(id, { edge, run })
    return { global: `kiwi-shell:${id}` }
}
