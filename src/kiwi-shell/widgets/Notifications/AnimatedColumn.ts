import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"

// A vertical list that animates its own layout. Every entry is placed by a
// translate transform computed from time-based tweens, driven by one tick
// callback that removes itself once everything settled. Nothing depends on
// CSS transitions, revealers or timeouts, so an animation can't fail to
// start, replay on a remap or leave a widget stuck halfway.
//
// Entries slide in from the right edge and out to it; the gap an entry
// leaves closes while it flies out. Entries marked foldInto unfold from
// behind (and fold back under) the entry with that key, like a group
// expanding from its head card.

const ENTER_MS = 420
const EXIT_MS = 240
const MOVE_MS = 340
const FOLD_MS = 300
// the gap starts closing this long after an entry starts flying out
const EXIT_RELEASE_MS = 90

type Ease = (t: number) => number
const easeOutQuint: Ease = t => 1 - Math.pow(1 - t, 5)
const easeOutCubic: Ease = t => 1 - Math.pow(1 - t, 3)
const easeInCubic: Ease = t => t * t * t

class Tween {
    value = 0
    private from = 0
    target = 0
    private start = -1
    private delay = 0
    private duration = 0
    private ease: Ease = easeOutCubic
    running = false

    jump(value: number) {
        this.value = this.from = this.target = value
        this.running = false
    }

    to(target: number, ms: number, ease: Ease, delayMs = 0) {
        if (this.running && this.target === target) return
        if (!this.running && this.value === target) return
        this.from = this.value
        this.target = target
        this.duration = ms * 1000
        this.delay = delayMs * 1000
        this.ease = ease
        // the clock starts on the first tick, so an animation queued while
        // the window is still mapping plays in full
        this.start = -1
        this.running = true
    }

    // advances to frame time `now` (µs); true when the value changed
    step(now: number): boolean {
        if (!this.running) return false
        if (this.start < 0) this.start = now
        const t = (now - this.start - this.delay) / this.duration
        if (t <= 0) return false
        if (t >= 1) {
            this.value = this.target
            this.running = false
        } else {
            this.value = this.from + (this.target - this.from) * this.ease(t)
        }
        return true
    }
}

export interface ColumnEntry {
    key: string
    // unfolds from behind / folds back under the entry with this key
    foldInto?: string
}

export interface ColumnFactory<E extends ColumnEntry> {
    create(entry: E): Gtk.Widget
    update(widget: Gtk.Widget, entry: E): void
    // called once the widget left the column for good
    dispose(widget: Gtk.Widget): void
}

interface Item<E extends ColumnEntry> {
    key: string
    entry: E
    widget: Gtk.Widget
    x: Tween
    y: Tween
    opacity: Tween
    height: number
    placed: boolean
    exiting: boolean
    // still occupies its slot (the gap hasn't started closing yet)
    holdsSlot: boolean
    releaseAt: number
    // folds behind another entry: drawn below the others while moving
    foldKey: string | null
}

export interface SyncOptions {
    // delay between consecutive entering entries
    staggerMs?: number
    // exiting key → key of the entry it now hides behind
    foldsInto?: ReadonlyMap<string, string>
    // jump straight to the final layout
    instant?: boolean
}

