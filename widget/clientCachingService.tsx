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
    const path = `/tmp/win-cache-${address}.png`
    
    try {
        // 1. Fetch the raw JSON for the active window to get the brand new 'stableId'
        const winDataRaw = await execAsync("hyprctl -j activewindow")
        const winData = JSON.parse(winDataRaw)
        
        // 2. Safely extract the stableId
        const stableId = winData?.stableId
        if (!stableId) {
            console.warn(`[Cacher] No stableId found for window ${address}`)
            return
        }
        // Capture to a temporary file first
        await execAsync(`grim -T ${stableId} ${path}.tmp`)
        // Move it to the final path (atomic operation)
        await execAsync(`mv ${path}.tmp ${path}`)
    } catch (err) {
        console.error(`[Cacher] Failed to cache window ${address}:`, err)
    }
}

export function initWindowCacher(isVisible: () => boolean) {
    // Take a screenshot 500ms after a window gains focus
    hyprland.connect("notify::focused-client", () => {
        timeout(10, () => cacheActiveWindow(isVisible))
    })

    interval(5000, () => cacheActiveWindow(isVisible))
}