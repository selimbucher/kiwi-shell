import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { timeout, interval } from "ags/time"

const hyprland = Hyprland.get_default()

/**
 * Captures the currently active window and saves it to /tmp.
 * Uses a temp file + mv to ensure the UI doesn't read a half-written file.
 */
async function cacheActiveWindow(isVisible: () => boolean) {
    const activeClient = hyprland.get_focused_client()
    
    // Don't capture if the switcher is already open or no window is focused
    if (isVisible() || !activeClient) return

    const address = activeClient.get_address()
    const x = activeClient.get_x()
    const y = activeClient.get_y()
    const w = activeClient.get_width()
    const h = activeClient.get_height()
    
    const path = `/tmp/win-cache-${address}.png`
    
    try {
        // Capture to a temporary file first
        await execAsync(`grim -g "${x},${y} ${w}x${h}" ${path}.tmp`)
        // Move it to the final path (atomic operation)
        await execAsync(`mv ${path}.tmp ${path}`)
    } catch (err) {
        console.error(`[Cacher] Failed to cache window ${address}:`, err)
    }
}

export function initWindowCacher(isVisible: () => boolean) {
    // Take a screenshot 500ms after a window gains focus
    hyprland.connect("notify::focused-client", () => {
        timeout(500, () => cacheActiveWindow(isVisible))
    })

    interval(3000, () => cacheActiveWindow(isVisible))
}