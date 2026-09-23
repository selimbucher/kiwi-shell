import Hyprland from "gi://AstalHyprland"
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import Gdk from "gi://Gdk?version=4.0"
import Graphene from "gi://Graphene"
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
// nothing is ever copied out. The tiles are drawn below the shell's own
// surface, so the shell cuts a hole where each one goes (PreviewHoles) and
// keeps its titles and badges on top.
//
// Without the plugin the shell captures as it always did
// (AppSwitcher/clientCachingService).

export const livePreviews = () => hasFeature("previews")

/** A tile, in logical pixels from the top-left of the shell's surface. */
export type PreviewTile = {
    address: string
    x: number
    y: number
    width: number
    height: number
}

function send(request: string, taken?: (ok: boolean) => void) {
    hyprland.message_async(request, (_source: unknown, result: any) => {
        let ok = false
        try {
            log.debug(`${request.slice(0, 120)} -> ${hyprland.message_finish(result).trim()}`)
            ok = true
        } catch (e) {
            log.error("kiwi-previews:", e as Error)
        }
        taken?.(ok)
    })
}

let showing = ""

/**
 * Draw these tiles in the surface of the layer called `namespace`.
 *
 * "live" wakes a window nobody can see so its tile keeps up with it; "still"
 * leaves it asleep and shows the last frame it drew, which is all a tile the
 * size of a thumbnail is worth.
 *
 * `taken` is called once the compositor has them, with whether it does. It
 * draws them from the shell's next frame on, so the holes cut from here open
 * in the same frame the tiles appear in them. A hole cut before the tiles
 * were sent — one left over from the last time the switcher was open — shows
 * the windows behind the switcher for a frame or two, which is what
 * `PreviewHoles.close` is for; a pane shown before, its tiles empty, which is
 * what `PreviewHoles.wait` is for.
 */
export function showPreviews(
    namespace: string,
    rounding: number,
    tiles: PreviewTile[],
    motion: "live" | "still" = "live",
    taken?: (ok: boolean) => void,
) {
    if (!livePreviews()) return
    const request = tiles.length === 0
        ? "kiwi-previews clear"
        : `kiwi-previews ${namespace} ${Math.round(rounding)} ${motion} `
            + tiles.map(t => `${t.address},${Math.round(t.x)},${Math.round(t.y)},`
                + `${Math.round(t.width)},${Math.round(t.height)}`).join(" ")
    // the tiles only move when the switcher is laid out again
    if (request === showing) {
        taken?.(true)
        return
    }
    showing = request
    send(request, taken)
}

/**
 * Run `after` once `widget`'s window has drawn a frame. A switcher shows its
 * first frame empty (PreviewHoles.wait) and only then asks for its tiles, so
 * the compositor has seen that frame before it hears of them: the next frame,
 * the one with the holes, is the one they are drawn from.
 */
export function afterNextFrame(widget: Gtk.Widget, after: () => void) {
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

export function clearPreviews() {
    if (!livePreviews() || showing === "") return
    showing = ""
    send("kiwi-previews clear")
}

// ─── The holes the previews show through ──────────────────────────────────────
// A hole is a piece of the surface with nothing in it, not even the pane's
// own glass, so what the compositor drew underneath comes through unchanged.
// GTK has no such thing as an eraser, so the pane is drawn through a mask of
// everything but the holes.

// GTK hands a widget's own size_allocate to its layout manager, and an
// override of it on a GtkBox subclass is never reached; the manager's is.
const HolesLayout = GObject.registerClass(
    {
        GTypeName: "KiwiPreviewHolesLayout",
    },
    class HolesLayout extends Gtk.BoxLayout {
        onLayout: (() => void) | null = null

        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, baseline: number): void {
            super.vfunc_allocate(widget, width, height, baseline)
            this.onLayout?.()
        }
    },
)

export const PreviewHoles = GObject.registerClass(
    {
        GTypeName: "KiwiPreviewHoles",
    },
    class PreviewHoles extends Gtk.Box {
        /** Holes in this widget's coordinates, and their corner radius. */
        holes: Graphene.Rect[] = []
        radius = 0
        /** Called after every layout, where the shell measures its tiles. */
        onLayout: (() => void) | null = null

        /** Nothing is drawn while waiting for the compositor (wait()). */
        waiting = false

        /**
         * Draw nothing until the holes are cut. The compositor draws its
         * tiles from the frame the holes are cut in, so a pane shown before
         * then shows its tiles empty for a frame or two, then filled.
         */
        wait() {
            if (this.waiting) return
            this.waiting = true
            this.queue_draw()
        }

        /** Cut these, at this radius, and redraw — the pane with them. */
        cut(holes: Graphene.Rect[], radius: number) {
            this.holes = holes
            this.radius = radius
            this.waiting = false
            this.queue_draw()
        }

        /**
         * Close them again. A switcher keeps its window and only hides it, so
         * holes left cut are still there when it is shown again — over a
         * compositor that has been told to draw nothing.
         */
        close() {
            if (this.holes.length === 0) return
            this.holes = []
            this.queue_draw()
        }

        _init(props?: Partial<Gtk.Box.ConstructorProps>) {
            // @ts-expect-error GJS constructs GObject classes through _init
            super._init(props)
            const layout = new HolesLayout({ orientation: Gtk.Orientation.VERTICAL })
            layout.onLayout = () => this.onLayout?.()
            this.set_layout_manager(layout)
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            if (this.waiting) return
            if (this.holes.length === 0) {
                super.vfunc_snapshot(snapshot)
                return
            }

            snapshot.push_mask(Gsk.MaskMode.INVERTED_ALPHA)
            const opaque = new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 1 })
            for (const hole of this.holes) {
                const rounded = new Gsk.RoundedRect()
                rounded.init_from_rect(hole, this.radius)
                snapshot.push_rounded_clip(rounded)
                snapshot.append_color(opaque, hole)
                snapshot.pop()
            }
            snapshot.pop()
            super.vfunc_snapshot(snapshot)
            snapshot.pop()
        }
    },
)
