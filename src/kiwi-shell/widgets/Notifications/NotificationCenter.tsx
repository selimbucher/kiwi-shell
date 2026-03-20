import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Notifd from "gi://AstalNotifd"
import { For, createState, createBinding, createComputed, onCleanup } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { timeout } from "ags/time"

import { conf } from "../config";

const DEFAULT_TIMEOUT = 4000

const notifd = Notifd.get_default()

export const [ncOpen, setNcOpen] = createState(false)

export function toggleNc() {
    setNcOpen(!ncOpen())
}

const [notifState, setNotifState] = createState<Map<number, "active" | "expired">>(new Map())

notifd.connect("notified", (_, id) => {
    setNotifState(m => new Map([[id, "active" as const], ...m]))

    const n = notifd.get_notification(id)
    const n_timeout = n["expire-timeout"] > 0 ? n["expire-timeout"] : DEFAULT_TIMEOUT

    timeout(n_timeout, () => {
        setNotifState(m => new Map([...m, [id, "expired" as const]]))
    })
})

notifd.connect("resolved", (_, id) => {
    setNotifState(m => {
        const next = new Map(m)
        next.delete(id)
        return next
    })
})

const activeNotifs = createComputed(get =>
    [...get(notifState).entries()]
        .filter(([_, s]) => s === "active")
        .map(([id]) => notifd.get_notification(id))
        .filter(Boolean) as Notifd.Notification[]
)

const expiredNotifs = createComputed(get =>
    [...get(notifState).entries()]
        .filter(([_, s]) => s === "expired")
        .map(([id]) => notifd.get_notification(id))
        .filter(Boolean) as Notifd.Notification[]
)


export default function NotificationCenter({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT } = Astal.WindowAnchor

    const dnd = createBinding(notifd, "dont-disturb")

    const showActive = createComputed(get =>
        get(activeNotifs).length > 0 && (get(ncOpen) || !get(dnd))
    )

    return (
        <window
            css={conf.as(conf => `--primary: ${conf.primary_color};`)}
            visible={createComputed(get => get(showActive) || get(ncOpen))}
            name="ags-notification-center"
            class={conf.as(conf => `Notifications theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={TOP | RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                notifState.subscribe(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        self.set_default_size(-1, -1)
                        self.queue_resize()
                        return GLib.SOURCE_REMOVE
                    })
                })
                onCleanup(() => self.destroy())
            }}
        >
            <box class="notifications" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <box
                    class="active-notifications"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    visible={showActive}
                >
                    <For each={activeNotifs}>
                        {(n) => <Notification n={n} />}
                    </For>
                </box>
                <box
                    class="expired-notifications"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    visible={ncOpen}
                >
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        class="no-notifications"
                        halign={Gtk.Align.CENTER}
                        visible={notifState(m => m.size === 0)}
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
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                        <For each={expiredNotifs}>
                            {(n) => <Notification n={n} />}
                        </For>
                    </box>
                </box>
            </box>
        </window>
    )
}

function Notification({ n }: { n: Notifd.Notification }) {
    return (
        <button
            class="notification"
            onclicked={() => {
                print("Notification clicked:", n.summary)
                n.dismiss()
            }}
        >
            <box
                orientation={Gtk.Orientation.VERTICAL}
                halign={Gtk.Align.START}
                spacing={0}
            >
                <box class="header">
                    {n["app-icon"] && (
                        <Gtk.Image
                            iconName={n["app-icon"]}
                            pixelSize={16}
                            class="notification-icon"
                        />
                    )}
                    <label class="app-name" label={n["app-name"].toUpperCase()} halign={Gtk.Align.START} />
                </box>
                <label class="summary" label={String(n.summary)} halign={Gtk.Align.START} />
                <label class="body" label={String(n.body).trim()} halign={Gtk.Align.START} />
            </box>
        </button>
    )
}

function getAppIcon(n: Notifd.Notification): string | null {
    const desktopEntry = n.desktop_entry
    if (!desktopEntry) return null

    const appInfo = Gio.DesktopAppInfo.new(`${desktopEntry}.desktop`)
    if (!appInfo) return null

    const icon = appInfo.get_icon()
    if (!icon) return null

    return (icon as Gio.ThemedIcon).get_names?.()?.[0] ?? null
}