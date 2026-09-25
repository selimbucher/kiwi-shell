import { logger } from "../../log"
const log = logger("app-capture")
import { Gdk } from "ags/gtk4"
import AppCapture from "gi://AppCapture?version=1.0"
import Hyprland from "gi://AstalHyprland"
import { isValidClient } from "../Dock/dock-state"
import { livePreviews } from "../services/previews"

// How long a cached texture is considered fresh.
// Switcher opens under this threshold → instant display, no capture fired.
// The focused window and a window whose size changed since its frame are
// captured anew regardless (captureWindowToTexture).
const STALE_MS = 60_000

// How long to wait after a new window appears before capturing it.
// Gives the window time to render its first frame.
const NEW_WINDOW_CAPTURE_DELAY_MS = 800

// Backstop in case the C library never emits either signal. C-side times out
// on its own after 1.5s (wlr-mapping race) or 2s (no frame from the
// compositor), so this should effectively never fire.
const SAFETY_TIMEOUT_MS = 5_000

// Windows open when the shell starts are captured once this long after, so
// their previews are there before they are focused. Minimized ones included:
// they only move to a special workspace and capture fine.
const STARTUP_CAPTURE_DELAY_MS = 1_500

const capturer = new AppCapture.Capture()
const hyprland = Hyprland.get_default()

// ─── Texture cache ─────────────────────────────────────────────────────────────
interface CacheEntry {
    texture: Gdk.Texture
    capturedAt: number
    // the window's size when it was captured, "WxH"
    size: string | null
}

const cache = new Map<string, CacheEntry>()

// ─── Frame size ────────────────────────────────────────────────────────────────
// A full HiDPI frame is ~20 MB and the cache holds one per window, while a
// preview shows a fraction of that. Each place that shows captures reserves
// its largest size (logical px); the C side scales frames, on the GPU where
// it can, to no less than the largest reservation at the highest monitor
// scale.
let minWidth = 0
let minHeight = 0

export function reservePreviewSize(width: number, height: number) {
    minWidth = Math.max(minWidth, width)
    minHeight = Math.max(minHeight, height)
}

function applyMinSize() {
    const scale = Math.max(1, ...hyprland.get_monitors().map(m => m.get_scale()))
    capturer.set_min_size(Math.ceil(minWidth * scale), Math.ceil(minHeight * scale))
}

// ─── Concurrency queue ─────────────────────────────────────────────────────────
// Only one capture runs at a time. The C library's signals don't say which
// window a frame belongs to, so concurrent captures couldn't be told apart.
let activeCapture = false
const captureQueue: Array<() => void> = []

function drainQueue() {
    if (activeCapture || captureQueue.length === 0) return
    captureQueue.shift()!()
}

// ─── Core capture ──────────────────────────────────────────────────────────────
// Internal — enqueues a live capture and updates the cache on success. A
// failed capture resolves to the last good frame, if there is one.
function captureNow(address: string): Promise<Gdk.Texture | null> {
    return new Promise((resolve) => {
        captureQueue.push(() => {
            // closed while queued: Hyprland never answers a capture of a
            // window that is gone, which would stall the queue until the
            // C-side timeout
            if (!hyprland.get_client(address)) {
                resolve(cache.get(address)?.texture ?? null)
                Promise.resolve().then(drainQueue)
                return
            }
            activeCapture = true
            let readyId = 0
            let failedId = 0
            let safetyId: ReturnType<typeof setTimeout> | null = null

            const finish = (result: Gdk.Texture | null) => {
                if (readyId)  { capturer.disconnect(readyId);  readyId  = 0 }
                if (failedId) { capturer.disconnect(failedId); failedId = 0 }
                if (safetyId) { clearTimeout(safetyId);        safetyId = null }
                activeCapture = false
                resolve(result ?? cache.get(address)?.texture ?? null)
                Promise.resolve().then(drainQueue)
            }

            readyId = capturer.connect(
                "frame-ready",
                (_obj: any, texture: Gdk.Texture) => {
                    cache.set(address, {
                        texture, capturedAt: Date.now(), size: sizeKey(address),
                    })
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

            applyMinSize()
            capturer.capture_by_handle(address)
        })
        drainQueue()
    })
}

// ─── Proactive capture: on focus change ────────────────────────────────────────
// Capture the window that just lost focus — it had user activity so its
// visual state is fresh. This keeps the cache warm without any polling.
let lastFocusedAddress: string | null = null

// With kiwi-previews in the compositor nothing shows a capture — the
// switchers and the dock's flyouts are drawn from the windows themselves —
// so nothing is captured ahead of time either.
hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    const newAddr = client?.get_address() ?? null

    if (lastFocusedAddress && lastFocusedAddress !== newAddr && !livePreviews())
        captureNow(lastFocusedAddress)

    lastFocusedAddress = newAddr
})

