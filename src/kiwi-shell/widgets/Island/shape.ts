import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"

import { Spring, Tween, cubicBezier, easeOutCubic, type SpringParams, type Timing } from "../MissionControl/motion"

// ─── How the island moves ─────────────────────────────────────────────────────
// iOS's Dynamic Island never jumps: it is one shape that springs from size to
// size, a little past and back, while what it holds fades out and in. Apple
// gives no numbers; its bouncy spring (SwiftUI's .bouncy) is a response of
// 0.5 s with a bounce of 0.3, and the island looks a touch calmer than that.
// A response r and bounce b make ω = 2π/r and a damping ratio of 1 − b:
//
//   the island's size      r 0.5 s, b 0.25 — ω 12.6/s, ζ 0.75
//   a bubble coming out    r 0.45 s, b 0.3
//   the card opening       r 0.5 s, b 0.15

function spring(response: number, bounce: number, rest = 0.05): SpringParams {
    const omega = (2 * Math.PI) / response
    return { stiffness: omega * omega, damping: 2 * (1 - bounce) * omega, rest }
}

export const ISLAND_SPRING = spring(0.5, 0.25)
export const BUBBLE_SPRING = spring(0.45, 0.3, 0.002)
export const CARD_SPRING = spring(0.5, 0.15, 0.002)
// the most the pill follows in one frame rather than springing to: a mark
// growing on its transition moves about 2 px a frame at its fastest
const KEEP_UP = 4

// What the island holds comes and goes as iOS's does (SwiftUI's
// blurReplace): out of a blur, a little small, into focus; and back into a
// blur as the shape closes over it. Out takes as long as the shape takes to
// close most of the way, evenly, so that it is still there to be closed over
// rather than gone in the first frames.
export const FADE_IN: Timing = { ms: 280, curve: easeOutCubic }
export const FADE_OUT: Timing = { ms: 260, curve: cubicBezier(0.4, 0, 0.6, 1) }
// how blurred, and how small, it is at nothing
const BLUR = 6
const SMALL = 0.82
// the pill itself fading once it has closed to a dot (an island left empty)
const PILL_OUT: Timing = { ms: 320, curve: cubicBezier(0.6, 0, 0.9, 0.6) }

const at = (x: number, y: number) => new Graphene.Point().init(x, y)

// what to do once a widget is done with: its reactive scope ended (gnim's
// createRoot), when it was built in one
const disposers = new WeakMap<Gtk.Widget, () => void>()

export function whenDone(widget: Gtk.Widget, dispose: () => void): Gtk.Widget {
    disposers.set(widget, dispose)
    return widget
}

function done(widget: Gtk.Widget) {
    widget.unparent()
    disposers.get(widget)?.()
    disposers.delete(widget)
}

/** Steps springs and tweens on a widget's frame clock, only while they move. */
class Ticker {
    private id = 0
    constructor(private readonly widget: Gtk.Widget, private readonly frame: (now: number) => boolean) {}

    start() {
        if (this.id) return
        this.id = this.widget.add_tick_callback((_w, clock) => {
            if (this.frame(clock.get_frame_time())) return GLib.SOURCE_CONTINUE
            this.id = 0
            return GLib.SOURCE_REMOVE
        })
    }

    stop() {
        if (this.id) this.widget.remove_tick_callback(this.id)
        this.id = 0
    }
}

// ─── The island's shape ───────────────────────────────────────────────────────

/**
 * The pill (its CSS draws it): as wide as what it holds wants, getting there
 * on a spring. What it holds keeps its own width, centred, and is cut off
 * by the pill's rounded edge, so it comes into view as the pill opens round
 * it — with the centre staying put, as on iOS around the camera.
 */
