import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { timeout, interval } from "ags/time"

const hyprland = Hyprland.get_default()
const capturing = new Set<string>()

// Track the previously focused window's address
let previousAddress: string | null = null

/**
 * Captures a specific window by its address.
 */
async function cacheWindowByAddress(address: string) {
    if (!address) return
    if (capturing.has(address)) return
    
    capturing.add(address)
    
    const path = `/tmp/win-cache-${address}.png`
    const tempPath = `${path}.tmp` 
    
    try {
        // 1. Fetch ALL clients, since the window we want might no longer be the active one
        const clientsRaw = await execAsync("hyprctl -j clients")
        const clients = JSON.parse(clientsRaw)
        
        // 2. Find the specific window data. 
        // (We strip '0x' just in case Astal and hyprctl format addresses slightly differently)
        const cleanAddress = address.replace("0x", "")
        const winData = clients.find((c: any) => c.address.includes(cleanAddress))
        
        const stableId = winData?.stableId
        if (!stableId) return // Silently abort: window was probably closed
        
        // 3. Capture and move
        await execAsync(`grim -T ${stableId} ${tempPath}`)
        await execAsync(`mv ${tempPath} ${path}`)
        
    } catch (err) {
        const errorMsg = String(err)
        const isExpected = errorMsg.includes("cannot stat") || errorMsg.includes("not found") || errorMsg.includes("invalid")
        if (!isExpected) {
            console.error(`[Cacher] Failed to cache window ${address}:`, err)
        }
    } finally {
        capturing.delete(address)
    }
}

export function initWindowCacher(isVisible: () => boolean) {
    hyprland.connect("client-added", (_, client) => {
        if (!client) return
        
        const address = client.get_address()
        // Brand new windows usually need a slightly longer delay (e.g., 300ms) 
        // to finish drawing their very first frame before grim captures them.
        timeout(250, () => cacheWindowByAddress(address))
    })
    
    hyprland.connect("notify::focused-client", () => {
        const currentClient = hyprland.get_focused_client()
        const currentAddress = currentClient ? currentClient.get_address() : null

        // 1. Cache the OLD window that just lost focus
        if (previousAddress && previousAddress !== currentAddress) {
            // A short 100ms delay lets the window visually settle (e.g. lose its active border color)
            let a = previousAddress
            timeout(10, () => cacheWindowByAddress(a))
        }

        // 2. Cache the NEW window that just gained focus
        if (currentAddress) {
            timeout(100, () => cacheWindowByAddress(currentAddress))
            // Update our tracker for the next time focus changes
            previousAddress = currentAddress
        }
    })

    // Keep the background interval running for the currently active window
    interval(8000, () => {
        const active = hyprland.get_focused_client()
        if (active && !isVisible()) cacheWindowByAddress(active.get_address())
    })
}