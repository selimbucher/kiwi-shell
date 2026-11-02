import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"
import Pango from "gi://Pango"

// ─── Drawn on the GPU ─────────────────────────────────────────────────────────
// The rings, the month and the clock faces, drawn into GTK's own render
// tree: paths and text as GTK draws its own. With cairo they were painted on
// the CPU and uploaded again at every opening of Notification Center, which
// took as long as everything else in it together.

export type Paint = (canvas: Canvas, snapshot: Gtk.Snapshot, width: number, height: number) => void

export const Canvas = GObject.registerClass(
    { GTypeName: "KiwiWidgetCanvas" },
    class Canvas extends Gtk.Widget {
        paint: Paint | null = null
        wide = 0
        tall = 0

        vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
            const size = orientation === Gtk.Orientation.HORIZONTAL ? this.wide : this.tall
            return [size, size, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot) {
            this.paint?.(this, snapshot, this.get_width(), this.get_height())
        }
    },
)
export type Canvas = InstanceType<typeof Canvas>

/** A canvas asking for `width` by `height` (0: as little as it's given). */
export function canvas(width: number, height: number, paint: Paint, props: Partial<Gtk.Widget.ConstructorProps> = {}): Canvas {
    const c = new Canvas(props)
    c.wide = width
    c.tall = height
    c.paint = paint
    return c
}

export const rgba = (r: number, g: number, b: number, a = 1) => new Gdk.RGBA({ red: r, green: g, blue: b, alpha: a })
const point = (x: number, y: number) => new Graphene.Point({ x, y })

export function circle(snapshot: Gtk.Snapshot, x: number, y: number, r: number, color: Gdk.RGBA) {
    const builder = new Gsk.PathBuilder()
    builder.add_circle(point(x, y), r)
    snapshot.append_fill(builder.to_path(), Gsk.FillRule.WINDING, color)
}

function stroke(width: number) {
    const s = new Gsk.Stroke(width)
    s.set_line_cap(Gsk.LineCap.ROUND)
    s.set_line_join(Gsk.LineJoin.ROUND)
    return s
}

/** A ring's arc from the top, clockwise, `turn` of the way round. */
export function arc(snapshot: Gtk.Snapshot, x: number, y: number, r: number, turn: number, width: number, color: Gdk.RGBA) {
    if (turn <= 0) return
    const builder = new Gsk.PathBuilder()
    if (turn >= 0.9999) builder.add_circle(point(x, y), r)
    else {
        const end = turn * 2 * Math.PI - Math.PI / 2
        builder.move_to(x, y - r)
        builder.svg_arc_to(r, r, 0, turn > 0.5, true, x + Math.cos(end) * r, y + Math.sin(end) * r)
    }
    snapshot.append_stroke(builder.to_path(), stroke(width), color)
}

export function line(snapshot: Gtk.Snapshot, points: [number, number][], width: number, color: Gdk.RGBA) {
    if (points.length < 2) return
    const builder = new Gsk.PathBuilder()
    builder.move_to(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) builder.line_to(x, y)
    snapshot.append_stroke(builder.to_path(), stroke(width), color)
}

export function polygon(snapshot: Gtk.Snapshot, points: [number, number][], color: Gdk.RGBA) {
    if (points.length < 3) return
    const builder = new Gsk.PathBuilder()
    builder.move_to(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) builder.line_to(x, y)
    builder.close()
    snapshot.append_fill(builder.to_path(), Gsk.FillRule.WINDING, color)
}

/** Text centred on (x, y), in the widget's font at `px` and `weight`. */
export function text(widget: Gtk.Widget, snapshot: Gtk.Snapshot, label: string, x: number, y: number,
    px: number, weight: number, color: Gdk.RGBA) {
    const layout = widget.create_pango_layout(label)
    const font = widget.get_pango_context().get_font_description()!.copy()!
    font.set_absolute_size(px * Pango.SCALE)
    font.set_weight(weight)
    layout.set_font_description(font)
    const [ink] = layout.get_pixel_extents()
    snapshot.save()
    snapshot.translate(point(Math.round(x - ink!.width / 2 - ink!.x), Math.round(y - ink!.height / 2 - ink!.y)))
    snapshot.append_layout(layout, color)
    snapshot.restore()
}
