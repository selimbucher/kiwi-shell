import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"
import { Spring, type SpringParams } from "../MissionControl/motion"

// ─── An icon rising under the pointer ─────────────────────────────────────────
// On a spring rather than a CSS transition: a transition left mid-way starts
// its way back at full speed, so icons the pointer swept across turned around
// in one frame. The spring carries the speed it has into the new direction.

// how far, as a fraction of the icon's size (Dock.tsx: the headroom above
// the pill and the lifted shadow follow it)
export const LIFT = 0.115
export const liftFor = (icon: number) => Math.max(3, Math.round(icon * LIFT))

// critically damped, ω 34/s: there in about 150 ms. Its value is 0..1 of the lift.
const LIFT_SPRING: SpringParams = { stiffness: 34 * 34, damping: 2 * 34, rest: 0.003 }

// laid out by this rather than vfuncs of the box's own (zoom.tsx, ZoomLayout)
const LiftLayout = GObject.registerClass(
    { GTypeName: "KiwiDockLiftLayout" },
    class LiftLayout extends Gtk.BinLayout {
        vfunc_allocate(widget: Gtk.Widget, width: number, height: number, baseline: number) {
            const box = widget as LiftBox
            // (the first time it's laid out: in its button by then)
            if (!box.followed && box.get_root()) box.follow()
            const child = widget.get_first_child()
            if (!child) return
            // by the icon's own size, whatever room the box was given
            const [, icon] = child.measure(Gtk.Orientation.HORIZONTAL, -1)
            const up = box.spring.value * liftFor(icon)
            child.allocate(width, height, baseline,
                up === 0 ? null : new Gsk.Transform().translate(new Graphene.Point().init(0, -up)))
        }
    },
)

const LiftBox = GObject.registerClass(
    { GTypeName: "KiwiDockLift" },
    class LiftBox extends Gtk.Box {
        spring = new Spring(0, LIFT_SPRING)
        followed = false
        private ticking = 0

        constructor(params?: Partial<Gtk.Box.ConstructorProps>) {
            super(params)
            this.set_layout_manager(new LiftLayout())
        }

        /** Up while its button is pointed at (what :hover matches). */
        follow() {
            const button = this.get_ancestor(Gtk.Button.$gtype)
            if (!button) return
            this.followed = true
            const sync = () => this.lift((button.get_state_flags() & Gtk.StateFlags.PRELIGHT) !== 0)
            button.connect("state-flags-changed", sync)
            sync()
        }

        private lift(up: boolean) {
            const target = up ? 1 : 0
            if (!this.get_settings().gtk_enable_animations) {
                this.spring.jump(target)
                this.queue_allocate()
                return
            }
            this.spring.to(target)
            if (this.ticking || !this.spring.running) return
            this.ticking = this.add_tick_callback((_w, clock) => {
                this.spring.step(clock.get_frame_time())
                this.queue_allocate()
                if (this.spring.running) return GLib.SOURCE_CONTINUE
                this.ticking = 0
                return GLib.SOURCE_REMOVE
            })
        }
    },
)
type LiftBox = InstanceType<typeof LiftBox>

/** A dock icon, risen while the button it is in is pointed at. */
export function Lifted({ children }: { children?: JSX.Element | JSX.Element[] }) {
    const box = new LiftBox()
    const child = Array.isArray(children) ? children[0] : children
    if (child) box.append(child as Gtk.Widget)
    return box
}
