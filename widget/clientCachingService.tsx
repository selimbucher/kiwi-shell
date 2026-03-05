import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { timeout, interval } from "ags/time"
import Gio from "gi://Gio";
import { Gdk } from "ags/gtk4"

Gio._promisify(Hyprland.Hyprland.prototype, "message_async", "message_finish");
Gio._promisify(Gio.Subprocess.prototype, "communicate_async", "communicate_finish");

const hyprland = Hyprland.get_default()
const capturing = new Set<string>()

// Track the previously focused window's address
let previousAddress: string | null = null

export async function getStableId(targetAddress) {
    
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

export async function captureWindowToTexture(stableId: string) {
    if (!stableId) return null;

    try {
        // Spawn grim: -T targets the stableId, - outputs to stdout
        const proc = Gio.Subprocess.new(
            ["grim", "-T", stableId, "-"], 
            Gio.SubprocessFlags.STDOUT_PIPE
        );

        // communicate_async returns [stdoutBytes, stderrBytes]
        const [stdoutBytes] = await (proc as any).communicate_async(null, null);

        if (stdoutBytes && stdoutBytes.get_size() > 0) {
            // Create a GTK4 texture directly from the PNG bytes in memory
            return Gdk.Texture.new_from_bytes(stdoutBytes);
        }
    } catch (e) {
        console.error(`Failed to capture: ${e}`);
    }
    return null;
}