export const IslandShape = GObject.registerClass(
    { GTypeName: "KiwiIslandShape" },
    class IslandShape extends Gtk.Widget {
        private readonly width = new Spring(0, ISLAND_SPRING)
        private readonly fade = new Tween(1)
        private settled = false
        // shown, or on its way out: the pill closes to a dot and fades
        private wanted = true
        private _ticker: Ticker | null = null

        // made on first use: GJS sets a class's fields after _init has run
        private get ticker(): Ticker {
            return this._ticker ??= new Ticker(this, now => {
                const moved = [this.width.step(now), this.fade.step(now), this.residual.step(now)].some(Boolean)
                // back at the size it had when the anchor was set (the
                // controls gone again): centred from now on, or whatever
                // changes later (a desktop added) would grow it one way only.
                // Only once it has been away: this frame comes before the
                // layout that gives it somewhere to go.
                if (this._anchor !== 0.5 && this.away && !this.width.running && Math.abs(this.shownWidth - this.base) < 1) this._anchor = 0.5
                this.set_opacity(this.fade.value)
                if (!this.wanted && !this.fade.running) this.set_visible(false)
                this.queue_resize()
                return moved || this.width.running || this.fade.running || this.residual.running
            })
        }

        get child(): Gtk.Widget | null {
            return this.get_first_child()
        }

        set child(widget: Gtk.Widget | null) {
            this.get_first_child()?.unparent()
            widget?.set_parent(this)
        }

        /** Shown or not, at once (before it is first on screen). */
        set shownNow(on: boolean) {
            this.wanted = on
            this.fade.jump(on ? 1 : 0)
            this.set_opacity(on ? 1 : 0)
            this.set_visible(on)
        }

        /** In and out with the pill's motion, rather than at once. */
        reveal(on: boolean) {
            if (on === this.wanted && (on ? this.get_visible() : true)) return
            this.wanted = on
            if (on) {
                // out of a dot as wide as it is high, centred
                const [, height] = this.naturalHeight()
                this._anchor = 0.5
                this.residual.jump(0)
                this.width.jump(height)
                this.fade.jump(0)
                this.fade.to(1, FADE_IN)
                this.set_visible(true)
            } else {
                // what it held blurs away as it closes; the dot it closes to
                // goes last
                this.fade.to(0, PILL_OUT)
            }
            this.ticker.start()
            this.queue_resize()
        }

        private naturalWidth(): number {
            const child = this.child
            if (!child || !this.wanted) return this.naturalHeight()[1]
            return child.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
        }

        private naturalHeight(): [number, number] {
            const child = this.child
            if (!child) return [0, 0]
            const [min, nat] = child.measure(Gtk.Orientation.VERTICAL, -1)
            return [min, nat]
        }

        vfunc_measure(orientation: Gtk.Orientation, _forSize: number): [number, number, number, number] {
            if (orientation === Gtk.Orientation.VERTICAL) {
                const [min, nat] = this.naturalHeight()
                return [min, nat, -1, -1]
            }
            const target = this.naturalWidth()
            // the first time it is laid out it starts where it is going
            if (!this.settled || !this.get_mapped()) {
                if (!this.width.running) this.width.jump(target)
                this.settled = this.get_mapped()
            } else if (target !== this.width.target) {
                // Something inside growing on its own, a few pixels a frame (a
                // desktop's mark): the pill keeps up with it. Chasing it on its
                // spring, it fell behind and what it holds ran past its edges.
                if (!this.width.running && Math.abs(target - this.width.target) <= KEEP_UP) this.width.jump(target)
                else {
                    this.width.to(target)
                    this.ticker.start()
                }
            }
            if (this._anchor !== 0.5 && Math.abs(this.width.target - this.base) >= 1) this.away = true
            const width = Math.max(0, Math.round(this.width.value))
            this.shownWidth = width
            return [width, width, -1, -1]
        }

        /**
         * Which end stays put while the pill grows or shrinks to a new size: 0
         * the leading end, 1 the trailing end, 0.5 neither (it stays centred).
         * With only the trailing side changing (Now Playing's controls coming
         * as it's pointed at), the pill grows away from its leading end and
         * everything else stays where it was, under the pointer too; it
         * centres again as it goes back to the size it had.
         */
        get anchor(): number {
            return this._anchor
        }

        set anchor(anchor: number) {
            if (anchor === this._anchor) return
            // where it was off centre, now let go of gently
            this.residual.jump(this.shift)
            this.residual.to(0)
            this._anchor = anchor
            this.base = this.width.value
            this.away = false
            this.ticker.start()
        }

        /** How far right of centre the pill is laid out (Island.tsx, the row). */
        get shift(): number {
            return (this.shownWidth - this.base) * (0.5 - this._anchor) + this.residual.value
        }

        private _anchor = 0.5
        // its width when the anchor was set, and whether it has been
        // another since
        private base = 0
        private away = false
        private readonly residual = new Spring(0, ISLAND_SPRING)
        private shownWidth = 0

        // What it holds is laid out on the pill as it is now (IslandBody), so
        // that it moves with the pill rather than ahead of it.
        vfunc_size_allocate(width: number, height: number, baseline: number): void {
            this.child?.allocate(width, height, baseline, null)
        }

        vfunc_dispose(): void {
            this._ticker?.stop()
            this.child = null
            super.vfunc_dispose()
        }
    },
)
export type IslandShape = InstanceType<typeof IslandShape>

