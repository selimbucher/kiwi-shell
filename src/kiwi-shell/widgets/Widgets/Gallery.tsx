import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import Pango from "gi://Pango"
import { With, createComputed, createRoot, createState, onCleanup, type Accessor } from "ags"

import { conf } from "../config"
import { LAYER, themeClasses, primaryCss } from "../services/theme"
import { destroyWindow } from "../monitors"
import { Zoomed, zoomOf } from "../zoom"
import { KINDS, addWidget, editingWidgets, setEditingWidgets, sizeOf, type Kind, type WidgetSize, type WidgetSpec } from "./model"
import { WidgetFrame } from "./Frame"

// ─── The widget gallery ───────────────────────────────────────────────────────
// Edit Widgets, as on a Mac: a panel beside Notification Center with every
// widget there is, by app, each at its sizes as it will look, live. A click
// on one puts it at the top of the widgets; Done or Escape ends the editing,
// and so does closing Notification Center.

const PANEL_WIDTH = 780
const PANEL_HEIGHT = 580
const SIDE_WIDTH = 190
// beside the column on a narrow screen: the sizes under each other
const NARROW_WIDTH = 560
const NARROW_SIDE = 150

type App = { name: string, icon: string, kinds: Kind[] }

const APPS: App[] = [...new Set(KINDS.map(k => k.app))].map(name => ({
    name,
    icon: KINDS.find(k => k.app === name)!.icon,
    kinds: KINDS.filter(k => k.app === name),
}))

const matches = (query: string, app: App) => {
    const q = query.trim().toLowerCase()
    return !q || [app.name, ...app.kinds.flatMap(k => [k.name, k.description])].some(t => t.toLowerCase().includes(q))
}

// The previews are built one at a time between frames once the gallery is
// up: all at once, they held up its first frames and Notification Center's
// widgets moving up meanwhile. Each fades in as it's there.
const queue: (() => void)[] = []
let pumping = 0
function later(build: () => void) {
    queue.push(build)
    if (pumping) return
    pumping = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        queue.shift()?.()
        if (queue.length) return GLib.SOURCE_CONTINUE
        pumping = 0
        return GLib.SOURCE_REMOVE
    })
}

function Preview({ kind, size }: { kind: Kind, size: WidgetSize }) {
    const [width, height] = sizeOf(size)
    const slot = new Gtk.Box({ widthRequest: width, heightRequest: height, cssClasses: ["gallery-slot"] })
    let gone = false
    let dispose: (() => void) | null = null
    later(() => {
        if (gone) return
        createRoot(d => {
            dispose = d
            const [spec] = createState<WidgetSpec>({ id: `preview-${kind.kind}-${size}`, kind: kind.kind, size })
            slot.append(WidgetFrame({ spec, preview: true }) as Gtk.Widget)
        })
    })
    onCleanup(() => {
        gone = true
        dispose?.()
    })
    return (
        <button class="gallery-item" valign={Gtk.Align.START} halign={Gtk.Align.START}
            tooltipText={`Add ${kind.name}`} onClicked={() => addWidget(kind.kind, size)}>
            <overlay>
                {slot}
                <box $type="overlay" class="gallery-add" halign={Gtk.Align.START} valign={Gtk.Align.START} canTarget={false}>
                    <Gtk.Image iconName="list-add-symbolic" pixelSize={12} />
                </box>
            </overlay>
        </button>
    )
}

function Shelf({ app: shown, narrow }: { app: App, narrow: boolean }) {
    return (
        <box class="gallery-shelf" orientation={Gtk.Orientation.VERTICAL} spacing={28}>
            {shown.kinds.map(kind => (
                <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                        <label class="gallery-kind" label={kind.name} xalign={0} />
                        <label class="gallery-about" label={kind.description} xalign={0} wrap />
                    </box>
                    <box spacing={12} orientation={narrow ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL}>
                        {kind.sizes.filter(s => s !== "large").map(size => <Preview kind={kind} size={size} />)}
                    </box>
                    {kind.sizes.includes("large") ? <Preview kind={kind} size="large" /> : <box />}
                </box>
            ))}
        </box>
    )
}

// it grows in a little as it fades in, and fades out (style/widgets.scss)
const LEAVE_MS = 180

