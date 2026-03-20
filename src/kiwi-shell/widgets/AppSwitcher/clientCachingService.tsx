import { Gdk } from "ags/gtk4"
import AppCapture from "gi://AppCapture?version=1.0"
import Hyprland from "gi://AstalHyprland"

// How long a cached texture is considered fresh.
// Switcher opens under this threshold → instant display, no capture fired.
const STALE_MS = 60_000

// How long to wait after a new window appears before capturing it.
// Gives the window time to render its first frame.
const NEW_WINDOW_CAPTURE_DELAY_MS = 800

// How often to re-capture the focused window in the background.
// Keeps the active window's preview reasonably up to date without polling
// every window. Skipped if a capture for this address is already fresh.
const FOCUSED_POLL_INTERVAL_MS = 6_000

const capturer = new AppCapture.Capture()
const hyprland = Hyprland.get_default()

// ─── Texture cache ─────────────────────────────────────────────────────────────
interface CacheEntry {
    texture: Gdk.Texture
    capturedAt: number
}

const cache = new Map<string, CacheEntry>()

// ─── Concurrency queue ─────────────────────────────────────────────────────────
// Only one capture runs at a time to avoid piling up memfd allocations.
let activeCapture = false
const captureQueue: Array<() => void> = []

function drainQueue() {
    if (activeCapture || captureQueue.length === 0) return
    captureQueue.shift()!()
}

// ─── Core capture ──────────────────────────────────────────────────────────────
// Internal — enqueues a live capture and updates the cache on success.
function captureNow(address: string): Promise<Gdk.Texture | null> {
    return new Promise((resolve) => {
        captureQueue.push(() => {
            activeCapture = true
            let signalId: number | null = null

            const finish = (result: Gdk.Texture | null) => {
                activeCapture = false
                resolve(result)
                Promise.resolve().then(drainQueue)
            }

            const timeoutId = setTimeout(() => {
                if (signalId !== null) capturer.disconnect(signalId)
                console.error(`AppCapture: timeout for address ${address}`)
                finish(null)
            }, 2000)

            signalId = capturer.connect(
                "frame-ready",
                (_obj: any, bytes: any, width: number, height: number, stride: number) => {
                    capturer.disconnect(signalId!)
                    clearTimeout(timeoutId)
                    let texture: Gdk.Texture | null = null
                    try {
                        texture = buildTexture(bytes, width, height, stride)
                    } catch (e) {
                        console.error(`AppCapture: buildTexture failed: ${e}`)
                    }
                    if (texture) cache.set(address, { texture, capturedAt: Date.now() })
                    finish(texture)
                }
            )

            capturer.capture_by_handle(address)
        })
        drainQueue()
    })
}

// ─── Proactive capture: on focus change ────────────────────────────────────────
// Capture the window that just lost focus — it had user activity so its
// visual state is fresh. This keeps the cache warm without any polling.
let lastFocusedAddress: string | null = null

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    const newAddr = client?.get_address() ?? null

    if (lastFocusedAddress && lastFocusedAddress !== newAddr)
        captureNow(lastFocusedAddress)

    lastFocusedAddress = newAddr
})

// ─── Proactive capture: periodic poll of the focused window ───────────────────
// The focus-change capture only fires when you switch away, so the active
// window's preview can drift. This interval re-captures it every few seconds.
// Skipped if the cache entry is already fresh (e.g. focus just changed).
setInterval(() => {
    if (!lastFocusedAddress) return
    const entry = cache.get(lastFocusedAddress)
    if (entry && Date.now() - entry.capturedAt < FOCUSED_POLL_INTERVAL_MS) return
    captureNow(lastFocusedAddress)
}, FOCUSED_POLL_INTERVAL_MS)

// ─── Proactive capture: on new window ─────────────────────────────────────────
// Capture newly opened windows after a short delay so they have time to
// render. Also evict cache entries for windows that have closed.
let knownAddresses = new Set<string>(
    hyprland.get_clients().map(c => c.get_address())
)

hyprland.connect("notify::clients", () => {
    const current = new Map(
        hyprland.get_clients().map(c => [c.get_address(), c])
    )

    // Evict closed windows from cache
    for (const addr of cache.keys()) {
        if (!current.has(addr)) cache.delete(addr)
    }

    // Schedule a capture for windows we haven't seen before
    for (const [addr] of current) {
        if (!knownAddresses.has(addr))
            setTimeout(() => captureNow(addr), NEW_WINDOW_CAPTURE_DELAY_MS)
    }

    knownAddresses = new Set(current.keys())
})

// ─── Public API ────────────────────────────────────────────────────────────────
// Returns the cached texture immediately if fresh enough.
// Falls back to a live capture for stale or missing entries.
// The AppSwitcher calls this per-window when it opens.
export function captureWindowToTexture(address: string): Promise<Gdk.Texture | null> {
    const entry = cache.get(address)

    if (entry && Date.now() - entry.capturedAt < STALE_MS)
        return Promise.resolve(entry.texture)

    return captureNow(address)
}

// ─── buildTexture ──────────────────────────────────────────────────────────────
function buildTexture(bytes: any, width: number, height: number, stride: number): Gdk.Texture {
    const builder = new Gdk.MemoryTextureBuilder()
    builder.set_bytes(bytes)
    builder.set_width(width)
    builder.set_height(height)
    builder.set_stride(stride)
    // Hyprland exports WL_SHM_FORMAT_XRGB8888.
    // On little-endian x86 this is B-G-R-X in memory.
    builder.set_format(Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED)
    return builder.build()
}