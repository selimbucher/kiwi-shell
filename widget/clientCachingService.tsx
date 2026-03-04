import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { timeout, interval } from "ags/time"

const hyprland = Hyprland.get_default()
const capturing = new Set<string>()

// Track the previously focused window's address
let previousAddress: string | null = null

async function cacheWindowByAddress(address: string) {
    if (!address) return
    if (capturing.has(address)) return
    
    capturing.add(address)
    
    const path = `/tmp/win-cache-${address}.png`
    const tempPath = `${path}.tmp` 
    
    try {
        const clientsRaw = await execAsync("hyprctl -j clients")
        const clients = JSON.parse(clientsRaw)
        
        // We strip '0x' just in case)
        const cleanAddress = address.replace("0x", "")
        const winData = clients.find((c: any) => c.address.includes(cleanAddress))
        
        const stableId = winData?.stableId
        if (!stableId) return // Silently abort: window was probably closed
        
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
        timeout(250, () => cacheWindowByAddress(address))
    })
    
    hyprland.connect("notify::focused-client", () => {
        const currentClient = hyprland.get_focused_client()
        const currentAddress = currentClient ? currentClient.get_address() : null

        if (previousAddress && previousAddress !== currentAddress) {
            let a = previousAddress
            timeout(10, () => cacheWindowByAddress(a))
        }

        if (currentAddress) {
            timeout(100, () => cacheWindowByAddress(currentAddress))
            previousAddress = currentAddress
        }
    })

    interval(8000, () => {
        const active = hyprland.get_focused_client()
        if (active && !isVisible()) cacheWindowByAddress(active.get_address())
    })
}