// ─── What the pill holds ──────────────────────────────────────────────────────

/**
 * The island's insides, laid out on the pill as wide as it is now, not as it
 * will be: each side rides its own edge of the pill (the trailing one with
 * the privacy dots after it), as iOS's do, and the middle stays in the
 * pill's middle, where it is at the pill's own width. Centred as one block
 * instead, the sides went with whatever changed inside at once (the marks
 * growing, a side swapping), ahead of the pill's edges.
 *
 * A side swapping for a narrower one moves where the middle belongs; it goes
 * there on the pill's spring, from where it was.
 */
export const IslandBody = GObject.registerClass(
    { GTypeName: "KiwiIslandBody" },
    class IslandBody extends Gtk.Widget {
        private parts: { leading: Gtk.Widget; middle: Gtk.Widget; trailing: Gtk.Widget; end: Gtk.Widget } | null = null
        private readonly drift = new Spring(0, ISLAND_SPRING)
        // where the middle belongs, from the pill's middle
        private offset: number | null = null
        private _ticker: Ticker | null = null

        private get ticker(): Ticker {
            return this._ticker ??= new Ticker(this, now => {
                const moved = this.drift.step(now)
                this.queue_allocate()
                return moved || this.drift.running
            })
        }

        /** The four, in order: drawn in it, laid out as described. */
        hold(leading: Gtk.Widget, middle: Gtk.Widget, trailing: Gtk.Widget, end: Gtk.Widget) {
            for (const widget of [leading, middle, trailing, end]) widget.set_parent(this)
            this.parts = { leading, middle, trailing, end }
        }

        private static wide(widget: Gtk.Widget): number {
            return widget.get_visible() ? widget.measure(Gtk.Orientation.HORIZONTAL, -1)[1] : 0
        }

        // as wide as the four side by side; any narrower while the pill gets there
        vfunc_measure(orientation: Gtk.Orientation, _forSize: number): [number, number, number, number] {
            if (!this.parts) return [0, 0, -1, -1]
            const all = Object.values(this.parts).filter(w => w.get_visible())
            if (orientation === Gtk.Orientation.HORIZONTAL)
                return [0, all.reduce((sum, w) => sum + IslandBody.wide(w), 0), -1, -1]
            const sizes = all.map(w => w.measure(orientation, -1))
            return [Math.max(0, ...sizes.map(([min]) => min)), Math.max(0, ...sizes.map(([, nat]) => nat)), -1, -1]
        }

        vfunc_size_allocate(width: number, height: number, _baseline: number): void {
            if (!this.parts) return
            const { leading, middle, trailing, end } = this.parts
            const [l, m, t, e] = [leading, middle, trailing, end].map(IslandBody.wide)
            // where the middle is with the pill at its natural width
            const offset = (l - t - e) / 2
            if (this.offset !== null && offset !== this.offset) {
                this.drift.jump(this.drift.value + this.offset - offset)
                this.drift.to(0)
                this.ticker.start()
            }
            this.offset = offset
            // Not rounded: rounded each on its own, the parts trembled half a
            // pixel apart as the pill grew. Halves are whole pixels at scale 2.
            const put = (widget: Gtk.Widget, x: number, w: number) => {
                if (widget.get_visible()) widget.allocate(w, height, -1, new Gsk.Transform().translate(at(x, 0)))
            }
            // each side on its edge, unless that is over the middle (the pill
            // still narrower than it will be): then against the middle, past
            // the edge, where the pill's rounded edge cuts it off
            const x = width / 2 + offset + this.drift.value - m / 2
            const right = Math.max(width - e - t, x + m)
            put(leading, Math.min(0, x - l), l)
            put(middle, x, m)
            put(trailing, right, t)
            put(end, Math.max(width - e, right + t), e)
        }

        vfunc_dispose(): void {
            this._ticker?.stop()
            if (this.parts) for (const widget of Object.values(this.parts)) widget.unparent()
            this.parts = null
            super.vfunc_dispose()
        }
    },
)
export type IslandBody = InstanceType<typeof IslandBody>

