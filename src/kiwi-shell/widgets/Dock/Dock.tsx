import { logger } from "../../log"
const log = logger("dock")
import app from "ags/gtk4/app"
import App from "ags/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { destroyWindow, remeasureOn } from "../monitors"
import { createState, createComputed, createBinding, onCleanup } from "ags"
import { conf } from "../config"
import { hyprland, list, unpinnedList, setDockOverlap, DOCK_HIDE_TIMEOUT, JUMP_ANIMATION_CLASS_TIMEOUT, DOCK_SLIDE_DURATION } from "./dock-state"
import { AppIcon } from "./AppIcon"
import { HomeFolderButton, TrashButton } from "./DockButtons"
import { KeyedList } from "../KeyedList"
import { themeClasses, LAYER } from "../services/theme"
import { playSound } from "../sound"
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

const clients = createBinding(hyprland, "clients")
const activeWorkspace = createBinding(hyprland, "focusedWorkspace")

const lengths = createComputed(get => [
    get(list).length,
    get(unpinnedList).length,
    get(conf).dock_home,
    get(conf).dock_trash,
    get(conf).dock_icon_size,
    get(conf).dock_margin
])

// ─── Arpeggio folder ──────────────────────────────────────────────────────────

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir

function pickRandomArpeggio(): string {
    try {
        const dir = Gio.File.new_for_path(`${ROOT}/assets/arpeggios`)
        const enumerator = dir.enumerate_children(
            "standard::name,standard::type",
            Gio.FileQueryInfoFlags.NONE,
            null
        )
        const folders: string[] = []
        let info: Gio.FileInfo | null
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                folders.push(info.get_name())
            }
        }
        enumerator.close(null)
        if (folders.length === 0) return ""
        return folders[Math.floor(Math.random() * folders.length)]
    } catch (e) {
        log.error("Failed to pick arpeggio folder:", e)
        return ""
    }
}

const arpeggioFolder = pickRandomArpeggio()

function playArpeggio(index: number) {
    if (!arpeggioFolder) return
    playSound(`arpeggios/${arpeggioFolder}/${index}.wav`)
}

// ─── Cascade animation ────────────────────────────────────────────────────────

const STAGGER_MS = 40
const CASCADE_DELAY_MS = 100
export const ICON_ANIM_MS = 700

const dockBarRoots = new Set<Gtk.Widget>()

export function cascadeDockIcons(scope?: Gtk.Widget) {
    const roots = scope ? [scope] : [...dockBarRoots]

    for (const dockBarRoot of roots) {
        const icons: Gtk.Widget[] = []

        const walk = (widget: Gtk.Widget) => {
            if (!widget.get_visible()) return
            if (widget.has_css_class("app-icon-container")) {
                icons.push(widget)
                return
            }
            let child = (widget as any).get_first_child?.()
            while (child) {
                walk(child)
                child = child.get_next_sibling?.()
            }
        }
        walk(dockBarRoot)
        if (icons.length === 0) continue

        icons.forEach(w => {
            w.remove_css_class("fade-in")
        })
        icons.forEach((w, i) => {
            const delay = i * STAGGER_MS + CASCADE_DELAY_MS
            setTimeout(() => {w.add_css_class("fade-in"); w.add_css_class("reserved")}, delay)
            // drop the one-shot animation classes once done, so later style
            // recomputations can't replay the animation on settled icons
            setTimeout(() => {
                if (!w.get_parent()) return
                w.remove_css_class("fade-in")
                w.remove_css_class("reserved")
                w.add_css_class("shown")
            }, delay + ICON_ANIM_MS)
        })
    }
}

// ─── Proportions ──────────────────────────────────────────────────────────────
// Taken off macOS's dock: a shallow band above the icons, a slightly deeper one
// below for the running dots, and corners rounded about a third of an icon.
// Icons keep a gap on top of the transparent margin their artwork carries —
// with the margin alone the row read as crammed. Every number is a fraction
// of the icon size, so changing the size in settings moves the whole pill
// with it instead of leaving the icons rattling around in a box built for
// 52px.
const DOCK = {
    padX: 0.2,
    gap: 0.12,        // between two icons, split over both sides of each
    padTop: 0.1,
    padBottom: 0.185,
    radius: 0.46,     // a third of the pill's height, the way Tahoe rounds it
    shadowY: 0.045,
    shadowBlur: 0.1,
    lift: 0.115,      // how far an icon rises under the pointer
    liftBlur: 0.1,
    bottom: 0.1,      // the pill's own gap to the screen edge
    dot: 0.077,       // running-window dots: diameter, gap, and how far below
    dotGap: 0.058,    // the icon they hang. The drop centres them in the band
    dotDrop: 0.096,   // between the artwork and the pill's bottom edge — the
                      // icon theme's own transparent margin is part of that
                      // band, which is why the drop is more than half of it.
    spacerY: 0.21,    // the hairline between groups, inset inside its gutter
    spacerX: 0.13,
}
// Full width is a taskbar, not a pill: no corners, no gap to the screen, and
// no room spent on either.
const TASKBAR = { padTop: 0.06, padBottom: 0.19 }

