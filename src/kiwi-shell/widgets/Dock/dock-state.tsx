import { logger } from "../../log"
const log = logger("dock")
import { createState, createComputed, createBinding } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf } from "../config"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import { mapVersion } from "../desktopEntries"
import { entryForClient } from "../appIcon"
import { clientSelector, focusWindow, moveWindowToWorkspace, raiseWindow, toggleSpecialWorkspace } from "../../hypr"

export const DOCK_HIDE_TIMEOUT = 200
export const JUMP_ANIMATION_CLASS_TIMEOUT = 500
export const DOCK_SLIDE_DURATION = 400

export const hyprland = Hyprland.get_default()

export const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/kiwi-shell/dock-apps.json`

export const isNixManaged = !!conf().dock_apps

const initialAppList: string[] = conf().dock_apps ?? (() => {
    try {
        return JSON.parse(readFile(APPLIST_FILE))
    } catch {
        return []
    }
})()

export const [list, setList] = createState<string[]>(initialAppList)

export async function saveList() {
    if (isNixManaged) return
    try {
        await writeFileAsync(APPLIST_FILE, JSON.stringify(list(), null, 2))
    } catch (error) {
        log.error("Failed to save dock apps:", error)
    }
}

export function isValidClient(client: any): boolean {
    const cls = (client["initial-class"] ?? "").trim()
    const title = (client.title ?? "").trim()
    return cls !== "" || title !== ""
}

// ─── Minimize (special-workspace scratchpad) ──────────────────────────────────

export const MINIMIZED_WS = "special:minimized"

const addr = clientSelector

export function isMinimized(client: Hyprland.Client): boolean {
    return client.workspace?.name === MINIMIZED_WS
}

// visible = on the active workspace of some monitor
export function isClientVisible(client: Hyprland.Client): boolean {
    const wsId = client.workspace?.id
    if (wsId === undefined) return false
    return hyprland.get_monitors().some(m => m.activeWorkspace?.id === wsId)
}

export function minimizeClient(client: Hyprland.Client) {
    moveWindowToWorkspace(MINIMIZED_WS, addr(client), { follow: false })
}

// Hyprland keeps focus and stacking separate: focusing a floating window
// does not raise it above overlapping siblings, so every activation path
// raises explicitly.
export function focusClient(client: Hyprland.Client) {
    focusWindow(addr(client))
    raiseWindow(addr(client))
}

export function restoreClient(client: Hyprland.Client) {
    // a following move also focuses the window, so it lands on the current
    // workspace ready to use
    moveWindowToWorkspace(hyprland.focusedWorkspace.id, addr(client))
    raiseWindow(addr(client))
}

// ─── Focus-steal guard ────────────────────────────────────────────────────────
// With focus_on_activate, external activations (xdg-open behind the dock's
// home/trash buttons, single-instance file managers, links opening in a
// minimized browser, …) can focus a minimized window, which drags the whole
// special workspace into view. Treat any focus landing on a minimized window
// as "restore it": pull it to the last real workspace, then close the
// overlay that is left showing the remaining minimized windows.

let lastNormalWs = hyprland.focusedWorkspace?.id ?? 1
hyprland.connect("notify::focused-workspace", () => {
    const id = hyprland.focusedWorkspace?.id
    if (id !== undefined && id > 0) lastNormalWs = id
})

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.focusedClient
    if (!client || !isMinimized(client)) return
    moveWindowToWorkspace(lastNormalWs, addr(client))
    raiseWindow(addr(client))
    // the overlay state settles asynchronously (socket events), so check
    // slightly later whether it is still open — it auto-closes only when
    // the restored window was the last one minimized
    setTimeout(() => {
        for (const m of hyprland.get_monitors()) {
            if (m.specialWorkspace?.name === MINIMIZED_WS)
                toggleSpecialWorkspace("minimized")
        }
    }, 150)
})

export const unpinnedList = createComputed(get => {
    get(mapVersion) // reactive dependency — re-runs when maps rebuild
    const clients = get(createBinding(hyprland, "clients"))
    const pinned = new Set(get(list))

    const seen = new Set<string>()
    return clients.reduce((acc, client) => {
        if (!isValidClient(client)) return acc
        const entry = entryForClient(client)
        if (pinned.has(entry) || seen.has(entry)) return acc
        seen.add(entry)
        acc.push(entry)
        return acc
    }, [] as string[])
})