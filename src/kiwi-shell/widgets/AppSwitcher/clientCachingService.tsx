import { logger } from "../../log"
const log = logger("app-capture")
import { Gdk } from "ags/gtk4"
import AppCapture from "gi://AppCapture?version=1.0"
import Hyprland from "gi://AstalHyprland"
import { isMinimized } from "../Dock/dock-state"

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

// Backstop in case the C library never emits either signal (e.g. compositor
// stalled). C-side handles its own timeouts at 1.5s for the wlr-mapping race
// and reports failure synchronously for everything else, so this should
// effectively never fire.
const SAFETY_TIMEOUT_MS = 5_000

const capturer = new AppCapture.Capture()
const hyprland = Hyprland.get_default()

// ─── Texture cache ─────────────────────────────────────────────────────────────
interface CacheEntry {
    texture: Gdk.Texture
    capturedAt: number
}

const cache = new Map<string, CacheEntry>()

// ─── Concurrency queue ─────────────────────────────────────────────────────────
// Only one capture runs at a time. The C library itself has shared per-frame
// state (shm_fd, dimensions, pixel buffer) so concurrent captures would
// clobber each other.
let activeCapture = false
const captureQueue: Array<() => void> = []

function drainQueue() {
    if (activeCapture || captureQueue.length === 0) return
    captureQueue.shift()!()
}

// ─── Core capture ──────────────────────────────────────────────────────────────
// Internal — enqueues a live capture and updates the cache on success.
function captureNow(address: string): Promise<Gdk.Texture | null> {
    // a minimized window is unmapped, so a capture would fail or grab
    // garbage — serve whatever the cache holds from before it was stashed
    const client = hyprland.get_clients().find(c => c.get_address() === address)
    if (client && isMinimized(client))
        return Promise.resolve(cache.get(address)?.texture ?? null)

    return new Promise((resolve) => {
        captureQueue.push(() => {
            activeCapture = true
            let readyId = 0
            let failedId = 0
            let safetyId: ReturnType<typeof setTimeout> | null = null

            const finish = (result: Gdk.Texture | null) => {
                if (readyId)  { capturer.disconnect(readyId);  readyId  = 0 }
                if (failedId) { capturer.disconnect(failedId); failedId = 0 }
                if (safetyId) { clearTimeout(safetyId);        safetyId = null }
                activeCapture = false
                resolve(result)
                Promise.resolve().then(drainQueue)
            }

            readyId = capturer.connect(
                "frame-ready",
                (_obj: any, bytes: any, width: number, height: number, stride: number) => {
                    let texture: Gdk.Texture | null = null
                    try {
                        texture = buildTexture(bytes, width, height, stride)
                    } catch (e) {
                        log.error(`buildTexture failed for ${address}: ${e}`)
                    }
                    if (texture) cache.set(address, { texture, capturedAt: Date.now() })
                    finish(texture)
                }
            )

            failedId = capturer.connect(
                "frame-failed",
                (_obj: any, _reason: string) => {
                    // C side already logged via g_warning. No need to echo.
                    finish(null)
                }
            )

            safetyId = setTimeout(() => {
                log.error(`safety timeout for ${address} — wayland event loop stalled?`)
                finish(null)
            }, SAFETY_TIMEOUT_MS)

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

// ─── Proactive capture: resize end ────────────────────────────────────────────
// Hyprland emits no IPC event for window resizes, so sizes are polled over the
// raw socket (no process spawn, sub-ms round trip). A size that changed and
// then held still for one tick means the resize is done → recapture. Covers
// interactive resizes, resizeactive, and tiling reflows alike.
const RESIZE_POLL_INTERVAL_MS = 600

const lastSizes = new Map<string, string>()
const settling = new Set<string>()

setInterval(() => {
    hyprland.message_async("j/clients", (_src: any, res: any) => {
        let clients: any[]
        try {
            clients = JSON.parse(hyprland.message_finish(res))
        } catch {
            return
        }
        const seen = new Set<string>()
        for (const c of clients) {
            // Astal strips the 0x prefix from addresses; cache keys follow it
            const addr = String(c.address ?? "").replace("0x", "")
            if (!addr || !c.mapped) continue
            seen.add(addr)
            const size = `${c.size?.[0]}x${c.size?.[1]}`
            const prev = lastSizes.get(addr)
            lastSizes.set(addr, size)
            if (prev === undefined) continue
            if (size !== prev) {
                settling.add(addr)
            } else if (settling.has(addr)) {
                settling.delete(addr)
                captureNow(addr)
            }
        }
        for (const addr of [...lastSizes.keys()]) {
            if (!seen.has(addr)) {
                lastSizes.delete(addr)
                settling.delete(addr)
            }
        }
    })
}, RESIZE_POLL_INTERVAL_MS)

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
// Latest cached snapshot, if any — synchronous, never triggers a capture.
export function getCachedTexture(address: string): Gdk.Texture | null {
    return cache.get(address)?.texture ?? null
}

// Freshest known window size (logical px), from the 600ms resize poll.
// Preview sizing uses this rather than Astal client geometry (stale after
// resizes) or capture pixel sizes (wrong for windows hanging off a
// workspace edge, whose captures come back clipped).
export function freshClientSize(address: string): [number, number] | null {
    const s = lastSizes.get(address)
    if (!s) return null
    const [w, h] = s.split("x").map(Number)
    return Number.isFinite(w) && Number.isFinite(h) && h > 0 ? [w, h] : null
}

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