const px = (icon: number, fraction: number, min = 0) =>
    Math.max(min, Math.round(icon * fraction))

function dockCss(icon: number, margin: number, primary: string) {
    const shadow = (y: number, blur: number) =>
        `drop-shadow(0 ${y}px ${blur}px rgba(0, 0, 0, 0.3))`
    return `
    --primary: ${primary};
    --dock-margin: ${margin}px;
    --jumptime: ${JUMP_ANIMATION_CLASS_TIMEOUT}ms;
    --icon-size: ${icon}px;
    --dock-slide-duration: ${DOCK_SLIDE_DURATION}ms;
    --dock-slide-distance: ${icon + 68}px;
    --dock-pad-x: ${px(icon, DOCK.padX, 4)}px;
    --icon-pad-x: ${px(icon, DOCK.gap / 2, 1)}px;
    --dock-pad-top: ${px(icon, DOCK.padTop, 3)}px;
    --dock-pad-bottom: ${px(icon, DOCK.padBottom, 7)}px;
    --dock-radius: ${px(icon, DOCK.radius, 6)}px;
    --dock-bottom: ${px(icon, DOCK.bottom, 2)}px;
    --icon-shadow: ${shadow(px(icon, DOCK.shadowY, 1), px(icon, DOCK.shadowBlur, 2))};
    --icon-lift: -${px(icon, DOCK.lift, 3)}px;
    --icon-shadow-lift: ${shadow(px(icon, DOCK.lift, 3), px(icon, DOCK.liftBlur, 2))};
    --dot-size: ${px(icon, DOCK.dot, 3)}px;
    --dot-gap: ${px(icon, DOCK.dotGap, 2)}px;
    --dot-drop: ${px(icon, DOCK.dotDrop, 2)}px;
    --spacer-pad-y: ${px(icon, DOCK.spacerY, 5)}px;
    --spacer-pad-x: ${px(icon, DOCK.spacerX, 4)}px;
    --taskbar-pad-top: ${px(icon, TASKBAR.padTop, 2)}px;
    --taskbar-pad-bottom: ${px(icon, TASKBAR.padBottom, 6)}px;
    `
}

// ─── Dock ─────────────────────────────────────────────────────────────────────

// Auto-hide is built so stuck states are structurally impossible:
//
//   - SHOWING is event-driven: the edge sensor (and the dock itself) "poke"
//     the hold. A missed event means the dock shows a moment later on the
//     next motion event — never stuck hidden.
//   - STAYING SHOWN needs continuously re-proven evidence: while held, a
//     watchdog polls the real cursor position (hyprland IPC) and drops the
//     hold once the cursor has verifiably left the dock strip. No enter/
//     leave pairs, no one-shot hide timers to lose — if the evidence stops,
//     the dock hides, full stop.
//   - The INPUT REGION is a pure function of the current state, re-derived
//     on every state change and once more when the slide or the icons'
//     animation has settled, which is when the pill's bounds are final.
//
// Nothing runs on a timer while the pointer is elsewhere: the dock's only
// periodic work is the hold's watchdog, and it lives only while held.
const HOLD_TICK_MS = 100
// A window in the strip hides the dock the moment it gets there and brings
// it back the moment it leaves: the hold's grace period is for the pointer,
// not for windows. The strip is measured whenever Hyprland says a window
// moved in one step (opening, closing, floating, fullscreen, another
// workspace). It never announces a drag or a resize, and the strip is not
// polled for them. What follows a drag is announced, though: focus moves on
// to another window, or the pointer comes to the dock and leaves it again,
// and the strip is measured then too, so a hand-moved window is accounted
// for by the time the dock's answer matters.
const COVER_EVENTS = new Set([
    "changefloatingmode", "fullscreen", "movewindowv2", "activewindowv2",
])
// thin full-width band at the very bottom edge: traveling along the screen
// edge (e.g. after summoning the dock from a corner) keeps the hold alive
const EDGE_BAND_PX = 8
// how far past the pill's sides the hold reaches before "left sideways"
const SIDE_SLACK_PX = 24

