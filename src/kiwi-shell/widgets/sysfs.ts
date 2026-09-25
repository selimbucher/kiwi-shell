import GLib from "gi://GLib"

// Reading /sys and /proc without spawning anything and without throwing.
// Which files exist differs from machine to machine, and a file that exists
// can still refuse to be read (root-only, a device that is asleep or gone),
// so every read answers null instead and the caller decides what to show.

export function listDir(path: string): string[] {
    const out: string[] = []
    try {
        const dir = GLib.Dir.open(path, 0)
        let name: string | null
        while ((name = dir.read_name()) !== null) out.push(name)
        dir.close()
    } catch {}
    return out
}

export function readText(path: string): string | null {
    try {
        const [ok, bytes] = GLib.file_get_contents(path)
        return ok ? new TextDecoder().decode(bytes).trim() : null
    } catch {
        return null
    }
}

export function readNumber(path: string): number | null {
    const text = readText(path)
    if (text === null || text === "") return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
}

// the name of the driver bound to a device, e.g. "i915", "amdgpu", "nvidia"
export function driverName(devicePath: string): string | null {
    try {
        return GLib.path_get_basename(GLib.file_read_link(`${devicePath}/driver`))
    } catch {
        return null
    }
}
