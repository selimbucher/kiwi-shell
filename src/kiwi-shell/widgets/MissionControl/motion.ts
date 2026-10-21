// ─── Motion ───────────────────────────────────────────────────────────────────
// Mission Control's animations, timed off screen recordings of macOS
// (docs/macos-differences.md has how). Every value is stepped from a frame
// clock tick (frame time in µs) and says whether it changed.

export type Curve = (t: number) => number
export type Timing = { ms: number; curve: Curve }

// CSS's cubic-bezier(x1, y1, x2, y2): how far along at time t, both 0..1
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Curve {
    const at = (a: number, b: number, u: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u
    return t => {
        if (t <= 0) return 0
        if (t >= 1) return 1
        let lo = 0, hi = 1
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2
            if (at(x1, x2, mid) < t) lo = mid
            else hi = mid
        }
        return at(y1, y2, (lo + hi) / 2)
    }
}

export const easeOutCubic: Curve = t => 1 - Math.pow(1 - t, 3)

// the windows between their places and the spread, and anything else that
// moves with them: out and home alike (as the compositor flies them,
// src/hyprland-plugin/previews.cpp)
export const FLIGHT: Timing = { ms: 240, curve: cubicBezier(0.35, 0, 0.65, 1) }
// the bar of desktops opening: its band, the desktops' pictures, the windows
// below making room
export const BAR_OPENING: Timing = { ms: 200, curve: cubicBezier(0.42, 0, 0.58, 1) }
// the desktops left closing up after one is closed
export const CLOSING_UP: Timing = { ms: 260, curve: cubicBezier(0.25, 0, 0.2, 1) }
// a desktop added with + sliding to its place, the others making room
export const ARRIVING: Timing = { ms: 950, curve: cubicBezier(0.4, 0, 0.6, 1) }
// the new desktop peeking in at the bar's end while + is pointed at
export const PEEKING: Timing = { ms: 200, curve: easeOutCubic }
// the desktops' names coming down as Mission Control opens
export const NAMES_COMING: Timing = { ms: 150, curve: easeOutCubic }

/** A value going to a target over a set time, from wherever it is now. */
export class Tween {
    value: number
    target: number
    private from: number
    private start = -1
    private timing: Timing = FLIGHT
    running = false

    constructor(value = 0) {
        this.value = this.from = this.target = value
    }

    jump(value: number) {
        this.value = this.from = this.target = value
        this.running = false
    }

    to(target: number, timing: Timing) {
        if (this.running ? this.target === target : this.value === target) return
        this.from = this.value
        this.target = target
        this.timing = timing
        // the clock starts on the next frame, so a move asked for while the
        // surface is still mapping plays in full
        this.start = -1
        this.running = true
    }

    step(now: number): boolean {
        if (!this.running) return false
        if (this.start < 0) this.start = now
        const t = (now - this.start) / (this.timing.ms * 1000)
        if (t >= 1) {
            this.value = this.target
            this.running = false
        } else {
            this.value = this.from + (this.target - this.from) * this.timing.curve(t)
        }
        return true
    }
}

/**
 * The desktops' slide (desktops.ts, DESKTOP_SPRING): mass 1, stiffness 144,
 * damping 21.6 — ω 12/s, damping ratio 0.9. Integrated rather than solved,
 * so a new target mid-slide carries on from the speed it has.
 */
export class Spring {
    value: number
    target: number
    private velocity = 0
    private last = -1
    running = false

    constructor(value = 0) {
        this.value = this.target = value
    }

    jump(value: number) {
        this.value = this.target = value
        this.velocity = 0
        this.running = false
    }

    /** Moved by `by`, target and all, carrying on as it was. */
    shift(by: number) {
        this.value += by
        this.target += by
    }

    to(target: number) {
        if (target === this.target && (this.running || this.value === target)) return
        this.target = target
        if (!this.running) this.last = -1
        this.running = true
    }

    step(now: number): boolean {
        if (!this.running) return false
        // a first frame moves as far as one frame's worth
        let left = this.last < 0 ? 1 / 60 : Math.min(0.05, (now - this.last) / 1e6)
        this.last = now
        while (left > 0) {
            const dt = Math.min(left, 1 / 240)
            const force = -144 * (this.value - this.target) - 21.6 * this.velocity
            this.velocity += force * dt
            this.value += this.velocity * dt
            left -= dt
        }
        if (Math.abs(this.value - this.target) < 5e-4 && Math.abs(this.velocity) < 5e-3) {
            this.value = this.target
            this.velocity = 0
            this.running = false
        }
        return true
    }
}

export const lerp = (from: number, to: number, t: number) => from + (to - from) * t