export default function Dock({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const [menuOpen, setMenuOpen] = createState(false)
    // a window reaches into the dock's strip (measureCover). A state skips
    // equal values, so only a change reaches the dock.
    const [covered, setCovered] = createState(false)
    // the dead-man hold: poke() switches it on, only the watchdog switches
    // it off
    const [held, setHeld] = createState(false)
    let lastEvidence = 0 // monotonic µs of the last proof the cursor is here
    let watchdogId: number | null = null
    let selfRef: Astal.Window | null = null
    let dockBoxRef: Gtk.Widget | null = null

    // Every window's box, asked of the compositor rather than read off
    // Astal's Client objects. Astal caches a client's geometry and does not
    // refresh it when a floating window is moved or resized — the same
    // staleness that leaves `floating` without a notify signal at all
    // (Aylur/astal#437) — so a floating window dragged over the dock still
    // reported the position it was opened at, and the dock stayed up on top
    // of it. The whole auto-hide decision is these numbers; they cannot be
    // allowed to be a guess.
    const liveWindows = (): { x: number, y: number, w: number, h: number, ws: number }[] => {
        try {
            return JSON.parse(hyprland.message("j/clients"))
                .filter((c: any) => c.mapped && !c.hidden)
                .map((c: any) => ({
                    x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1],
                    ws: c.workspace?.id ?? -1,
                }))
        } catch {
            // IPC down or a reply we cannot read: nothing is known to cover
            // the strip, so the dock shows. A visible dock is the safe end.
            return []
        }
    }

    // is the cursor inside the area that keeps the dock alive? That is the
    // strip the pill occupies (its horizontal span only — leaving sideways
    // hides just like leaving upward) plus a thin band along the bottom
    // edge for travel. Asked straight from the compositor — cannot go
    // stale, cannot miss a leave event.
    const cursorInStrip = (): boolean => {
        let reply: string
        try {
            reply = hyprland.message("cursorpos")
        } catch {
            return false // IPC down → evidence lapses → dock hides
        }
        const m = reply.match(/(-?\d+),\s*(-?\d+)/)
        if (!m) return false
        const x = Number(m[1])
        const y = Number(m[2])
        const geo = gdkmonitor.get_geometry()
        if (x < geo.x || x >= geo.x + geo.width) return false
        const yFromBottom = geo.y + geo.height - y
        if (yFromBottom <= 0) return false
        if (yFromBottom <= EDGE_BAND_PX) return true
        const stripH = Math.max(selfRef?.get_height() ?? 0, 60)
        if (yFromBottom > stripH) return false
        // within dock height: only the pill's span counts (x is unaffected
        // by the slide transform, so these bounds are safe mid-animation)
        if (dockBoxRef && selfRef) {
            const [ok, bounds] = dockBoxRef.compute_bounds(selfRef)
            if (ok && bounds.get_width() > 0) {
                const x0 = geo.x + bounds.get_x() - SIDE_SLACK_PX
                const x1 = geo.x + bounds.get_x() + bounds.get_width() + SIDE_SLACK_PX
                return x >= x0 && x < x1
            }
        }
        return true // pill bounds unknown — fall back to the full strip
    }

    // Widget-local version of the test below, for pointer events on the dock
    // window itself. The window spans the whole screen width, and for the
    // first moments after a reveal its input region does too, so motion
    // arrives from well beside the pill — treating that as presence is what
    // made the dock flicker: it held the dock open, the watchdog's stricter
    // test then dropped it, and the next twitch re-opened it.
    const pointerOverPill = (x: number, y: number): boolean => {
        if (!dockBoxRef || !selfRef) return true // bounds unknown: be generous
        const [ok, bounds] = dockBoxRef.compute_bounds(selfRef)
        if (!ok || bounds.get_width() <= 0) return true
        if (y < 0 || y > selfRef.get_height()) return false
        return x >= bounds.get_x() - SIDE_SLACK_PX
            && x < bounds.get_x() + bounds.get_width() + SIDE_SLACK_PX
    }

    const pokeAt = (_c: unknown, x: number, y: number) => {
        if (pointerOverPill(x, y)) poke()
    }

    const poke = () => {
        if (conf().dock !== "auto-hide") return
        lastEvidence = GLib.get_monotonic_time()
        // a hold begins: the windows may have been moved by hand since the
        // strip was last measured
        if (watchdogId === null) measureCover()
        setHeld(true)
        if (watchdogId !== null) return
        watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_TICK_MS, () => {
            if (conf().dock !== "auto-hide") {
                watchdogId = null
                setHeld(false)
                return GLib.SOURCE_REMOVE
            }
            // an open context menu counts as presence (it usually extends
            // above the strip)
            if (cursorInStrip() || menuOpen())
                lastEvidence = GLib.get_monotonic_time()
            if (GLib.get_monotonic_time() - lastEvidence
                > DOCK_HIDE_TIMEOUT * 1000) {
                watchdogId = null
                // whether the dock hides now is the strip's answer, so ask
                // it fresh rather than trust the last event's
                measureCover()
                setHeld(false)
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    const showDock = createComputed(get => {
        const config = get(conf)
        if (get(list).length + get(unpinnedList).length == 0)
            return false

        const mode = config.dock
        if (mode == "disabled") return false
        if (mode != "auto-hide") return true
        if (get(held) || get(menuOpen)) return true
        return !get(covered)
    })

    // Only a window that actually reaches the dock's strip counts. The old
    // test was workspace membership alone, which is why a floating calculator
    // parked in a corner hid the dock as thoroughly as a maximised window did.
    const measureCover = () => {
        if (conf().dock !== "auto-hide") return
        const activeId = hyprland.get_monitors()
            .find(m => m.name === gdkmonitor.get_connector())
            ?.activeWorkspace?.id
        const geo = gdkmonitor.get_geometry()
        const stripTop = geo.y + geo.height - (selfRef?.get_height() ?? 80)
        setCovered(liveWindows().some(win =>
            win.ws === activeId
            && win.y + win.h > stripTop
            && win.x < geo.x + geo.width
            && win.x + win.w > geo.x))
    }

    // The one and only place the input region is written. Idempotent.
    // Invariant: shown ⇒ the region covers the pill. It narrows to the
    // pill's bounds (so clicks beside it fall through) ONLY once the slide
    // has settled and the bounds are sane — while sliding, or whenever the
    // bounds look off (a transform mid-animation would place the region
    // off-screen: the old "visible but unclickable" bug), the whole window
    // takes input instead. A dead dock is impossible; the cost of every
    // fallback is merely a briefly-wider click area.
    let shownAt = 0
    let lastShown = false
    const syncInputRegion = () => {
        const surface = selfRef?.get_surface()
        if (!surface) return
        const shown = showDock()
        if (shown && !lastShown) shownAt = GLib.get_monotonic_time()
        lastShown = shown

        if (!shown) {
            surface.set_input_region(new Cairo.Region())
            return
        }
        const settled = GLib.get_monotonic_time() - shownAt
            > (DOCK_SLIDE_DURATION + 150) * 1000
        if (settled && dockBoxRef && selfRef) {
            const [ok, bounds] = dockBoxRef.compute_bounds(selfRef)
            const sane = ok
                && bounds.get_width() > 0
                && bounds.get_y() >= -2
                && bounds.get_y() + bounds.get_height()
                    <= selfRef.get_height() + 2
            if (sane) {
                const rect = new Cairo.RectangleInt()
                rect.x = Math.floor(bounds.get_x())
                rect.y = Math.floor(bounds.get_y())
                rect.width = Math.ceil(bounds.get_width())
                rect.height = Math.ceil(bounds.get_height())
                const region = new Cairo.Region()
                region.unionRectangle(rect)
                surface.set_input_region(region)
                return
            }
        }
        surface.set_input_region(null)
    }

    // The pill's bounds are final only once the slide or the icons' animation
    // has run its course, so the region is written once more then.
    let settleId: number | null = null
    const syncWhenSettled = (ms: number) => {
        if (settleId !== null) GLib.source_remove(settleId)
        settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            settleId = null
            syncInputRegion()
            return GLib.SOURCE_REMOVE
        })
    }

    return [(
        <window
            namespace={LAYER.dock}
            css={createComputed(get => {
                const c = get(conf)
                return dockCss(c.dock_icon_size, c.dock_margin, c.primary_color)
            })}
            name="ags-dock"
            class={createComputed(get => {
                const c = get(conf)
                return `Dock ${get(themeClasses)}${c.dock_full_width ? " dock-full" : ""}`
            })}
            gdkmonitor={gdkmonitor}
            visible={true}
            exclusivity={conf.as(conf =>
                conf.dock === "default"
                    ? Astal.Exclusivity.EXCLUSIVE
                    : Astal.Exclusivity.NORMAL
            )}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                selfRef = self
                onCleanup(() => destroyWindow(self))
                remeasureOn(self, () => {
                    const c = conf()
                    return `${c.dock_icon_size}:${c.dock_margin}:${c.dock_full_width}`
                }, () => gdkmonitor.get_geometry().width)

                // any pointer or drag activity on the dock is presence
                // evidence — no leave handling, the watchdog notices absence
                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", pokeAt)
                motionController.connect("motion", pokeAt)
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", pokeAt)
                dragMotion.connect("motion", pokeAt)
                self.add_controller(dragMotion)

                // in auto-hide the dock reserves nothing, so anything else
                // anchored to the bottom edge lands on top of it unless it
                // is told how much room the dock is taking
                const syncOverlap = () => setDockOverlap(
                    showDock() && conf().dock !== "default"
                        ? self.get_height()
                        : 0)
                showDock.subscribe(syncOverlap)
                conf.subscribe(syncOverlap)
                self.connect("map", syncOverlap)
                onCleanup(() => setDockOverlap(0))

                // the strip, measured whenever Hyprland says a window moved
                const unsubscribeCover = [
                    conf.subscribe(measureCover),
                    clients.subscribe(measureCover),
                    activeWorkspace.subscribe(measureCover),
                ]
                const eventId = hyprland.connect("event", (_h, event: string) => {
                    if (COVER_EVENTS.has(event)) measureCover()
                })
                self.connect("map", measureCover)
                onCleanup(() => {
                    unsubscribeCover.forEach(unsubscribe => unsubscribe())
                    hyprland.disconnect(eventId)
                })

                // the region follows every state change at once, and again
                // when whatever moved the pill has come to rest: the slide
                // on a reveal (and the dock's own entrance on map), the icons
                // growing or shrinking when apps come and go
                const settleSlide = DOCK_SLIDE_DURATION + 200
                showDock.subscribe(() => {
                    syncInputRegion()
                    if (showDock()) syncWhenSettled(settleSlide)
                })
                conf.subscribe(() => {
                    syncInputRegion()
                    syncWhenSettled(settleSlide)
                })
                lengths.subscribe(() => {
                    syncInputRegion()
                    syncWhenSettled(ICON_ANIM_MS + 100)
                })
                self.connect("map", () => {
                    syncInputRegion()
                    syncWhenSettled(settleSlide)
                })
                onCleanup(() => {
                    if (settleId !== null) {
                        GLib.source_remove(settleId)
                        settleId = null
                    }
                    if (watchdogId !== null) {
                        GLib.source_remove(watchdogId)
                        watchdogId = null
                    }
                })
            }}
        >
            <DockBar
                setMenuOpen={setMenuOpen}
                showDock={showDock}
                onDockBoxReady={(widget) => { dockBoxRef = widget }}
            />
        </window>
    ), <EdgeSensor gdkmonitor={gdkmonitor} poke={poke} />]
}

