import { logger } from "../../log"
const log = logger("notifications")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Notifd from "gi://AstalNotifd"
import { For, createState, createBinding, createComputed, onCleanup } from "ags"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"

import { conf } from "../config"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { clientSelector, focusWindow } from "../../hypr"

const DEFAULT_TIMEOUT = 5000
const NOTIF_WIDTH = 360
const APP_ICON_SIZE = 38
const IMAGE_SIZE = 42
const MAX_HISTORY = 50

const EXIT_SLIDE_MS = 250
const EXIT_COLLAPSE_MS = 200
const EXIT_TOTAL_MS = EXIT_SLIDE_MS + EXIT_COLLAPSE_MS

const notifd = Notifd.get_default()

const NC_SLIDE_MS = 300

export const [ncOpen, setNcOpen] = createState(false)

// keeps the window alive (and fullscreen-anchored) until the close slide-out
// animation has finished
const [ncClosing, setNcClosing] = createState(false)
let ncCloseTimer: ReturnType<typeof setTimeout> | null = null

// State update order matters in here: window visibility is computed from
// (ncOpen || ncClosing) and each set() re-evaluates it synchronously. The
// window must never see both false mid-transition, or it unmaps for a tick
// and GTK skips the slide animation.
export function closeNc() {
    if (!ncOpen()) return
    setNcClosing(true)
    setNcOpen(false)
    if (ncCloseTimer) clearTimeout(ncCloseTimer)
    // unmap right after the slide finishes: a mapped-but-static window can
    // only accumulate trouble (frozen frame clock leaves a stale sliver on
    // screen until unmap — hiding is what thaws it, so hide promptly)
    ncCloseTimer = setTimeout(() => {
        ncCloseTimer = null
        setNcClosing(false)
        // collapse groups again once the window is unmapped (invisible relayout)
        setExpandedGroups(new Set())
    }, NC_SLIDE_MS + 60)
}

export function toggleNc() {
    if (ncOpen()) {
        closeNc()
    } else {
        // reopening mid slide-out just reverses the animation
        if (ncCloseTimer) {
            clearTimeout(ncCloseTimer)
            ncCloseTimer = null
        }
        setNcOpen(true)
        setNcClosing(false)
        // active banners fold into the history list (macOS-style) so animated
        // banners and the static list never mix while the center is open
        flushActiveToHistory()
    }
}

function flushActiveToHistory() {
    const current = notifState()
    const next = new Map(current)
    let changed = false
    for (const [id, phase] of current) {
        if (phase !== "active" && phase !== "closing") continue
        clearExpiryTimer(id)
        next.set(id, "expired")
        changed = true
    }
    if (changed) {
        setNotifState(next)
        trimHistory()
    }
}

// active: banner on screen, closing: banner playing its exit animation,
// expired: only listed in the notification center history
type Phase = "active" | "closing" | "expired"

const animatedIds = new Set<number>()
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>()

// Notifications the daemon kept from a previous shell instance go straight
// to history, newest first.
function seedExisting(): Map<number, Phase> {
    try {
        const existing = [...(notifd.get_notifications() ?? [])]
        existing.sort((a, b) => b.time - a.time)
        for (const n of existing) animatedIds.add(n.id)
        return new Map(existing.map(n => [n.id, "expired" as const]))
    } catch {
        return new Map()
    }
}

const [notifState, setNotifState] = createState<Map<number, Phase>>(seedExisting())

function clearExpiryTimer(id: number) {
    const timer = expiryTimers.get(id)
    if (timer !== undefined) {
        clearTimeout(timer)
        expiryTimers.delete(id)
    }
}

function scheduleExpiry(id: number) {
    const n = notifd.get_notification(id)
    if (!n) return
    // Critical notifications stay until acted upon, like macOS alerts.
    if (n.urgency === Notifd.Urgency.CRITICAL) return
    const ms = n.expireTimeout > 0 ? n.expireTimeout : DEFAULT_TIMEOUT
    expiryTimers.set(id, setTimeout(() => {
        expiryTimers.delete(id)
        beginClose(id)
    }, ms))
}

