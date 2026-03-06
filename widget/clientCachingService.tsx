import { Gdk } from "ags/gtk4"
import AppCapture from "gi://AppCapture?version=1.0"

// ─── Shared capturer instance ─────────────────────────────────────────────────
// One instance per process. Initialises on construction: binds Wayland globals,
// enumerates all live windows, and maps each to its 64-bit Hyprland address.
const capturer = new AppCapture.Capture()

// ─── Concurrency queue ────────────────────────────────────────────────────────
// Only one capture runs at a time. Prevents simultaneous memfd allocations
// from piling up faster than SpiderMonkey's GC can reclaim them.
let activeCapture = false
const captureQueue: Array<() => void> = []

function drainQueue() {
    if (activeCapture || captureQueue.length === 0) return
    const next = captureQueue.shift()!
    next()
}

// ─── captureWindowToTexture ───────────────────────────────────────────────────
// Pass the raw Hyprland address string from client.get_address().
// Accepts "0x564f60266bd0" or "564f60266bd0" — the C side handles both.
// Returns a GdkTexture on success, or null on failure / timeout.
export function captureWindowToTexture(address: string): Promise<Gdk.Texture | null> {
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
                    finish(texture)
                }
            )

            // Pass address as-is — C accepts both "0x..." and bare hex
            capturer.capture_by_handle(address)
        })
        drainQueue()
    })
}

// ─── buildTexture ─────────────────────────────────────────────────────────────
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