export const AnimatedColumn = GObject.registerClass(
    { GTypeName: "KiwiAnimatedColumn" },
    class AnimatedColumn extends Gtk.Widget {
        private items: Item<any>[] = []
        private factory: ColumnFactory<any> | null = null
        private tickId = 0
        private spacing = 0
        private busy = false
        onBusyChanged: ((busy: boolean) => void) | null = null
        onLayout: (() => void) | null = null

        setup<E extends ColumnEntry>(factory: ColumnFactory<E>, spacing: number) {
            this.factory = factory
            this.spacing = spacing
        }

        // settled, non-exiting entry widgets (input regions, hit tests)
        restingWidgets(): Gtk.Widget[] {
            return this.items.filter(i => !i.exiting).map(i => i.widget)
        }

        sync<E extends ColumnEntry>(entries: readonly E[], options: SyncOptions = {}) {
            const factory = this.factory!
            const previous = this.items
            const byKey = new Map(previous.map(i => [i.key, i]))
            const next: Item<E>[] = []
            const isNew = new Set<Item<E>>()

            for (const entry of entries) {
                let item = byKey.get(entry.key) as Item<E> | undefined
                if (item) {
                    byKey.delete(entry.key)
                    item.entry = entry
                    factory.update(item.widget, entry)
                    if (item.exiting) this.revive(item)
                } else {
                    const widget = factory.create(entry)
                    widget.set_parent(this)
                    item = {
                        key: entry.key, entry, widget,
                        x: new Tween(), y: new Tween(), opacity: new Tween(),
                        height: 0, placed: false, exiting: false,
                        holdsSlot: false, releaseAt: -1, foldKey: null,
                    }
                    isNew.add(item)
                }
                next.push(item)
            }

            // entering entries: unfold under an entry that was already there,
            // otherwise slide in from the right
            let enterIndex = 0
            for (const item of next) {
                if (!isNew.has(item)) continue
                const anchor = item.entry.foldInto
                if (options.instant) {
                    item.x.jump(0)
                    item.opacity.jump(1)
                } else if (anchor && previous.some(p => p.key === anchor && !p.exiting)) {
                    item.foldKey = anchor
                    item.x.jump(0)
                    item.opacity.jump(0)
                    item.opacity.to(1, FOLD_MS, easeOutCubic)
                } else {
                    const delay = Math.min(enterIndex, 8) * (options.staggerMs ?? 0)
                    item.x.jump(this.slideDistance())
                    item.opacity.jump(0)
                    item.x.to(0, ENTER_MS, easeOutQuint, delay)
                    item.opacity.to(1, ENTER_MS * 0.6, easeOutCubic, delay)
                    enterIndex++
                }
                item.widget.set_opacity(item.opacity.value)
            }

            // leftovers exit, keeping their place after their old predecessor
            const lookup = (key: string) =>
                next.find(i => i.key === key) ?? previous.find(i => i.key === key)
            for (let i = 0; i < previous.length; i++) {
                const item = previous[i]
                if (!byKey.has(item.key)) continue
                if (!item.exiting) {
                    const foldKey = options.foldsInto?.get(item.key)
                    const anchor = foldKey ? lookup(foldKey) : undefined
                    this.beginExit(item, anchor?.placed ? anchor : undefined, !!options.instant)
                }
                let at = 0
                for (let j = i - 1; j >= 0; j--) {
                    const k = next.indexOf(previous[j])
                    if (k >= 0) { at = k + 1; break }
                }
                next.splice(at, 0, item)
            }

            this.items = next
            // sibling order drives picking; keep it in list order
            let prev: Gtk.Widget | null = null
            for (const item of next) {
                if (item.widget.get_prev_sibling() !== prev) item.widget.insert_after(this, prev)
                prev = item.widget
            }

            if (options.instant) this.finishExits()
            this.queue_resize()
            this.ensureTicking()
            this.updateBusy()
        }

        private slideDistance(): number {
            return Math.max(this.get_width(), 360) + 40
        }

        private revive(item: Item<any>) {
            item.exiting = false
            item.holdsSlot = false
            item.foldKey = null
            item.x.to(0, ENTER_MS, easeOutQuint)
            item.opacity.to(1, ENTER_MS * 0.6, easeOutCubic)
        }

        private beginExit(item: Item<any>, anchor: Item<any> | undefined, instant: boolean) {
            item.exiting = true
            if (instant) return
            if (anchor) {
                item.foldKey = anchor.key
                item.holdsSlot = false
                item.y.to(anchor.y.target, FOLD_MS, easeOutCubic)
                item.opacity.to(0, FOLD_MS * 0.8, easeOutCubic)
            } else {
                item.holdsSlot = true
                item.releaseAt = -1
                item.x.to(this.slideDistance(), EXIT_MS, easeInCubic)
                item.opacity.to(0, EXIT_MS, easeInCubic)
            }
        }

        private finishExits() {
            for (const item of this.items.filter(i => i.exiting)) this.removeItem(item)
        }

        private removeItem(item: Item<any>) {
            this.items = this.items.filter(i => i !== item)
            item.widget.unparent()
            this.factory?.dispose(item.widget)
        }

        private updateBusy() {
            const busy = this.items.length > 0 || this.tickId !== 0
            if (busy === this.busy) return
            this.busy = busy
            this.onBusyChanged?.(busy)
        }

        private ensureTicking() {
            if (this.tickId || this.items.length === 0) return
            this.tickId = this.add_tick_callback((_self, clock) => {
                const now = clock.get_frame_time()
                let moving = false
                let relayout = false
                let resize = false
                for (const item of [...this.items]) {
                    if (item.x.step(now)) relayout = true
                    if (item.y.step(now)) relayout = true
                    if (item.opacity.step(now)) item.widget.set_opacity(item.opacity.value)
                    if (item.exiting && item.holdsSlot) {
                        if (item.releaseAt < 0) item.releaseAt = now + EXIT_RELEASE_MS * 1000
                        if (now >= item.releaseAt) {
                            item.holdsSlot = false
                            resize = true
                        }
                    }
                    if (item.exiting && !item.x.running && !item.y.running && !item.opacity.running) {
                        this.removeItem(item)
                        resize = true
                        continue
                    }
                    if (item.x.running || item.y.running || item.opacity.running || item.holdsSlot) moving = true
                    if (item.foldKey && !item.exiting && !item.opacity.running && !item.y.running) {
                        item.foldKey = null
                        this.queue_draw()
                    }
                }
                if (resize) this.queue_resize()
                else if (relayout) this.queue_allocate()
                if (!moving) {
                    this.tickId = 0
                    this.updateBusy()
                    return GLib.SOURCE_REMOVE
                }
                return GLib.SOURCE_CONTINUE
            })
        }

        vfunc_get_request_mode(): Gtk.SizeRequestMode {
            return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH
        }

        vfunc_measure(orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
            if (orientation === Gtk.Orientation.HORIZONTAL) {
                let min = 0
                let nat = 0
                for (const item of this.items) {
                    const [m, n] = item.widget.measure(orientation, -1)
                    min = Math.max(min, m)
                    nat = Math.max(nat, n)
                }
                return [min, nat, -1, -1]
            }
            let height = 0
            let count = 0
            for (const item of this.items) {
                if (item.exiting && !item.holdsSlot) continue
                const [, n] = item.widget.measure(orientation, forSize)
                height += n
                count++
            }
            height += Math.max(0, count - 1) * this.spacing
            return [height, height, -1, -1]
        }

        vfunc_size_allocate(width: number, _height: number, _baseline: number) {
            let y = 0
            let animating = false
            for (const item of this.items) {
                const [, h] = item.widget.measure(Gtk.Orientation.VERTICAL, width)
                item.height = h
                if (item.exiting && !item.holdsSlot) continue
                if (!item.placed) {
                    const anchor = item.foldKey ? this.items.find(i => i.key === item.foldKey) : undefined
                    item.y.jump(anchor ? anchor.y.value : y)
                    if (anchor) item.y.to(y, FOLD_MS, easeOutCubic)
                    item.placed = true
                } else if (item.y.target !== y) {
                    item.y.to(y, MOVE_MS, easeOutCubic)
                }
                if (item.y.running) animating = true
                y += h + this.spacing
            }
            for (const item of this.items) {
                const point = new Graphene.Point({ x: item.x.value, y: item.y.value })
                item.widget.allocate(width, item.height, -1, Gsk.Transform.new().translate(point))
            }
            if (animating) this.ensureTicking()
            this.onLayout?.()
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot) {
            // entries folding behind their head go underneath; entries sliding
            // in go on top of the ones moving aside to make room for them
            const layer = (item: Item<any>) =>
                item.foldKey ? 0 : !item.exiting && item.x.running ? 2 : 1
            for (const z of [0, 1, 2]) {
                for (const item of this.items) {
                    if (layer(item) === z) this.snapshot_child(item.widget, snapshot)
                }
            }
        }

        vfunc_dispose() {
            if (this.tickId) {
                this.remove_tick_callback(this.tickId)
                this.tickId = 0
            }
            for (const item of this.items) {
                item.widget.unparent()
                this.factory?.dispose(item.widget)
            }
            this.items = []
            super.vfunc_dispose()
        }
    },
)

export type AnimatedColumn = InstanceType<typeof AnimatedColumn>