function beginClose(id: number) {
    setNotifState(m =>
        m.get(id) === "active" ? new Map(m).set(id, "closing") : m
    )
    setTimeout(() => {
        const n = notifd.get_notification(id)
        if (n?.transient) {
            // transient hint: excluded from persistence
            n.dismiss()
            return
        }
        setNotifState(m =>
            m.get(id) === "closing" ? new Map(m).set(id, "expired") : m
        )
        trimHistory()
    }, EXIT_TOTAL_MS)
}

function trimHistory() {
    const expired = [...notifState()].filter(([, p]) => p === "expired")
    for (const [id] of expired.slice(MAX_HISTORY)) {
        const n = notifd.get_notification(id)
        if (n) {
            n.dismiss()
        } else {
            setNotifState(m => {
                const next = new Map(m)
                next.delete(id)
                return next
            })
        }
    }
}

function clearHistory() {
    for (const [id, p] of notifState()) {
        if (p !== "expired") continue
        notifd.get_notification(id)?.dismiss()
    }
    setNotifState(m => new Map([...m].filter(([, p]) => p !== "expired")))
}

notifd.connect("notified", (_, id) => {
    // also fires for replacements: reset phase and expiry, move to the top
    clearExpiryTimer(id)
    if (ncOpen()) {
        // center is open: skip the banner phase, land at the top of the list
        setNotifState(m => {
            const next = new Map(m)
            next.delete(id)
            return new Map([[id, "expired" as const], ...next])
        })
        trimHistory()
    } else {
        setNotifState(m => {
            const next = new Map(m)
            next.delete(id)
            return new Map([[id, "active" as const], ...next])
        })
        scheduleExpiry(id)
    }
})

notifd.connect("resolved", (_, id) => {
    clearExpiryTimer(id)
    animatedIds.delete(id)
    setNotifState(m => {
        const next = new Map(m)
        next.delete(id)
        return next
    })
})

// ─── macOS-style grouping ─────────────────────────────────────────────────────
// Center entries are grouped by app: a collapsed group shows only its newest
// card (with an "N more" affordance and a stacked look), expanding lists all.
// Banners are never grouped — only expired cards while the center is open.
const groupKeyOf = (n: Notifd.Notification) =>
    n.appName || n.desktopEntry || "unknown"

const [expandedGroups, setExpandedGroups] = createState<Set<string>>(new Set())

function toggleGroup(key: string) {
    setExpandedGroups(s => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
}

// One unified list: banners and center entries are the same widgets, so
// opening the center never recreates or moves cards (no visual glitches) —
// per-card visibility just changes with the phase and center state.
// Group members are kept contiguous, with groups ordered by their newest
// member (the map is already newest-first).
const allNotifs = createComputed(get => {
    const notifs = [...get(notifState).keys()]
        .map(id => notifd.get_notification(id))
        .filter(Boolean) as Notifd.Notification[]
    const groups = new Map<string, Notifd.Notification[]>()
    for (const n of notifs) {
        const k = groupKeyOf(n)
        const g = groups.get(k)
        if (g) g.push(n)
        else groups.set(k, [n])
    }
    return [...groups.values()].flat()
})

const anyBanner = createComputed(get =>
    [...get(notifState).values()].some(p => p !== "expired")
)

const dnd = createBinding(notifd, "dont-disturb")

// the window stays alive while the center is open or flying out
const ncShown = createComputed(get => get(ncOpen) || get(ncClosing))

// bumped whenever a card changes size on its own (e.g. body expand/collapse)
// so the window can shrink back to its natural size
const [resizeTick, setResizeTick] = createState(0)
function requestNcResize() {
    setResizeTick(resizeTick() + 1)
}

// clock for the relative timestamps
const [nowSec, setNowSec] = createState(Math.floor(Date.now() / 1000))
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    setNowSec(Math.floor(Date.now() / 1000))
    return GLib.SOURCE_CONTINUE
})

function formatRelativeTime(time: number, now: number): string {
    const diff = Math.max(0, now - time)
    if (diff < 60) return "now"
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return GLib.DateTime.new_from_unix_local(time)?.format("%b %e") ?? ""
}

