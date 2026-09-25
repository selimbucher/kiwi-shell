import Hyprland from "gi://AstalHyprland"
import Gtk from "gi://Gtk?version=4.0"
import GObject from "gi://GObject"
import GLib from "gi://GLib"

import { logger } from "../../log"
import { hasFeature } from "../../hypr"

const log = logger("previews")
const hyprland = Hyprland.get_default()

// ─── Live window previews ─────────────────────────────────────────────────────
// The switcher shows what each window looks like. Asking the compositor for
// those pictures means the shell holding the permission that hands it every
// window's pixels, and a picture is a still: a playing video stands still in
// its tile.
//
// kiwi's plugin (src/hyprland-plugin) turns it around — the shell says
// where its tiles are, the compositor draws the windows there itself, and
// nothing is ever copied out. They are drawn over the shell's own surface,
// which keeps its titles, close buttons and selection around the pictures
// rather than on them.
//
// Without the plugin the shell captures as it always did
// (AppSwitcher/clientCachingService).

export const livePreviews = () => hasFeature("previews")

/** A rectangle in logical pixels from the top-left of the shell's surface. */
export type Rect = {
    x: number
    y: number
    width: number
    height: number
}

/**
 * A tile: the window at `address`, fitted into the rectangle and cut off at
 * `clip` if there is one.
 */
export type PreviewTile = Rect & {
    address: string
    clip?: Rect
}

// resolves whether the compositor took it: it answers errors as text too
function send(request: string, set?: string, taken?: (ok: boolean) => void) {
    hyprland.message_async(request, (_source: unknown, result: any) => {
        let ok = false
        try {
            const reply = hyprland.message_finish(result).trim()
            ok = reply.startsWith("ok")
            if (ok) log.debug(`${request.slice(0, 120)} -> ${reply}`)
            else log.warn(`${request.slice(0, 60)}… -> ${reply}`)
        } catch (e) {
            log.error("kiwi-previews:", e as Error)
        }
        // a request that didn't take must go again the next time
        if (!ok && set !== undefined && showing.get(set) === request) showing.delete(set)
        taken?.(ok)
    })
}

// what each set was last sent as
const showing = new Map<string, string>()

const numbers = (r: Rect) => [r.x, r.y, r.width, r.height].map(Math.round).join(",")

/**
 * Draw these tiles as the set called `set`, in the surface of the layer
 * called `namespace` (or in the popup it has open, with `popup`), their
 * corners rounded by `rounding`. Each part of the shell that shows previews
 * has its own set, which it clears without touching the others'.
 *
 * "live" wakes a window nobody can see so its tile keeps up with it; "still"
 * leaves it asleep and shows the last frame it drew, which is all a tile the
 * size of a thumbnail is worth.
 *
 * `taken` is called once the compositor has them, with whether it does. It
 * draws them from the shell's next frame on: the frame to show the pane in.
 */
export function showPreviews(
    set: string,
    namespace: string,
    rounding: number,
    tiles: PreviewTile[],
    options: { motion?: "live" | "still", popup?: boolean } = {},
    taken?: (ok: boolean) => void,
) {
    if (!livePreviews()) return
    const request = tiles.length === 0
        ? `kiwi-previews clear ${set}`
        : `kiwi-previews ${set} ${namespace} ${Math.round(rounding)} ${options.motion ?? "live"}${options.popup ? " popup" : ""} `
            + tiles.map(t => `${t.address},${numbers(t)}${t.clip ? `,${numbers(t.clip)}` : ""}`).join(" ")
    // the tiles only move when their surface is laid out again
    if (request === showing.get(set)) {
        taken?.(true)
        return
    }
    showing.set(set, request)
    send(request, set, taken)
}

export function clearPreviews(set: string) {
    if (!livePreviews() || !showing.has(set)) return
    showing.delete(set)
    send(`kiwi-previews clear ${set}`)
}

// Run `after` once `widget`'s window has drawn a frame.
function afterNextFrame(widget: Gtk.Widget, after: () => void) {
    const clock = widget.get_frame_clock()
    if (!clock) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            after()
            return GLib.SOURCE_REMOVE
        })
        return
    }
    const id = clock.connect("after-paint", () => {
        clock.disconnect(id)
        after()
    })
    widget.queue_draw()
}

// ─── The pane the tiles are in ────────────────────────────────────────────────

// GTK hands a widget's own size_allocate to its layout manager, and an
// override of it on a GtkBox subclass is never reached; the manager's is.
const PaneLayout = GObject.registerClass(
    {
        GTypeName: "KiwiPreviewPaneLayout",
    },
    class PaneLayout extends Gtk.BoxLayout {
        onLayout: (() => void) | null = null

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, baseline: number): void {
            super.vfunc_allocate(widget, width, height, baseline)
            this.onLayout?.()
        }
    },
)

/**
 * The box a switcher's tiles are laid out in. It tells after every layout,
 * for the tiles to be measured, and it can hold off drawing anything until
 * the compositor has them (wait, show).
 */
