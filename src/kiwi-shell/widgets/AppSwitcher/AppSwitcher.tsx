import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createEffect, For, createBinding } from "ags"
import Hyprland from "gi://AstalHyprland"
import { primaryColor, conf } from "../config"
import { captureWindowToTexture } from "./clientCachingService"
import GioUnix from "gi://GioUnix"

export const [isVisible, setVisibility] = createState(false)
export const [selectedAddress, setSelectedAddress] = createState<string | null>(null)
export const [displayedClients, setDisplayedClients] = createState<any[]>([])

const hyprland = Hyprland.get_default()

// ─── MRU tracking ─────────────────────────────────────────────────────────────
let mruAddresses: string[] = []

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    if (client) {
        const addr = client.get_address()
        mruAddresses = [addr, ...mruAddresses.filter(a => a !== addr)]
        if (mruAddresses.length > 50) mruAddresses.length = 50
    }
})

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleAppSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showAppSwitcher()
            break
        case "open-next":
            if (!isVisible()) showAppSwitcher()
            selectNextClient()
            break
        case "close":
            hideAppSwitcher()
            break
        case "toggle":
            if (isVisible()) hideAppSwitcher()
            else showAppSwitcher()
            break
        case "next":
            selectNextClient()
            break
        case "previous":
            selectPreviousClient()
            break
        case "confirm":
            executeSelectedAndClose()
            break
    }
}

function showAppSwitcher() {
    const clients = hyprland.get_clients()

    const sortedClients = [...clients].sort((a, b) => {
        const posA = mruAddresses.indexOf(a.get_address())
        const posB = mruAddresses.indexOf(b.get_address())
        return (posA === -1 ? 9999 : posA) - (posB === -1 ? 9999 : posB)
    })

    setDisplayedClients(sortedClients)
    setSelectedAddress(sortedClients.length > 0 ? sortedClients[0].get_address() : null)
    setVisibility(true)
}

function hideAppSwitcher() {
    setVisibility(false)
}

function selectNextClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx + 1) % clients.length].get_address())
}

function selectPreviousClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx - 1 + clients.length) % clients.length].get_address())
}

function executeSelectedAndClose() {
    const clients = displayedClients()
    const selected = clients.find(c => c.get_address() === selectedAddress())
    if (selected) selected.focus()
    setVisibility(false)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function AppSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            css={primaryColor((hex: string) => `--primary: ${hex};`)}
            visible={isVisible}
            name="ags-app-switcher"
            class={conf.as((conf: any) => `AppSwitcher theme-${conf.theme}`)}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
        >
            <Windows />
        </window>
    )
}

function Windows() {
    return (
        <centerbox class="app-switch-menu">
            <box $type="center" class="app-switch-container" spacing={4}>
                <For each={displayedClients}>
                    {(client) => <WindowPreview client={client} />}
                </For>
            </box>
        </centerbox>
    )
}

export function WindowPreview({ client }: { client: any }) {
    if (!client) return null

    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    // Re-capture every time the switcher opens.
    // captureWindowToTexture() is queued so concurrent calls don't pile up.
    createEffect(() => {
        if (!isVisible()) return
        captureWindowToTexture(address).then(t => {
            if (t) setTexture(t)
        })
    })

    const titleBinding = createBinding(client, "title")

    const container = (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={8}
            class="window-preview"
        >
            <scrolledwindow
                hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
            >
                <box>
                    <AppIcon client={client} />
                    <label label={titleBinding} />
                </box>
            </scrolledwindow>

            <Gtk.ScrolledWindow
                class="window-preview-container"
                overflow={Gtk.Overflow.HIDDEN}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
                heightRequest={160}
                propagateNaturalWidth={true}
            >
                <Gtk.Picture
                    canShrink={true}
                    contentFit={Gtk.ContentFit.CONTAIN}
                    heightRequest={150}
                    widthRequest={-1}
                    paintable={texture}
                />
            </Gtk.ScrolledWindow>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedAddress() === address) {
            container.add_css_class("selected")
        } else {
            container.remove_css_class("selected")
        }
    })

    return container
}

import GioUnix from "gi://GioUnix"

export function AppIcon({ client }: { client: any }) {
    if (!client) return null
    const initClass = client.get_class()
    const entry = initClass + ".desktop"
    const appInfo = GioUnix.DesktopAppInfo.new(entry)
    const icon = appInfo?.get_icon()?.to_string() ?? initClass

    return (
        <Gtk.Image
            iconName={icon}
            pixelSize={24}
            class="switcher-preview-icon"
        />
    )
}