// ─── A slot that cross-fades ──────────────────────────────────────────────────

export type Edge = "start" | "end" | "center"

/**
 * One thing at a time, the next fading in as the last fades out. It is as
 * wide as what it shows now; what is leaving stays where it was against the
 * slot's inner edge (towards the island's middle), fading as the pill closes
 * over it.
 */
export const Fader = GObject.registerClass(
    { GTypeName: "KiwiIslandFader" },
    class Fader extends Gtk.Widget {
        edge: Edge = "center"
        // what's leaving cut off at its own edge, rather than running on over
        // whatever comes after it (the privacy dots after the trailing side)
        clipLeaving = false
        private current: Gtk.Widget | null = null
        // how far each child is shown, 0 to 1: the current one coming in,
        // the ones leaving going out
        private readonly shown = new Map<Gtk.Widget, Tween>()
        private _ticker: Ticker | null = null

        private get ticker(): Ticker {
            return this._ticker ??= new Ticker(this, now => {
                let moving = false
                for (const [widget, tween] of this.shown) {
                    if (tween.step(now)) moving = true
                    if (widget !== this.current && !tween.running) {
                        done(widget)
                        this.shown.delete(widget)
                    }
                }
                this.queue_allocate()
                this.queue_draw()
                return moving || [...this.shown.values()].some(t => t.running)
            })
        }

        /** Show `widget` from now on; `animate` false swaps at once. */
        show(widget: Gtk.Widget | null, animate = true) {
            const old = this.current
            if (old === widget) return
            const motion = animate && this.get_mapped()
            if (old) {
                if (motion) this.shown.get(old)?.to(0, FADE_OUT)
                else {
                    done(old)
                    this.shown.delete(old)
                }
            }
            this.current = widget
            if (widget) {
                widget.set_parent(this)
                const tween = new Tween(motion ? 0 : 1)
                if (motion) tween.to(1, FADE_IN)
                this.shown.set(widget, tween)
            }
            this.ticker.start()
            this.queue_resize()
        }

        private leaving(): Gtk.Widget[] {
            return [...this.shown.keys()].filter(w => w !== this.current)
        }

        // as wide as what it shows now, and as tall as anything still on show
        vfunc_measure(orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
            let [min, nat] = this.current ? this.current.measure(orientation, forSize) : [0, 0]
            if (orientation === Gtk.Orientation.VERTICAL) {
                for (const widget of this.leaving()) {
                    const [lmin, lnat] = widget.measure(orientation, -1)
                    min = Math.max(min, lmin)
                    nat = Math.max(nat, lnat)
                }
            }
            return [min, nat, -1, -1]
        }

        // small at nothing, about its middle
        private place(widget: Gtk.Widget, w: number, h: number, x: number, y: number) {
            const t = this.shown.get(widget)?.value ?? 1
            const scale = SMALL + (1 - SMALL) * t
            const transform = new Gsk.Transform()
                .translate(at(Math.round(x) + w / 2, Math.round(y) + h / 2))
                .scale(scale, scale)
                .translate(at(-w / 2, -h / 2))
            widget.allocate(w, h, -1, transform)
        }

        vfunc_size_allocate(width: number, height: number, _baseline: number): void {
            if (this.current) {
                // measured before laid out, as GTK wants each time
                this.current.measure(Gtk.Orientation.HORIZONTAL, height)
                this.place(this.current, width, height, 0, 0)
            }
            for (const widget of this.leaving()) {
                const [, w] = widget.measure(Gtk.Orientation.HORIZONTAL, -1)
                const [h] = widget.measure(Gtk.Orientation.VERTICAL, w)
                // where it was against the slot's inner edge, towards the middle
                const x = this.edge === "start" ? width - w : this.edge === "end" ? 0 : (width - w) / 2
                const tall = Math.max(height, h)
                this.place(widget, w, tall, x, (height - tall) / 2)
            }
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            for (const [widget, tween] of this.shown) {
                const t = Math.max(0, Math.min(1, tween.value))
                if (t <= 0) continue
                const clip = this.clipLeaving && widget !== this.current
                if (clip) snapshot.push_clip(new Graphene.Rect().init(0, 0, this.get_width(), this.get_height()))
                if (t >= 1) {
                    this.snapshot_child(widget, snapshot)
                } else {
                    snapshot.push_opacity(t)
                    snapshot.push_blur((1 - t) * BLUR)
                    this.snapshot_child(widget, snapshot)
                    snapshot.pop()
                    snapshot.pop()
                }
                if (clip) snapshot.pop()
            }
        }

        vfunc_dispose(): void {
            this._ticker?.stop()
            for (const widget of this.shown.keys()) done(widget)
            this.shown.clear()
            this.current = null
            super.vfunc_dispose()
        }
    },
)
export type Fader = InstanceType<typeof Fader>

