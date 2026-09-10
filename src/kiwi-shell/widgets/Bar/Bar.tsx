import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { destroyWindow } from "../monitors"
import { createPoll } from "ags/time"
import { createBinding, createComputed, onCleanup } from "ags"

import Battery from "gi://AstalBattery"
import Network from "gi://AstalNetwork"
import GLib from "gi://GLib"

import SystemMenu, { systemMenuOpen, closeSystemMenu } from "./SystemMenu/SystemMenu"
import { closeNc } from "../Notifications/NotificationCenter"
import Workspaces from "./Workspaces"
import PowerMenu from "./PowerMenu"
import Tray from "./Tray"
import { conf } from "../config"
import { Icon, iconTheme, wifiIcon } from "../iconNames"

const battery = Battery.get_default()
const network = Network.get_default()
const wifi = network.wifi
const wiredBinding = createBinding(network, "wired")
const wifiStateBinding = createBinding(wifi, "state")
const activeAPBinding = createBinding(wifi, "activeAccessPoint")

const hasBattery = battery.get_is_present()

const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

const windowCss = conf.as(
    (conf) => `--primary: ${conf.primary_color}; --bar-margin: ${conf.bar_margin}px;`
)
const windowClass = conf.as((conf) => `Bar theme-${conf.theme}`)

export default function Bar({
    gdkmonitor,
    toggleNc,
}: {
    gdkmonitor: Gdk.Monitor
    toggleNc: () => void
}) {
    let toggleNcButton: Gtk.Widget | null = null
    let forcedToggleAt = 0

    // While the system menu popover is open, GTK retargets every click in the
    // bar window to the popover (dismiss + consume), so the clock button never
    // sees it. This capture-phase gesture runs before that retargeting and
    // turns a click on the clock into "close menu, open notification center".
    const guardedToggleNc = () => {
        if (Date.now() - forcedToggleAt < 300) return
        toggleNc()
    }

    return [
        <window
            css={windowCss}
            visible
            name="ags-bar-tray"
            class={windowClass}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={TOP | LEFT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => onCleanup(() => destroyWindow(self))}
        >
            <Tray />
        </window>,

        <window
            css={windowCss}
            visible
            name="ags-bar-workspaces"
            class={windowClass}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={TOP}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => onCleanup(() => destroyWindow(self))}
        >
            <Workspaces />
        </window>,

        <window
            css={windowCss}
            visible
            name="ags-bar-menu"
            class={windowClass}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={RIGHT | TOP}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                click.connect("pressed", (_gesture, _nPress, x, y) => {
                    if (!systemMenuOpen() || !toggleNcButton) return
                    const [ok, bounds] = toggleNcButton.compute_bounds(self)
                    if (!ok) return
                    const inside =
                        x >= bounds.get_x() && x <= bounds.get_x() + bounds.get_width() &&
                        y >= bounds.get_y() && y <= bounds.get_y() + bounds.get_height()
                    if (inside) {
                        forcedToggleAt = Date.now()
                        closeSystemMenu()
                        toggleNc()
                    }
                })
                self.add_controller(click)
                onCleanup(() => destroyWindow(self))
            }}
        >
            <MenuButtons
                toggleNc={guardedToggleNc}
                onToggleNcReady={(w) => { toggleNcButton = w }}
            />
        </window>,
    ]
}

function MenuButtons({ toggleNc, onToggleNcReady }: {
    toggleNc: () => void
    onToggleNcReady: (w: Gtk.Widget) => void
}) {
    // formatted in-process — no `date` spawn every second
    const time = createPoll("", 1000, () =>
        GLib.DateTime.new_now_local().format("%a %b %d  %H:%M") ?? "")

    return (
        <box class="MenuButtons">
            <menubutton class="toggle-powermenu">
                <box class="icons">
                    <PreferencesIcon />
                    {wifi && <NetworkIcon />}
                    <BatteryIcon />
                </box>
                <SystemMenu />
            </menubutton>
            <button class="toggle-nc" onclicked={toggleNc} $={(self) => onToggleNcReady(self)}>
                <label class="time" label={time} />
            </button>
            <menubutton class={"powermenu-toggle"}>
                <Gtk.Image
                    class="power-icon"
                    iconName={"system-shutdown-symbolic"}
                    pixelSize={14}
                />
                <popover
                    class="power-popover"
                    hasArrow={false}
                    autohide={true}
                    onShow={() => closeNc()}
                >
                    <PowerMenu />
                </popover>
            </menubutton>
        </box>
    )
}

function BatteryIcon() {
    return (
        <Gtk.Image
            visible={hasBattery}
            class="batteryIcon"
            pixelSize={16}
            iconName={createBinding(battery, "battery_icon_name")}
        />
    )
}

function NetworkIcon() {
    return (
        <Gtk.Image
            class="networkIcon"
            iconSize={Gtk.IconSize.NORMAL}
            iconName={createComputed((get) =>
                networkIcon(get(wiredBinding), get(wifiStateBinding), get(activeAPBinding))
            )}
        />
    )
}

function PreferencesIcon() {
    return (
        <Icon
            class="preferencesIcon"
            pixelSize={iconTheme.as((theme) =>
                theme.includes("WhiteSur") ||
                theme.includes("Fluent") ||
                theme.includes("Reversal")
                    ? 11
                    : 16,
            )}
            iconName="tweaks-app-symbolic"
        />
    )
}

function networkIcon(wired, wifiState, activeAP) {

    if (wired && wired.state === 100) {
        return "network-wired-activated-symbolic"
    }
    if (
        wifiState === Network.DeviceState.UNAVAILABLE ||
        wifiState === Network.DeviceState.UNMANAGED
    ) {
        return "network-wireless-disabled-symbolic"
    }
    if (wifiState === Network.DeviceState.ACTIVATED) {
        return activeAP
            ? wifiIcon(activeAP.strength)
            : "network-wireless-signal-none-symbolic"
    }
    return "network-wireless-signal-none-symbolic"
}