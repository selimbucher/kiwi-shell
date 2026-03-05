import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { timeout, interval } from "ags/time"
import Gio from "gi://Gio";

Gio._promisify(Hyprland.Hyprland.prototype, "message_async", "message_finish");

const hyprland = Hyprland.get_default()
const capturing = new Set<string>()

// Track the previously focused window's address
let previousAddress: string | null = null

async function getStableId(targetAddress) {
    
    // HIGH PERFORMANCE: Talks directly to the UNIX socket in C
    const rawJson = await hyprland.message_async("j/clients"); 
    const clients = JSON.parse(rawJson);
    
    // Astal addresses usually start with "0x", Hyprland JSON might omit it depending on the version.
    // Make sure you clean the address if needed: targetAddress.replace("0x", "")
    const client = clients.find(c => c.address.includes(targetAddress.replace("0x", "")));
    
    return client? client.stableId : null;
}

async function cacheWindow(address) {
    const stableId = await getStableId(address);
    
    if (stableId) {
        const tempPath = `/tmp/win-cache-${address}.tmp.png`;
        const finalPath = `/tmp/win-cache-${address}.png`;
        
        // We still have to spawn grim, but we completely eliminated 
        // the hyprctl and jq subprocesses shown in the community workaround
        await execAsync(`grim -T ${stableId} ${tempPath}`);
        await execAsync(`mv ${tempPath} ${finalPath}`);
    }
}

export function initWindowCacher(isVisible: () => boolean) {
    hyprland.connect("client-added", (_, client) => {
        if (!client) return
        
        const address = client.get_address()
        timeout(250, () => cacheWindow(address))
    })
    
    hyprland.connect("notify::focused-client", () => {
        const currentClient = hyprland.get_focused_client()
        const currentAddress = currentClient ? currentClient.get_address() : null

        if (previousAddress && previousAddress !== currentAddress) {
            let a = previousAddress
            timeout(10, () => cacheWindow(a))
        }

        if (currentAddress) {
            timeout(100, () => cacheWindow(currentAddress))
            previousAddress = currentAddress
        }
    })

    interval(8000, () => {
        const active = hyprland.get_focused_client()
        if (active && !isVisible()) cacheWindow(active.get_address())
    })
}