// Transparent fullscreen window that maps only while the center is open. It
// sits on a lower layer than the content window, so any click it receives is
// by construction outside the panel — no geometry math needed. Keeping the
// backdrop separate means the content window's surface is NEVER reconfigured
// (no anchor/keymode churn), which caused resize glitches and lost frames.
function NcBackdrop({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT, BOTTOM, LEFT } = Astal.WindowAnchor
    return (
        <window
            name="ags-nc-backdrop"
            class="nc-backdrop"
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            visible={ncOpen}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={TOP | RIGHT | BOTTOM | LEFT}
            keymode={ncOpen.as(open => open ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.set_button(0)
                // close on release, deferred one idle: hiding the backdrop in
                // the middle of its own press breaks GTK's active-state
                // accounting ("Broken accounting of active state" warnings)
                click.connect("released", () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        closeNc()
                        return GLib.SOURCE_REMOVE
                    })
                })
                self.add_controller(click)

                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_controller, keyval) => {
                    if (keyval === Gdk.KEY_Escape) {
                        closeNc()
                        return true
                    }
                    return false
                })
                self.add_controller(key)

                onCleanup(() => destroyWindow(self))
            }}
        >
            <box />
        </window>
    )
}

export default function NotificationCenter({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT } = Astal.WindowAnchor

    // Scroll once the list would leave the viewport: cap the scrolled window at
    // monitor height minus the bar and, when it reserves space, the dock.
    const maxListHeight = createComputed(get => {
        const c = get(conf)
        const monitor = get(popupGdkMonitor) ?? gdkmonitor
        const dockAllowance = c.dock === "default" ? (c.dock_icon_size ?? 56) + 46 : 0
        return Math.max(200, monitor.get_geometry().height - 48 - dockAllowance)
    })

    return [(
        <window
            css={conf.as(conf => `--primary: ${conf.primary_color};`)}
            visible={createComputed(get => get(ncShown) || (get(anyBanner) && !get(dnd)))}
            name="ags-notification-center"
            class={conf.as(conf => `Notifications theme-${conf.theme}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={TOP | RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            $={(self) => {
                // The surface must stay completely undisturbed while the close
                // slide runs: no resizes, no input-region changes, no forced
                // redraws. Any of those emit extra commits, and a commit whose
                // frame callback the compositor drops freezes GTK's frame clock
                // mid-transition. The window unmaps 60ms after the slide, so
                // deferred work just waits for that.
                const shrinkToFit = () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (ncClosing()) return GLib.SOURCE_REMOVE
                        self.set_default_size(-1, -1)
                        self.queue_resize()
                        return GLib.SOURCE_REMOVE
                    })
                }
                const unsub = notifState.subscribe(shrinkToFit)
                const unsubResize = resizeTick.subscribe(shrinkToFit)
                const unsubClosing = ncClosing.subscribe(() => {
                    if (!ncClosing()) shrinkToFit()
                })

                onCleanup(() => {
                    unsub()
                    unsubResize()
                    unsubClosing()
                    destroyWindow(self)
                })
            }}
        >
            <overlay>
            <scrolledwindow
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                propagateNaturalHeight
                propagateNaturalWidth
                maxContentHeight={maxListHeight}
                halign={Gtk.Align.END}
                valign={Gtk.Align.START}
            >
            <box class="notifications" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    class="no-notifications"
                    halign={Gtk.Align.CENTER}
                    visible={createComputed(get => get(ncOpen) && get(notifState).size === 0)}
                >
                    <Gtk.Image
                        iconName="notification-alert-symbolic"
                        pixelSize={32}
                        class="no-notifications-icon"
                    />
                    <box class="no-notifications-text" halign={Gtk.Align.CENTER}>
                        No notifications
                    </box>
                </box>
                <revealer
                    transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    transitionDuration={NC_SLIDE_MS}
                    revealChild={false}
                    visible={createComputed(get => get(ncShown) && get(notifState).size > 0)}
                    $={(self) => {
                        // The revealer only animates the *space*: banners slide
                        // down on open, the whole center slides back up on close.
                        // The title itself never moves vertically — it stays
                        // horizontally offscreen and slides in from the right
                        // once its slot has mostly grown.
                        let headerBox: Gtk.Widget | null =
                            (self as Gtk.Revealer).get_child?.() ?? null
                        const unsub = ncOpen.subscribe(() => {
                            headerBox ??= (self as Gtk.Revealer).get_child?.() ?? null
                            if (ncOpen()) {
                                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                    if (!ncOpen()) return GLib.SOURCE_REMOVE
                                    // title and cards slide in together
                                    self.set_reveal_child(true)
                                    headerBox?.remove_css_class("offscreen")
                                    return GLib.SOURCE_REMOVE
                                })
                            } else {
                                // horizontal slide-out only — collapsing the
                                // revealer here would resize the surface every
                                // frame mid-close, and each configure can stall
                                // the frame clock (the freeze). The vertical
                                // collapse is invisible anyway once the content
                                // is off to the right.
                                headerBox?.add_css_class("offscreen")
                            }
                        })
                        // reset the reveal state only after the close finished
                        // and the revealer is unmapped: unmapped widgets don't
                        // animate, so this is instant and invisible
                        const unsubClosing = ncClosing.subscribe(() => {
                            if (ncClosing() || ncOpen()) return
                            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                if (!ncOpen()) self.set_reveal_child(false)
                                return GLib.SOURCE_REMOVE
                            })
                        })
                        onCleanup(() => {
                            unsub()
                            unsubClosing()
                        })
                    }}
                >
                    <box class="nc-header offscreen">
                        <label class="nc-title" label="Notifications" hexpand xalign={0} />
                        <button class="clear-all-button" onClicked={clearHistory}>
                            <box spacing={4}>
                                <Gtk.Image iconName="edit-clear-all-symbolic" pixelSize={12} />
                                <label label="Clear All" />
                            </box>
                        </button>
                    </box>
                </revealer>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                    <For each={allNotifs}>
                        {(n) => <Notification n={n} />}
                    </For>
                </box>
            </box>
            </scrolledwindow>
            {/* invisible animated pixel: while the close slide runs it keeps
                every frame carrying real damage, so the compositor keeps
                answering frame callbacks and the clock can't starve */}
            <box
                $type="overlay"
                class="nc-damage-beacon"
                visible={ncClosing}
                canTarget={false}
                halign={Gtk.Align.END}
                valign={Gtk.Align.START}
                widthRequest={2}
                heightRequest={2}
            />
            </overlay>
        </window>
    ), <NcBackdrop gdkmonitor={gdkmonitor} />]
}

function Notification({ n }: { n: Notifd.Notification }) {
    const isNew = !animatedIds.has(n.id)
    if (isNew) animatedIds.add(n.id)

    const phase = createComputed(get => get(notifState).get(n.id))
    const summary = createBinding(n, "summary")
    const body = createBinding(n, "body")
    const timeLabel = nowSec(now => formatRelativeTime(n.time, now))

    const { icon, image } = notifVisuals(n)
    const actionButtons = (n.actions ?? []).filter(a => a.id !== "default")

    // group bookkeeping: expired members of this card's app, newest first
    const groupKey = groupKeyOf(n)
    const groupInfo = createComputed(get => {
        const state = get(notifState)
        const members = get(allNotifs).filter(o =>
            groupKeyOf(o) === groupKey && state.get(o.id) === "expired")
        return { size: members.length, isHead: members[0]?.id === n.id }
    })
    const groupExpanded = createComputed(get => get(expandedGroups).has(groupKey))
    // collapsed head of a multi-card group gets the macOS stacked-cards look
    const stacked = createComputed(get =>
        get(phase) === "expired" &&
        get(groupInfo).isHead &&
        get(groupInfo).size > 1 &&
        !get(groupExpanded)
    )

    let wrap: Gtk.Widget | null = null

    // macOS behavior: clicking opens the source (default action if the app
    // provides one, otherwise focus its window) and the notification is gone
    // for good, including from the center.
    const activate = () => {
        if ((n.actions ?? []).some(a => a.id === "default")) {
            n.invoke("default")
        } else {
            focusApp(n)
        }
        n.dismiss()
    }

    // banners are visible unless dnd hides them; center entries only while the
    // center is open or flying out — and, within a collapsed group, only the
    // newest card
    const cardVisible = createComputed(get => {
        const p = get(phase)
        if (p === undefined) return false
        if (p === "expired") {
            if (!get(ncShown)) return false
            return get(groupInfo).isHead || get(groupExpanded)
        }
        return get(ncOpen) || !get(dnd)
    })

    return (
        <revealer
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            transitionDuration={EXIT_COLLAPSE_MS}
            revealChild={true}
            visible={cardVisible}
            $={(self) => {
                // New cards claim their space instantly (revealed from the
                // start) and only animate via transforms, like the dock: a
                // revealer growing the slot re-allocates the card every frame
                // while the surface resize lags behind, visibly squishing it.
                // The revealer still animates the collapse on exit.

                // Single slide driver for every card state. Sliding in is
                // deferred one idle so a freshly-mapped card still transitions.
                const applySlide = () => {
                    if (!wrap) return
                    const p = notifState().get(n.id)
                    if (p === "closing") {
                        wrap.add_css_class("offscreen")
                        setTimeout(() => {
                            if (notifState().get(n.id) === "closing")
                                self.set_reveal_child(false)
                        }, EXIT_SLIDE_MS)
                    } else if (p === "expired" && !ncOpen()) {
                        // parked offscreen, ready to slide in when the center opens
                        wrap.add_css_class("offscreen")
                    } else if (p === "active") {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (notifState().get(n.id) === "active" && wrap) {
                                wrap.remove_css_class("offscreen")
                                self.set_reveal_child(true)
                            }
                            return GLib.SOURCE_REMOVE
                        })
                    } else if (p === "expired") {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (notifState().get(n.id) === "expired" && ncOpen() && wrap) {
                                wrap.remove_css_class("offscreen")
                                self.set_reveal_child(true)
                            }
                            return GLib.SOURCE_REMOVE
                        })
                    }
                }
                const unsubPhase = phase.subscribe(applySlide)
                const unsubOpen = ncOpen.subscribe(applySlide)
                onCleanup(() => {
                    unsubPhase()
                    unsubOpen()
                })
            }}
        >
            <overlay
                class="notification-wrap"
                $={(self) => {
                    wrap = self
                    // enter/exit use a transition between .offscreen and resting
                    // state instead of a CSS animation: transitions only run on
                    // state changes, so a surface remap (e.g. the center's
                    // anchor flip) can never replay them
                    const p = notifState().get(n.id)
                    if (isNew || (p === "expired" && !ncOpen())) {
                        self.add_css_class("offscreen")
                    }
                    if (isNew) {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            const cur = notifState().get(n.id)
                            const shouldShow = cur === "active" ||
                                (cur === "expired" && ncOpen())
                            if (shouldShow) self.remove_css_class("offscreen")
                            return GLib.SOURCE_REMOVE
                        })
                    }
                }}
            >
                <box
                    class="notification"
                    widthRequest={NOTIF_WIDTH}
                    $={(self) => {
                        if (n.urgency === Notifd.Urgency.CRITICAL) {
                            self.add_css_class("critical")
                        }
                        const applyStacked = () => {
                            if (stacked()) self.add_css_class("stacked")
                            else self.remove_css_class("stacked")
                        }
                        applyStacked()
                        const unsubStacked = stacked.subscribe(applyStacked)
                        onCleanup(unsubStacked)
                        // a plain gesture instead of a button: clicks on nested
                        // buttons/links must not fall through to the card action
                        const click = new Gtk.GestureClick()
                        click.set_button(1)
                        click.connect("released", (_gesture, _nPress, x, y) => {
                            const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                            for (let w: Gtk.Widget | null = target; w && w !== self; w = w.get_parent()) {
                                if (w instanceof Gtk.Button) return
                                if (w instanceof Gtk.Label && w.get_current_uri()) return
                            }
                            // macOS: clicking a collapsed stack expands the
                            // group; only an expanded (or single) card activates
                            if (stacked()) {
                                toggleGroup(groupKey)
                                requestNcResize()
                                return
                            }
                            activate()
                        })
                        self.add_controller(click)
                    }}
                >
                    <box class="notification-content" spacing={10} hexpand>
                        {icon}
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
                            <box class="header" spacing={6}>
                                <label
                                    class="app-name"
                                    label={n.appName.toUpperCase()}
                                    ellipsize={Pango.EllipsizeMode.END}
                                    maxWidthChars={1}
                                    hexpand
                                    xalign={0}
                                />
                                <label class="notif-time" label={timeLabel} halign={Gtk.Align.END} />
                            </box>
                            <label
                                class="summary"
                                label={summary.as(s => String(s ?? ""))}
                                ellipsize={Pango.EllipsizeMode.END}
                                maxWidthChars={1}
                                hexpand
                                xalign={0}
                            />
                            <label
                                class="body"
                                useMarkup
                                label={body.as(b => sanitizeBody(String(b ?? "")))}
                                visible={body.as(b => String(b ?? "").trim() !== "")}
                                wrap
                                wrapMode={Pango.WrapMode.WORD_CHAR}
                                ellipsize={Pango.EllipsizeMode.END}
                                lines={4}
                                maxWidthChars={1}
                                hexpand
                                xalign={0}
                                $={(self) => {
                                    self.connect("activate-link", (_label, uri: string) => {
                                        openUri(uri)
                                        return true
                                    })
                                }}
                            />
                            {actionButtons.length > 0 && (
                                <box class="actions" spacing={6} halign={Gtk.Align.END}>
                                    {actionButtons.map(action => (
                                        <button
                                            class="action-button"
                                            onClicked={() => {
                                                n.invoke(action.id)
                                                if (!n.resident) n.dismiss()
                                            }}
                                        >
                                            {n.actionIcons
                                                ? <Gtk.Image iconName={action.id} pixelSize={14} />
                                                : <label
                                                    label={action.label}
                                                    ellipsize={Pango.EllipsizeMode.END}
                                                    maxWidthChars={16}
                                                />}
                                        </button>
                                    ))}
                                </box>
                            )}
                            <button
                                class="group-toggle"
                                visible={createComputed(get => {
                                    const gi = get(groupInfo)
                                    return get(phase) === "expired" &&
                                        gi.isHead && gi.size > 1
                                })}
                                halign={Gtk.Align.START}
                                onClicked={() => {
                                    toggleGroup(groupKey)
                                    requestNcResize()
                                }}
                            >
                                <box spacing={2}>
                                    <label label={createComputed(get =>
                                        get(groupExpanded)
                                            ? "show less"
                                            : `${get(groupInfo).size - 1} more`
                                    )} />
                                    <Gtk.Image
                                        iconName={groupExpanded.as(e =>
                                            e ? "pan-up-symbolic" : "pan-down-symbolic"
                                        )}
                                        pixelSize={10}
                                    />
                                </box>
                            </button>
                        </box>
                        {image}
                    </box>
                </box>
                <button
                    $type="overlay"
                    class="close-button"
                    halign={Gtk.Align.START}
                    valign={Gtk.Align.START}
                    onClicked={() => n.dismiss()}
                >
                    <Gtk.Image iconName="window-close-symbolic" pixelSize={9} />
                </button>
            </overlay>
        </revealer>
    )
}

// ─── Icons / images ───────────────────────────────────────────────────────────

function filePathOf(str: string | null | undefined): string | null {
    if (!str) return null
    const path = str.startsWith("file://") ? str.slice("file://".length) : str
    if (!path.startsWith("/")) return null
    return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null
}

function desktopEntryIcon(n: Notifd.Notification): string | null {
    const de = n.desktopEntry
    if (!de) return null
    const base = de.endsWith(".desktop") ? de.slice(0, -".desktop".length) : de
    for (const candidate of [base, base.toLowerCase()]) {
        const info = GioUnix.DesktopAppInfo.new(candidate + ".desktop")
        const iconName = info?.get_string("Icon")
        if (iconName) return iconName
    }
    return null
}

// A Gtk.Picture's natural size is the image's full size, which would blow up
// the card for large images. An overlay only measures its main child, so a
// fixed-size box dictates the size and the picture just fills it (cover-crop).
function roundedImage(path: string, size: number): Gtk.Widget {
    return (
        <overlay
            class="notif-image"
            overflow={Gtk.Overflow.HIDDEN}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
        >
            <box widthRequest={size} heightRequest={size} />
            <Gtk.Picture
                $type="overlay"
                $={(self: Gtk.Picture) => {
                    self.set_filename(path)
                    self.set_content_fit(Gtk.ContentFit.COVER)
                    self.set_can_shrink(true)
                }}
            />
        </overlay>
    ) as Gtk.Widget
}

// App icon on the left, content image (image-path / image-data hint) on the
// right — like macOS. If there is no app icon, the content image is promoted
// to the app-icon slot instead of showing a generic fallback.
function notifVisuals(n: Notifd.Notification): { icon: Gtk.Widget, image: Gtk.Widget | null } {
    const themedIcon = desktopEntryIcon(n)
        ?? (n.appIcon && !filePathOf(n.appIcon) ? n.appIcon : null)
    const appIconPath = filePathOf(n.appIcon)
    const imagePath = filePathOf(n.image)
    const imageIconName = !imagePath && n.image ? n.image : null

    const iconImage = (iconName: string) => (
        <Gtk.Image
            iconName={iconName}
            pixelSize={APP_ICON_SIZE}
            class="notif-app-icon"
            valign={Gtk.Align.CENTER}
        />
    ) as Gtk.Widget

    const icon =
        themedIcon ? iconImage(themedIcon)
        : appIconPath ? roundedImage(appIconPath, APP_ICON_SIZE)
        : imagePath ? roundedImage(imagePath, APP_ICON_SIZE)
        : imageIconName ? iconImage(imageIconName)
        : iconImage("dialog-information-symbolic")

    const imageUsedAsIcon = !themedIcon && !appIconPath
    const image = imageUsedAsIcon ? null
        : imagePath ? roundedImage(imagePath, IMAGE_SIZE)
        : imageIconName ? (
            <Gtk.Image
                iconName={imageIconName}
                pixelSize={IMAGE_SIZE}
                class="notif-image-icon"
                valign={Gtk.Align.CENTER}
            />
        ) as Gtk.Widget
        : null

    return { icon, image }
}

// ─── Body markup ──────────────────────────────────────────────────────────────

// The spec allows a small HTML subset in the body (<b>, <i>, <u>, <a>, <img>),
// but arbitrary text is common too. Escape everything, then re-allow tags that
// GtkLabel's Pango markup understands, so stray '<', '>' and '&' can't break
// rendering. Falls back to plain text when tags don't balance.
function sanitizeBody(rawBody: string): string {
    const stripped = rawBody
        .replace(/<img[^>]*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")

    let s = GLib.markup_escape_text(stripped, -1)
    s = s.replace(/&lt;(\/?)(b|i|u|s|tt|big|small|sub|sup)&gt;/gi, "<$1$2>")
    s = s.replace(
        /&lt;a\s+href=(&quot;|&apos;)([\s\S]*?)\1&gt;/gi,
        (_match, _quote, href) => `<a href="${href.replace(/&apos;/g, "&#39;")}">`,
    )
    s = s.replace(/&lt;\/a&gt;/gi, "</a>")

    if (!tagsBalanced(s)) {
        return GLib.markup_escape_text(stripped.replace(/<[^>]*>/g, ""), -1)
    }
    return s
}

function tagsBalanced(markup: string): boolean {
    const stack: string[] = []
    const tagRe = /<(\/?)([a-z]+)(?:\s[^>]*)?>/gi
    let match: RegExpExecArray | null
    while ((match = tagRe.exec(markup)) !== null) {
        if (match[1]) {
            if (stack.pop() !== match[2].toLowerCase()) return false
        } else {
            stack.push(match[2].toLowerCase())
        }
    }
    return stack.length === 0
}

// Focus an existing window of the sending app, if there is one. Deliberately
// conservative (exact class match only) — never launches anything.
function focusApp(n: Notifd.Notification) {
    const targets = [
        n.desktopEntry?.replace(/\.desktop$/i, ""),
        n.appName,
    ].filter(Boolean).map(s => String(s).toLowerCase())
    if (targets.length === 0) return

    try {
        const client = Hyprland.get_default().get_clients().find((c: any) => {
            const initialClass = (c["initial-class"] ?? "").toLowerCase()
            const cls = (c["class"] ?? "").toLowerCase()
            return targets.some(t => t === initialClass || t === cls)
        })
        if (client) focusWindow(clientSelector(client))
    } catch (error) {
        log.error("Failed to focus app for notification:", error)
    }
}

function openUri(uri: string) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null)
    } catch (error) {
        log.error("Failed to open link:", error)
    }
}