// ─── Window sizes ─────────────────────────────────────────────────────────────
// Asked of the compositor when a preview is laid out, never polled: Hyprland
// announces no resize, and Astal's client geometry goes stale after one. One
// answer serves every tile laid out in the same moment.
const SIZES_FRESH_MS = 250
let sizes = new Map<string, [number, number]>()
let sizesAt = 0

function clientSizes(): Map<string, [number, number]> {
    if (Date.now() - sizesAt < SIZES_FRESH_MS) return sizes
    try {
        const next = new Map<string, [number, number]>()
        for (const c of JSON.parse(hyprland.message("j/clients"))) {
            // Astal strips the 0x prefix from addresses; cache keys follow it
            const addr = String(c.address ?? "").replace("0x", "")
            if (addr && c.mapped && c.size?.length === 2) next.set(addr, [c.size[0], c.size[1]])
        }
        sizes = next
        sizesAt = Date.now()
    } catch {
        // IPC down: keep the last answer
    }
    return sizes
}

const sizeKey = (address: string) => {
    const size = clientSizes().get(address)
    return size ? `${size[0]}x${size[1]}` : null
}

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
        if (!knownAddresses.has(addr) && !livePreviews())
            setTimeout(() => captureNow(addr), NEW_WINDOW_CAPTURE_DELAY_MS)
    }

    knownAddresses = new Set(current.keys())
})

// ─── Proactive capture: on startup ────────────────────────────────────────────
setTimeout(() => {
    if (livePreviews()) return
    for (const client of hyprland.get_clients()) {
        if (isValidClient(client) && !cache.has(client.get_address()))
            captureNow(client.get_address())
    }
}, STARTUP_CAPTURE_DELAY_MS)

// ─── Public API ────────────────────────────────────────────────────────────────
// Latest cached snapshot, if any — synchronous, never triggers a capture.
export function getCachedTexture(address: string): Gdk.Texture | null {
    return cache.get(address)?.texture ?? null
}

// The window's size (logical px), asked of the compositor. Preview sizing
// uses this rather than Astal client geometry (stale after resizes) or
// capture pixel sizes (wrong for windows hanging off a workspace edge, whose
// captures come back clipped).
export function freshClientSize(address: string): [number, number] | null {
    const size = clientSizes().get(address)
    return size && size[1] > 0 ? size : null
}

// Returns the cached texture immediately if fresh enough.
// Falls back to a live capture for stale or missing entries.
// The AppSwitcher calls this per-window when it opens.
export function captureWindowToTexture(address: string): Promise<Gdk.Texture | null> {
    const entry = cache.get(address)

    // the focused window is the one changing under the user's hands, and a
    // resized window's frame has the wrong shape
    const fresh = entry
        && Date.now() - entry.capturedAt < STALE_MS
        && address !== hyprland.get_focused_client()?.get_address()
        && entry.size === sizeKey(address)
    if (fresh) return Promise.resolve(entry.texture)

    return captureNow(address)
}