// ─── A bubble coming out of the island ────────────────────────────────────────

/**
 * A detached bubble beside the island: it comes out of the island's edge as
 * a drop pulled off it, growing from nothing to its size as the gap opens,
 * and goes back in the same way.
 */
export const Bubble = GObject.registerClass(
    { GTypeName: "KiwiIslandBubble" },
    class Bubble extends Gtk.Widget {
        // which side of the island: the gap is on the other
        side: "start" | "end" = "end"
        gap = 6
        private readonly out = new Spring(0, BUBBLE_SPRING)
        // what it shows, another activity fading in over the last
        private _slot: Fader | null = null
        private filled = false
        private _ticker: Ticker | null = null

        private get slot(): Fader {
            if (!this._slot) {
                this._slot = new Fader()
                this._slot.set_parent(this)
            }
            return this._slot
        }

        private get ticker(): Ticker {
            return this._ticker ??= new Ticker(this, now => {
                const moved = this.out.step(now)
                if (!this.out.running && this.out.target === 0 && this.filled) {
                    this.slot.show(null, false)
                    this.filled = false
                }
                this.queue_resize()
                return moved || this.out.running
            })
        }

        /** The bubble's content, or null to take it back in. */
        show(widget: Gtk.Widget | null) {
            const mapped = this.get_mapped()
            if (widget) {
                // a bubble already out changes what it shows; one coming out
                // brings it along
                this.slot.show(widget, mapped && this.filled && this.out.target === 1)
                this.filled = true
                if (!mapped) this.out.jump(1)
                else this.out.to(1)
            } else if (!mapped) {
                this.slot.show(null, false)
                this.filled = false
                this.out.jump(0)
            } else {
                this.out.to(0)
            }
            this.ticker.start()
            this.queue_resize()
        }

        /** How far out it is, 0 in the island to 1 in place. */
        get progress(): number {
            return Math.max(0, this.out.value)
        }

        vfunc_measure(orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
            if (!this.filled) return [0, 0, -1, -1]
            const [, nat] = this.slot.measure(orientation, forSize)
            if (orientation === Gtk.Orientation.VERTICAL) return [nat, nat, -1, -1]
            const width = Math.max(0, Math.round((nat + this.gap) * this.progress))
            return [width, width, -1, -1]
        }

        // an empty bubble isn't laid out, nor drawn
        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            if (this.filled && this._slot) this.snapshot_child(this._slot, snapshot)
        }

        vfunc_size_allocate(width: number, height: number, baseline: number): void {
            if (!this.filled) return
            const child = this.slot
            const [, w] = child.measure(Gtk.Orientation.HORIZONTAL, -1)
            const p = this.progress
            // grows about its island side, from a third of its size
            const scale = 0.35 + 0.65 * Math.min(1, p)
            const x = this.side === "end" ? width - w : 0
            const pivotX = this.side === "end" ? 0 : w
            const transform = new Gsk.Transform()
                .translate(at(x, 0))
                .translate(at(pivotX, height / 2))
                .scale(scale, scale)
                .translate(at(-pivotX, -height / 2))
            child.set_opacity(Math.min(1, p * 1.6))
            child.allocate(w, height, baseline, transform)
        }

        vfunc_dispose(): void {
            this._ticker?.stop()
            this._slot?.unparent()
            this._slot = null
            super.vfunc_dispose()
        }
    },
)
export type Bubble = InstanceType<typeof Bubble>

