import Hyprland from "gi://AstalHyprland"
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import Gdk from "gi://Gdk?version=4.0"
import Graphene from "gi://Graphene"
import GObject from "gi://GObject"

import { logger } from "../../log"
import { hasPlugin } from "../../hypr"

const log = logger("previews")
const hyprland = Hyprland.get_default()

// ─── Live window previews ─────────────────────────────────────────────────────
// The switcher shows what each window looks like. Asking the compositor for
// those pictures means the shell holding the permission that hands it every
// window's pixels, and a picture is a still: a playing video stands still in
// its tile.
//
// kiwi-previews (src/hyprland-previews) turns it around — the shell says
// where its tiles are, the compositor draws the windows there itself, and
// nothing is ever copied out. The tiles are drawn below the shell's own
// surface, so the shell cuts a hole where each one goes (PreviewHoles) and
// keeps its titles and badges on top.
//
// Without the plugin the shell captures as it always did
// (AppSwitcher/clientCachingService).

export const livePreviews = () => hasPlugin("kiwi-previews")

/** A tile, in logical pixels from the top-left of the shell's surface. */
export type PreviewTile = {
    address: string
    x: number
    y: number
    width: number
    height: number
}

function send(request: string) {
    hyprland.message_async(request, (_source: unknown, result: any) => {
        try {
            log.debug(`${request.slice(0, 120)} -> ${hyprland.message_finish(result).trim()}`)
        } catch (e) {
            log.error("kiwi-previews:", e as Error)
        }
    })
}

let showing = ""

/** Draw these tiles in the surface of the layer called `namespace`. */
export function showPreviews(namespace: string, rounding: number, tiles: PreviewTile[]) {
    if (!livePreviews()) return
    const request = tiles.length === 0
        ? "kiwi-previews clear"
        : `kiwi-previews ${namespace} ${Math.round(rounding)} `
            + tiles.map(t => `${t.address},${Math.round(t.x)},${Math.round(t.y)},`
                + `${Math.round(t.width)},${Math.round(t.height)}`).join(" ")
    // the tiles only move when the switcher is laid out again
    if (request === showing) return
    showing = request
    send(request)
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

        _init(props?: Partial<Gtk.Box.ConstructorProps>) {
            // @ts-expect-error GJS constructs GObject classes through _init
            super._init(props)
            const layout = new HolesLayout({ orientation: Gtk.Orientation.VERTICAL })
            layout.onLayout = () => this.onLayout?.()
            this.set_layout_manager(layout)
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
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