export function Gallery({ monitor, columnWidth }: { monitor: Accessor<Gdk.Monitor>, columnWidth: number }) {
    // mapped a moment longer than the editing lasts, for the fade
    const [mapped, setMapped] = createState(false)
    let leaving = 0
    onCleanup(editingWidgets.subscribe(() => {
        if (leaving) GLib.source_remove(leaving)
        leaving = 0
        if (editingWidgets.peek()) {
            // (still up, fading out: no map to bring it in again)
            if (mapped.peek()) panel?.add_css_class("open")
            return setMapped(true)
        }
        panel?.remove_css_class("open")
        leaving = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_MS, () => {
            leaving = 0
            setMapped(false)
            return GLib.SOURCE_REMOVE
        })
    }))
    const [query, setQuery] = createState("")
    const [chosen, setChosen] = createState(APPS[0].name)
    const shownApps = createComputed(get => APPS.filter(a => matches(get(query), a)))
    // the app picked, or the first the search leaves
    const shown = createComputed(get => {
        const apps = get(shownApps)
        return apps.find(a => a.name === get(chosen)) ?? apps[0] ?? null
    })
    let panel: Gtk.Widget | null = null
    // (the room left of Notification Center's column, in kiwi's size there,
    // which the settings change)
    const narrow = createComputed(get => {
        const m = get(monitor)
        get(conf)
        return m.get_geometry().width / zoomOf(m) - columnWidth < PANEL_WIDTH + 32
    })

    return (
        <window
            namespace={LAYER.panel}
            name="ags-widget-gallery"
            css={primaryCss}
            class={themeClasses(t => `WidgetGallery ${t}`)}
            visible={mapped}
            gdkmonitor={monitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            layer={Astal.Layer.OVERLAY}
            // the keyboard as it maps: the search, Escape
            keymode={Astal.Keymode.ON_DEMAND}
            application={app}
            $={(self: Gtk.Window) => {
                // the pointer only on the panel (surface coordinates): a click
                // beside it lands on Notification Center's backdrop and ends it
                let last = ""
                const region = () => {
                    const surface = self.get_surface()
                    if (!surface || !panel) return
                    const [ok, bounds] = panel.compute_bounds(self)
                    if (!ok) return
                    const [dx, dy] = self.get_surface_transform()
                    const rect = new Cairo.RectangleInt()
                    ;[rect.x, rect.y, rect.width, rect.height] = [bounds.get_x() + dx, bounds.get_y() + dy,
                        bounds.get_width(), bounds.get_height()].map(Math.round)
                    const signature = `${rect.x},${rect.y},${rect.width},${rect.height}`
                    if (signature === last) return
                    last = signature
                    const r = new Cairo.Region()
                    r.unionRectangle(rect)
                    surface.set_input_region(r)
                }
                let watched: Gdk.Surface | null = null
                self.connect("map", () => {
                    last = ""
                    setQuery("")
                    // in from its first frame on screen
                    panel?.add_tick_callback(() => {
                        if (editingWidgets.peek()) panel?.add_css_class("open")
                        return GLib.SOURCE_REMOVE
                    })
                    // (its region once it has grown to its size)
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                        last = ""
                        region()
                        return GLib.SOURCE_REMOVE
                    })
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        region()
                        const surface = self.get_surface()
                        if (surface && surface !== watched) {
                            watched = surface
                            surface.connect("layout", region)
                        }
                        return GLib.SOURCE_REMOVE
                    })
                })
                const keys = new Gtk.EventControllerKey()
                keys.connect("key-pressed", (_c, key) => {
                    if (key !== Gdk.KEY_Escape) return false
                    setEditingWidgets(false)
                    return true
                })
                self.add_controller(keys)
                onCleanup(() => destroyWindow(self))
            }}
        >
            <Zoomed>
                <box hexpand vexpand>
                    <box hexpand vexpand marginEnd={columnWidth}>
                        <box class="gallery" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} hexpand vexpand
                            widthRequest={narrow(n => n ? NARROW_WIDTH : PANEL_WIDTH)} heightRequest={PANEL_HEIGHT}
                            $={(self: Gtk.Box) => { panel = self }}>
                            <box class="gallery-side" orientation={Gtk.Orientation.VERTICAL} spacing={2}
                                widthRequest={narrow(n => n ? NARROW_SIDE : SIDE_WIDTH)}>
                                <entry class="gallery-search" placeholderText="Search Widgets"
                                    primaryIconName="system-search-symbolic"
                                    onChanged={(self: Gtk.Entry) => setQuery(self.get_text())}
                                    $={(self: Gtk.Entry) => onCleanup(editingWidgets.subscribe(() => {
                                        if (editingWidgets.peek()) self.set_text("")
                                    }))} />
                                <With value={shownApps}>
                                    {(apps: App[]) => (
                                        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                            {apps.map(a => (
                                                <button class={shown(s => s?.name === a.name ? "gallery-app selected" : "gallery-app")}
                                                    onClicked={() => setChosen(a.name)}>
                                                    <box spacing={8}>
                                                        <Gtk.Image iconName={a.icon} pixelSize={16} />
                                                        <label label={a.name} xalign={0} ellipsize={Pango.EllipsizeMode.END} />
                                                    </box>
                                                </button>
                                            ))}
                                        </box>
                                    )}
                                </With>
                            </box>
                            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                                <scrolledwindow class="gallery-scroll" vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    $={(self: Gtk.ScrolledWindow) => {
                                        // another app's widgets, or the gallery again: from their top
                                        const top = () => self.get_vadjustment().set_value(0)
                                        onCleanup(shown.subscribe(top))
                                        onCleanup(mapped.subscribe(top))
                                    }}>
                                    <box>
                                        {/* built while the gallery is up (its fade out too): its
                                            previews follow the calendars and batteries only then */}
                                        <With value={createComputed(get => get(mapped) ? get(shown) : null)}>
                                            {(a: App | null) => a
                                                ? <Shelf app={a} narrow={narrow.peek()} />
                                                : <label class="gallery-none" label="No Widgets" hexpand />}
                                        </With>
                                    </box>
                                </scrolledwindow>
                                <box class="gallery-foot" halign={Gtk.Align.END}>
                                    <button class="gallery-done" onClicked={() => setEditingWidgets(false)}>
                                        <label label="Done" />
                                    </button>
                                </box>
                            </box>
                        </box>
                    </box>
                </box>
            </Zoomed>
        </window>
    )
}