// ─── The open card ────────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; width: number; height: number }

const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
})

// the card's corners (style/island.scss, .island-card-pane), and how far
// below the window's top it hangs, as the island does
export const CARD_RADIUS = 26
const CARD_TOP = 4
// room below the card for the spring to carry it past its size
const OVERSHOOT_ROOM = 16
// How far from home a closing card hands back to what it came out of: a
// frame or two before it goes, so that for a moment both are there, rather
// than neither. Not sooner: the compositor blurs everything behind a pane
// that is there at all, so what is under the card can't show through it.
const UNCOVER_BELOW = 0.03

/**
 * iOS's expanded presentation: the island itself grows into the card, from
 * wherever it was clicked (the island, or a bubble beside it) to the card's
 * size below the bar, and shrinks back into it when it closes. The pane is
 * laid out at the shape's size on every frame, so its CSS draws it, corners
 * and all; what the card holds is laid out at the card's own size from the
 * start, cut off by the pane's rounded edge, and fades in once there is room
 * for it.
 */
export const CardMorph = GObject.registerClass(
    { GTypeName: "KiwiIslandCardMorph" },
    class CardMorph extends Gtk.Widget {
        // called once the card has shrunk back into the island
        onClosed: (() => void) | null = null
        // called once the card has drawn itself where it grows out of: only
        // then can that give way to it, or it blinks out for a frame; and
        // again (false) as it is about to be back there
        onCovering: ((on: boolean) => void) | null = null
        // called on every layout with where the card is now, in its own
        // coordinates: all of its window that takes the pointer
        onLayout: ((shape: Rect) => void) | null = null
        private frames = 0
        private handedBack = 0
        private from: Rect = { x: 0, y: 0, width: 0, height: 0 }
        private readonly grown = new Spring(0, CARD_SPRING)
        private pane: Gtk.Widget | null = null
        private content: Gtk.Widget | null = null
        private shape: Rect = { x: 0, y: 0, width: 0, height: 0 }
        // what it grew out of, live, shown while it is small (iOS's compact
        // content cross-fading with the expanded one)
        private origin: Gtk.WidgetPaintable | null = null
        private _ticker: Ticker | null = null

        private get ticker(): Ticker {
            return this._ticker ??= new Ticker(this, now => {
                const moved = this.grown.step(now)
                // the first frame is drawn by the second tick
                if (++this.frames === 2) this.onCovering?.(true)
                const closing = this.grown.target === 0
                // the last of the way, the pane fades over what it came out of
                if (closing && this.grown.value < UNCOVER_BELOW) this.onCovering?.(false)
                this.queue_allocate()
                this.queue_draw()
                // home within a percent, and handed back a frame ago: done,
                // rather than settling for half a second more
                if (closing && Math.abs(this.grown.value) < 0.01 && this.handedBack++ > 0) {
                    this.grown.jump(0)
                    this.onClosed?.()
                    return false
                }
                return moved || this.grown.running
            })
        }

        private ensurePane(): Gtk.Widget {
            if (!this.pane) {
                this.pane = new Gtk.Box({ cssClasses: ["island-card-pane"], canTarget: false })
                this.pane.set_parent(this)
            }
            return this.pane
        }

        /**
         * Grow out of `from` (window coordinates) into a card holding
         * `content`, or what it holds already.
         */
        open(from: Rect, content: Gtk.Widget | null, what: Gtk.Widget | null = null) {
            this.ensurePane()
            if (content && this.content !== content) {
                if (this.content) done(this.content)
                this.content = content
                content.set_parent(this)
            }
            // opening again while it closes carries on from where it is
            if (this.grown.target !== 0 || !this.grown.running) {
                this.from = from
                this.origin = what ? new Gtk.WidgetPaintable({ widget: what }) : null
                this.grown.jump(0)
                this.frames = 0
                this.handedBack = 0
            }
            this.grown.to(1)
            this.ticker.start()
            this.queue_resize()
        }

        /** Back into the island it came out of. */
        close() {
            this.grown.to(0)
            this.ticker.start()
        }

        /** Done: what it held is let go. */
        clear() {
            if (this.content) done(this.content)
            this.content = null
        }

        private cardSize(): [number, number] {
            if (!this.content) return [0, 0]
            const [, w] = this.content.measure(Gtk.Orientation.HORIZONTAL, -1)
            const [, h] = this.content.measure(Gtk.Orientation.VERTICAL, w)
            return [w, h]
        }

        vfunc_measure(orientation: Gtk.Orientation, _forSize: number): [number, number, number, number] {
            const [w, h] = this.cardSize()
            if (orientation === Gtk.Orientation.HORIZONTAL) return [0, w, -1, -1]
            const tall = Math.max(h, this.from.y + this.from.height) + CARD_TOP + OVERSHOOT_ROOM
            return [tall, tall, -1, -1]
        }

        vfunc_size_allocate(width: number, _height: number, baseline: number): void {
            const [w, h] = this.cardSize()
            const to: Rect = { x: Math.round((width - w) / 2), y: CARD_TOP, width: w, height: h }
            const t = this.grown.value
            this.shape = lerpRect(this.from, to, t)
            const s = this.shape
            this.pane?.allocate(Math.max(1, Math.round(s.width)), Math.max(1, Math.round(s.height)), baseline,
                new Gsk.Transform().translate(at(Math.round(s.x), Math.round(s.y))))
            if (this.content) {
                // the card's content where the card ends up, centred on the shape
                const cx = s.x + (s.width - w) / 2
                this.content.allocate(w, h, baseline, new Gsk.Transform().translate(at(Math.round(cx), Math.round(s.y))))
                this.content.set_opacity(Math.max(0, Math.min(1, (t - 0.35) / 0.45)))
            }
            this.onLayout?.(s)
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            if (this.pane) this.snapshot_child(this.pane, snapshot)
            if (!this.content) return
            const s = this.shape
            const r = Math.min(CARD_RADIUS, s.height / 2, s.width / 2)
            const corner = new Graphene.Size().init(r, r)
            const clip = new Gsk.RoundedRect().init(
                new Graphene.Rect().init(Math.round(s.x), Math.round(s.y), Math.round(s.width), Math.round(s.height)),
                corner, corner, corner, corner)
            snapshot.push_rounded_clip(clip)
            this.snapshot_child(this.content, snapshot)
            // what it came out of, at the top where it was, fading out as the
            // card grows and back in as it shrinks
            const origin = this.origin
            const shown = 1 - Math.max(0, Math.min(1, this.grown.value / 0.35))
            if (origin && shown > 0) {
                const w = origin.get_intrinsic_width(), h = origin.get_intrinsic_height()
                snapshot.push_opacity(shown)
                snapshot.save()
                snapshot.translate(at(Math.round(s.x + (s.width - w) / 2), Math.round(s.y + (this.from.height - h) / 2)))
                origin.snapshot(snapshot, w, h)
                snapshot.restore()
                snapshot.pop()
            }
            snapshot.pop()
        }

        vfunc_dispose(): void {
            this._ticker?.stop()
            this.origin = null
            if (this.content) done(this.content)
            this.pane?.unparent()
            this.content = this.pane = null
            super.vfunc_dispose()
        }
    },
)
export type CardMorph = InstanceType<typeof CardMorph>
