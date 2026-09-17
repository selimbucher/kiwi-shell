import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import { createComputed, createState, onCleanup } from "ags"

import { conf } from "../config"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { themeClasses, LAYER } from "../services/theme"
import { AnimatedColumn } from "./AnimatedColumn"
import { CARD_WIDTH, rowFactory } from "./NotificationCard"
import { centerOpen, closeCenter, layout, openCenter, setBannerHover } from "./store"

// room around the cards for the close button on their corner and their shadow
const COLUMN_WIDTH = CARD_WIDTH + 24
const ROW_SPACING = 2
// stagger between cards sliding in when the center opens
const OPEN_STAGGER_MS = 22
// stay mapped this long after the last card left, so a quick follow-up
// banner doesn't remap the surface
const LINGER_MS = 1000

export function toggleNc() {
    if (centerOpen()) closeCenter()
    else openCenter()
}

export function closeNc() {
    closeCenter()
}

// Banners and the center share one layer surface: a column of fixed width
// anchored to the top, right and bottom edge. Its size never depends on the
// content, so opening the center, cards coming and going and groups
// expanding never resize or remap it; everything moves inside
// AnimatedColumn. Input is limited to the banners while the center is
// closed, so the empty part of the column never blocks clicks.
export default function NotificationCenter({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT, BOTTOM, LEFT } = Astal.WindowAnchor

    const column = new AnimatedColumn()
    column.setup(rowFactory, ROW_SPACING)

    const [busy, setBusy] = createState(false)
    const [lingering, setLingering] = createState(false)
    let lingerSource = 0
    column.onBusyChanged = (isBusy) => {
        if (lingerSource) GLib.source_remove(lingerSource)
        lingerSource = 0
        if (!isBusy) {
            setLingering(true)
            lingerSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER_MS, () => {
                lingerSource = 0
                setLingering(false)
                return GLib.SOURCE_REMOVE
            })
        }
        setBusy(isBusy)
    }

    const shown = createComputed(get => get(centerOpen) || get(busy) || get(lingering))

    // Moving a mapped layer surface to another monitor remaps it, so the
    // monitor only follows the popup monitor while nothing is shown, and
    // at the moment the center opens.
    const [monitor, setMonitor] = createState<Gdk.Monitor>(popupGdkMonitor() ?? gdkmonitor)
    const followPopupMonitor = (force = false) => {
        if (force || !shown()) setMonitor(popupGdkMonitor() ?? gdkmonitor)
    }

    let wasOpen = centerOpen()
    const syncRows = () => {
        const { rows, foldsInto } = layout()
        const opening = centerOpen() && !wasOpen
        wasOpen = centerOpen()
        if (!rows.some(r => r.kind === "card" && r.banner)) setBannerHover(false)
        column.sync(rows, { staggerMs: opening ? OPEN_STAGGER_MS : 0, foldsInto })
    }

    let win: Gtk.Window | null = null
    let lastRegion = ""
    const syncInputRegion = () => {
        const surface = win?.get_surface()
        if (!win || !surface) return
        if (centerOpen()) {
            if (lastRegion === "all") return
            lastRegion = "all"
            surface.set_input_region(null)
            return
        }
        const rects: number[][] = []
        for (const widget of column.restingWidgets()) {
            const [ok, bounds] = widget.compute_bounds(win)
            if (!ok || bounds.get_width() <= 0) continue
            rects.push([
                Math.floor(bounds.get_x()),
                Math.floor(bounds.get_y()),
                Math.ceil(bounds.get_width()),
                Math.ceil(bounds.get_height()),
            ])
        }
        const signature = rects.join(";")
        if (signature === lastRegion) return
        lastRegion = signature
        const region = new Cairo.Region()
        for (const [x, y, width, height] of rects) {
            const rect = new Cairo.RectangleInt()
            rect.x = x
            rect.y = y
            rect.width = width
            rect.height = height
            region.unionRectangle(rect)
        }
        surface.set_input_region(region)
    }
    column.onLayout = syncInputRegion

    return [(
        <window
            namespace={LAYER.cards}
            css={conf.as(conf => `--primary: ${conf.primary_color};`)}
            visible={shown}
            name="ags-notification-center"
            class={themeClasses(t => `Notifications ${t}`)}
            gdkmonitor={monitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={TOP | RIGHT | BOTTOM}
            // clicking a card takes the keyboard from the backdrop, so the
            // column needs its own Escape while the center is open
            keymode={centerOpen.as(open => open ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
            application={app}
            layer={Astal.Layer.OVERLAY}
            $={(self) => {
                win = self
                const unsubs = [
                    layout.subscribe(syncRows),
                    popupGdkMonitor.subscribe(() => followPopupMonitor()),
                    shown.subscribe(() => followPopupMonitor()),
                    centerOpen.subscribe(() => {
                        if (centerOpen()) {
                            followPopupMonitor(true)
                            setBannerHover(false)
                        }
                        syncInputRegion()
                    }),
                ]
                syncRows()

                // a fresh surface starts without the region
                self.connect("map", () => {
                    lastRegion = ""
                    syncInputRegion()
                })

                // with the input region limited to the banners, entering the
                // window means the pointer is on a banner
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", () => {
                    if (!centerOpen()) setBannerHover(true)
                })
                motion.connect("leave", () => setBannerHover(false))
                self.add_controller(motion)

                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_controller, keyval) => {
                    if (keyval !== Gdk.KEY_Escape || !centerOpen()) return false
                    closeCenter()
                    return true
                })
                self.add_controller(key)

                // clicks on the column around the cards close the center
                const click = new Gtk.GestureClick()
                click.set_button(0)
                click.connect("released", (_gesture, _nPress, x, y) => {
                    if (!centerOpen()) return
                    for (let w = self.pick(x, y, Gtk.PickFlags.DEFAULT); w; w = w.get_parent()) {
                        if (w.get_parent() === column || w instanceof Gtk.Scrollbar) return
                    }
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        closeCenter()
                        return GLib.SOURCE_REMOVE
                    })
                })
                self.add_controller(click)

                onCleanup(() => {
                    for (const unsub of unsubs) unsub()
                    if (lingerSource) GLib.source_remove(lingerSource)
                    column.onBusyChanged = null
                    column.onLayout = null
                    win = null
                    destroyWindow(self)
                })
            }}
        >
            <overlay>
                <scrolledwindow
                    class="nc-scroll"
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                    widthRequest={COLUMN_WIDTH}
                    vexpand
                    $={(self) => {
                        const viewport = new Gtk.Viewport({ scrollToFocus: false })
                        viewport.set_child(column)
                        self.set_child(viewport)
                        // every opening starts at the newest entries
                        onCleanup(centerOpen.subscribe(() => {
                            if (centerOpen()) self.get_vadjustment().set_value(0)
                        }))
                    }}
                />
                {/* GTK doesn't render a window whose snapshot is empty at all, so
                    once the last card left, its final frame (a sliver at the
                    screen edge) stayed up until unmap. One practically invisible
                    pixel keeps every frame renderable. */}
                <box
                    $type="overlay"
                    class="nc-keepalive"
                    canTarget={false}
                    halign={Gtk.Align.START}
                    valign={Gtk.Align.START}
                    widthRequest={1}
                    heightRequest={1}
                />
            </overlay>
        </window>
    ), (
        // Transparent fullscreen window below the column that maps only while
        // the center is open: any click it receives is outside the panel.
        <window
            namespace={LAYER.plain}
            name="ags-nc-backdrop"
            class="nc-backdrop"
            gdkmonitor={monitor}
            visible={centerOpen}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={TOP | RIGHT | BOTTOM | LEFT}
            // it only exists while the center is open: mapping an on-demand
            // layer is what gives it keyboard focus, which Escape needs
            keymode={Astal.Keymode.ON_DEMAND}
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
                        closeCenter()
                        return GLib.SOURCE_REMOVE
                    })
                })
                self.add_controller(click)

                const key = new Gtk.EventControllerKey()
                key.connect("key-pressed", (_controller, keyval) => {
                    if (keyval === Gdk.KEY_Escape) {
                        closeCenter()
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
    )]
}