// ─── EdgeSensor ───────────────────────────────────────────────────────────────

// Stateless: touching the bottom edge pokes the dock's hold, nothing else.
// It carries no timers and no state of its own, so it has nothing to get
// stuck on — hiding is entirely the watchdog's job.
function EdgeSensor({ gdkmonitor, poke }: {
    gdkmonitor: Gdk.Monitor,
    poke: () => void,
}) {
    return (
        <window
            namespace={LAYER.plain}
            name="ags-dock-sensor"
            class="edge-sensor-bottom"
            gdkmonitor={gdkmonitor}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT}
            exclusivity={Astal.Exclusivity.NORMAL}
            layer={Astal.Layer.TOP}
            application={app}
            visible={conf.as(conf => conf.dock == "auto-hide")}
            $={(self) => {
                onCleanup(() => destroyWindow(self))

                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", poke)
                motionController.connect("motion", poke)
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", poke)
                dragMotion.connect("motion", poke)
                self.add_controller(dragMotion)
            }}
        >
            <box css="min-height: 1px;" />
        </window>
    )
}

// ─── DockBar ──────────────────────────────────────────────────────────────────

function DockBar({ setMenuOpen, showDock, onDockBoxReady }: {
    setMenuOpen: (v: boolean) => void,
    showDock: ReturnType<typeof createComputed<boolean>>,
    onDockBoxReady: (widget: Gtk.Widget) => void,
}) {
    const pinnedBinding = createComputed(get => get(list))
    const unpinnedBinding = createComputed(get => get(unpinnedList))

    let prevPinnedSnapshot = new Set(list())
    pinnedBinding.subscribe(() => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            prevPinnedSnapshot = new Set(list())
            return GLib.SOURCE_REMOVE
        })
    })

    const extraOffset = createComputed(get =>
        get(list).length + get(unpinnedList).length + 1
    )

    return (
        <centerbox class="dock-bar-container">
            <box
                $type="center"
                class={createComputed(get => `dock-bar${get(showDock) ? "" : " slide-out"}`)}
                halign={conf.as(c => c.dock_full_width ? Gtk.Align.FILL : Gtk.Align.CENTER)}
                $={(self: Gtk.Widget) => {
                    dockBarRoots.add(self)
                    onCleanup(() => dockBarRoots.delete(self))
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        cascadeDockIcons(self)
                        return GLib.SOURCE_REMOVE
                    })
                }}
            >
                <box
                    $type="center"
                    class="dock-box"
                    orientation={Gtk.Orientation.HORIZONTAL}
                    hexpand={true}
                    $={(self: Gtk.Widget) => onDockBoxReady(self)}
                >
                    {/* absorbs the extra space evenly in full-width mode,
                        keeping the icons centered like the windows taskbar */}
                    <box hexpand={true} />
                    <box>
                        <KeyedList
                            each={pinnedBinding}
                            keyFn={(entry) => entry}
                            children={(entry) => {
                                const index = createComputed(get => get(list).indexOf(entry) + 1)
                                return (
                                    <AppIcon
                                        entry={entry}
                                        setMenuOpen={setMenuOpen}
                                        $={(self) => {
                                            const motion = new Gtk.EventControllerMotion()
                                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(index()))
                                            self.add_controller(motion)
                                        }}
                                    />
                                )
                            }}
                        />
                    </box>
                    <box
                        vexpand={true}
                        class="dock-spacer"
                        visible={createComputed(get =>
                            get(list).length > 0 && get(unpinnedList).length > 0
                        )}
                    />
                    <box>
                        <KeyedList
                            each={unpinnedBinding}
                            keyFn={(entry) => entry}
                            enterClass="fade-in"
                            exitClass="fade-out"
                            shouldEnter={(entry) => !prevPinnedSnapshot.has(entry)}
                            children={(entry) => {
                                const index = createComputed(get =>
                                    get(list).length + get(unpinnedList).indexOf(entry) + 1
                                )
                                return (
                                    <AppIcon
                                        entry={entry}
                                        setMenuOpen={setMenuOpen}
                                        $={(self) => {
                                            const motion = new Gtk.EventControllerMotion()
                                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(index()))
                                            self.add_controller(motion)
                                        }}
                                    />
                                )
                            }}
                            appendOnly
                        />
                    </box>
                    <box
                        vexpand={true}
                        class="dock-spacer"
                        visible={createComputed(get =>
                            (get(list).length > 0 || get(unpinnedList).length > 0) &&
                            (get(conf).dock_home == true || get(conf).dock_trash == true)
                        )}
                    />
                    <HomeFolderButton
                        setMenuOpen={setMenuOpen}
                        $={(self) => {
                            const motion = new Gtk.EventControllerMotion()
                            motion.connect("enter", () => conf().dock_arpeggio && playArpeggio(extraOffset()))
                            self.add_controller(motion)
                        }}
                    />
                    <TrashButton
                        setMenuOpen={setMenuOpen}
                        $={(self) => {
                            const motion = new Gtk.EventControllerMotion()
                            motion.connect("enter", () =>
                                conf().dock_arpeggio && playArpeggio(extraOffset() + (conf().dock_home ? 1 : 0))
                            )
                            self.add_controller(motion)
                        }}
                    />
                    <box hexpand={true} />
                </box>
            </box>
        </centerbox>
    )
}