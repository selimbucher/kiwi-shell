import { logger } from "../../log"
const log = logger("dock")
import app from "ags/gtk4/app"
import App from "ags/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { destroyWindow } from "../monitors"
import { createState, createComputed, createBinding, onCleanup } from "ags"
import { conf } from "../config"
import { hyprland, list, unpinnedList, DOCK_HIDE_TIMEOUT, JUMP_ANIMATION_CLASS_TIMEOUT, DOCK_SLIDE_DURATION } from "./dock-state"
import { AppIcon } from "./AppIcon"
import { HomeFolderButton, TrashButton } from "./DockButtons"
import { KeyedList } from "../KeyedList"
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
//     both on every state change and by a slow reconciler tick, so a stale
//     region can never outlive half a second.
const HOLD_TICK_MS = 100
const RECONCILE_TICK_MS = 500
// thin full-width band at the very bottom edge: traveling along the screen
// edge (e.g. after summoning the dock from a corner) keeps the hold alive
const EDGE_BAND_PX = 8
// how far past the pill's sides the hold reaches before "left sideways"
const SIDE_SLACK_PX = 24

export default function Dock({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const [menuOpen, setMenuOpen] = createState(false)
    // the dead-man hold: poke() switches it on, only the watchdog switches
    // it off
    const [held, setHeld] = createState(false)
    let lastEvidence = 0 // monotonic µs of the last proof the cursor is here
    let watchdogId: number | null = null
    let selfRef: Astal.Window | null = null
    let dockBoxRef: Gtk.Widget | null = null

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

    const poke = () => {
        if (conf().dock !== "auto-hide") return
        lastEvidence = GLib.get_monotonic_time()
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

        get(activeWorkspace)

        const activeId = hyprland.get_monitors()
            .find(m => m.name === gdkmonitor.get_connector())
            ?.activeWorkspace?.id

        const hastiledWindow = get(clients).some(client =>
            client.workspace.id === activeId
        )

        return !hastiledWindow
    })

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

    return [(
        <window
            css={conf.as(conf =>
                `
                --primary: ${conf.primary_color};
                --dock-margin: ${conf.dock_margin}px;
                --jumptime: ${JUMP_ANIMATION_CLASS_TIMEOUT}ms;
                --icon-size: ${conf.dock_icon_size}px;
                --dock-slide-duration: ${DOCK_SLIDE_DURATION}ms;
                --dock-slide-distance: ${conf.dock_icon_size + 68}px;
                `
            )}
            name="ags-dock"
            class={conf.as(conf => `Dock theme-${conf.theme}${conf.dock_full_width ? " dock-full" : ""}`)}
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

                // any pointer or drag activity on the dock is presence
                // evidence — no leave handling, the watchdog notices absence
                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", poke)
                motionController.connect("motion", poke)
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", poke)
                dragMotion.connect("motion", poke)
                self.add_controller(dragMotion)

                // immediate region updates on state changes…
                showDock.subscribe(syncInputRegion)
                conf.subscribe(syncInputRegion)
                lengths.subscribe(syncInputRegion)
                self.connect("map", syncInputRegion)
                // …and the reconciler: even if every one of those missed
                // (icon reflow moved the pill, an animation raced the
                // bounds), the region self-heals within half a second
                const reconcileId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, RECONCILE_TICK_MS, () => {
                        syncInputRegion()
                        return GLib.SOURCE_CONTINUE
                    })
                onCleanup(() => {
                    GLib.source_remove(reconcileId)
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
                        /*visible={createComputed(get =>
                            get(list).length > 0 && get(unpinnedList).length > 0
                        )}*/
                       visible={false}
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