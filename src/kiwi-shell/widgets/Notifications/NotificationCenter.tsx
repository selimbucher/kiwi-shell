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
const notifications = createBinding(notifd, "notifications")

export const [ncOpen, setNcOpen] = createState(false)

export function toggleNc() {
    setNcOpen(!ncOpen())
}

const [activeIds, setActiveIds] = createState<Set<number>>(new Set())

const activeNotifs = createComputed(get =>
    get(notifications).filter(n => get(activeIds).has(n.id))
)
const expiredNotifs = createComputed(get =>
    get(notifications).filter(n => !get(activeIds).has(n.id))
)

notifd.connect("notified", (_, id) => {
    setActiveIds(s => new Set([...s, id]))

    const n = notifd.get_notification(id)
    const n_timeout = n["expire-timeout"] > 0 ? n["expire-timeout"] : DEFAULT_TIMEOUT

    timeout(n_timeout, () => {
        setActiveIds(s => {
            const next = new Set(s)
            next.delete(id)
            return next
        })
    })
})


export default function NotificationCenter({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const { TOP, RIGHT } = Astal.WindowAnchor

    const dnd = createBinding(notifd, "dont-disturb")

    const showActive = createComputed(get => {
        return get(activeNotifs).length > 0 && (get(ncOpen) || !get(dnd))
    })

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

                notifications.subscribe(() => {
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
                    class="active-notifications"orientation={Gtk.Orientation.VERTICAL} spacing={2}
                    visible={showActive}
                >
                    <For each={activeNotifs}>
                        {(n) => <Notification n={n} />}
                    </For>
                </box>
                <box class="expired-notifications" orientation={Gtk.Orientation.VERTICAL} spacing={2}
                    visible={ncOpen}
                >
                    <box orientation={Gtk.Orientation.VERTICAL} class="no-notifications" halign={Gtk.Align.CENTER}
                        visible={notifications(n => n.length == 0)}
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