export const PreviewPane = GObject.registerClass(
    {
        GTypeName: "KiwiPreviewPane",
    },
    class PreviewPane extends Gtk.Box {
        /** Called after every layout, where the shell measures its tiles. */
        onLayout: (() => void) | null = null
        waiting = false

        /** Draw nothing until show(). */
        wait() {
            if (this.waiting) return
            this.waiting = true
            this.queue_draw()
        }

        show() {
            if (!this.waiting) return
            this.waiting = false
            this.queue_draw()
        }

        _init(props?: Partial<Gtk.Box.ConstructorProps>) {
            // @ts-expect-error GJS constructs GObject classes through _init
            super._init(props)
            const layout = new PaneLayout({ orientation: Gtk.Orientation.VERTICAL })
            layout.onLayout = () => this.onLayout?.()
            this.set_layout_manager(layout)
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            if (!this.waiting) super.vfunc_snapshot(snapshot)
        }
    },
)

// ─── A switcher's live tiles ──────────────────────────────────────────────────

// how long a switcher waits, at most, to show with its tiles in place
const REVEAL_ANYWAY_MS = 150

type Options = {
    // the name the tiles go by in the compositor, one per part of the shell
    set: string
    namespace: string
    // the tiles are in the popup the layer has open, not in the layer
    popup?: boolean
    motion: "live" | "still"
    // the tiles' corner radius, logical pixels
    radius: number
    // the widget a tile's picture is cut off at, if not the tile's own edges
    clipOf?: (tile: Gtk.Widget) => Gtk.Widget | null
    // the tiles' top corners meet a title bar: they are rounded out of sight,
    // above the tile, so only the bottom ones show
    squareTop?: boolean
}

/**
 * What a switcher does to have the compositor draw its tiles: it registers
 * each tile's widget by window address, and says when it is shown and hidden.
 *
 * On showing, nothing is drawn until the compositor has the tiles, and then
 * the pane and the windows in it appear in the same frame. The switcher first
 * draws one empty frame, then sends its tiles, and on the reply shows the
 * pane: the compositor draws them from the frame after the request, which is
 * that one. A switcher with no tiles, or whose tiles never get laid out, is
 * shown without them.
 */
export class LiveTiles {
    readonly tiles = new Map<string, Gtk.Widget>()
    // the surface the tiles are measured on: a window, or a popover
    window: (Gtk.Widget & Gtk.Native) | null = null
    pane: InstanceType<typeof PreviewPane> | null = null
    // so a measurement that has been overtaken doesn't show the pane
    private generation = 0
    // false from showing until the switcher's first, empty frame is drawn
    private firstFrameDrawn = true

    constructor(private readonly options: Options) {}

    shown() {
        if (!livePreviews()) return
        this.pane?.wait()
        const shown = this.generation
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_ANYWAY_MS, () => {
            if (this.generation === shown) this.pane?.show()
            return GLib.SOURCE_REMOVE
        })
        this.firstFrameDrawn = false
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this.window) return GLib.SOURCE_REMOVE
            afterNextFrame(this.window, () => {
                this.firstFrameDrawn = true
                this.measure()
                if (this.tiles.size === 0) this.pane?.show()
            })
            return GLib.SOURCE_REMOVE
        })
    }

    hidden() {
        clearPreviews(this.options.set)
        ++this.generation
    }

    /** Measure the tiles and send them; after every layout. */
    measure() {
        const { window, pane } = this
        if (!livePreviews() || !window || !pane) return
        // the compositor must see the empty frame before it hears of the tiles
        if (pane.waiting && !this.firstFrameDrawn) return

        // widget coordinates start inside the window's padding; the compositor
        // counts from the surface
        const [dx, dy] = window.get_surface_transform()
        const onSurface = (widget: Gtk.Widget): Rect | null => {
            const [ok, bounds] = widget.compute_bounds(window)
            if (!ok || bounds.get_width() < 1 || bounds.get_height() < 1) return null
            return { x: bounds.get_x() + dx, y: bounds.get_y() + dy, width: bounds.get_width(), height: bounds.get_height() }
        }

        const { radius, clipOf, squareTop } = this.options
        const tiles: PreviewTile[] = []
        for (const [address, widget] of this.tiles) {
            if (!widget.get_mapped()) continue
            const rect = onSurface(widget)
            if (!rect) continue
            const clipWidget = clipOf?.(widget)
            const clip = clipWidget ? onSurface(clipWidget) ?? undefined : undefined
            tiles.push(squareTop
                ? { address, ...rect, y: rect.y - radius, height: rect.height + radius, clip: clip ?? rect }
                : { address, ...rect, clip })
        }
        // a first layout can come before the tiles are on screen; showing the
        // pane on it would show them empty until the next
        if (pane.waiting && tiles.length === 0 && this.tiles.size > 0) return

        const measured = ++this.generation
        const { set, namespace, motion, popup } = this.options
        showPreviews(set, namespace, radius, tiles, { motion, popup }, () => {
            if (measured === this.generation) this.pane?.show()
        })
    }
}
