import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { destroyWindow, remeasureOn } from "../monitors"
import { createBinding, createComputed, onCleanup } from "ags"

import Battery from "gi://AstalBattery"
import Network from "gi://AstalNetwork"
import Notifd from "gi://AstalNotifd"

import SystemMenu, { systemMenuOpen, closeSystemMenu } from "./SystemMenu/SystemMenu"
import { closeNc } from "../Notifications/NotificationCenter"
import Island from "../Island/Island"
import PowerMenu from "./PowerMenu"
import Tray, { hasTrayItems } from "./Tray"
import { conf } from "../config"
import { network, wifiProperty } from "../services/network"
import { Icon, iconTheme, wifiIcon } from "../iconNames"
import { themeClasses, LAYER } from "../services/theme"
import { minuteNow } from "../services/minuteClock"

const battery = Battery.get_default()
// the current Network, not the first one (services/network.ts)
const wiredBinding = network.as(n => n.wired)
const wifiStateBinding = wifiProperty("state", Network.DeviceState.UNAVAILABLE)
const activeAPBinding = wifiProperty<Network.AccessPoint | null>("activeAccessPoint", null)

const hasBattery = battery.get_is_present()
const dontDisturb = createBinding(Notifd.get_default(), "dont-disturb")

const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

const windowCss = conf.as(
    (conf) => `--primary: ${conf.primary_color}; --bar-margin: ${conf.bar_margin}px;`
)

const windowClass = themeClasses(t => `Bar ${t}`)

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
            namespace={LAYER.panel}
            css={windowCss}
            visible={hasTrayItems}
            name="ags-bar-tray"
            class={windowClass}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={TOP | LEFT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                onCleanup(() => destroyWindow(self))
                remeasureOn(self, () => `${conf().bar_margin}`)
            }}
        >
            <Tray />
        </window>,

        <Island gdkmonitor={gdkmonitor} />,

        <window
            namespace={LAYER.panel}
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
                // the time alone takes less room than the date and time
                remeasureOn(self, () => `${conf().bar_margin}|${conf().island?.center === "date"}`)
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
    // formatted in-process — no `date` spawn every second. With the date in
    // the island, the weekday short and the time.
    const time = createComputed(get => get(minuteNow).format(
        get(conf).island?.center === "date" ? "%a %H:%M" : "%a %b %d  %H:%M") ?? "")

    return (
        <box class="MenuButtons">
            <menubutton class="toggle-powermenu">
                <box class="icons">
                    <QuietIcon />
                    <PreferencesIcon />
                    {network.get().wifi && <NetworkIcon />}
                    <BatteryIcon />
                </box>
                <SystemMenu />
            </menubutton>
            <button class="toggle-nc" onclicked={toggleNc} $={(self) => onToggleNcReady(self)}>
                <label class={conf(c => c.island?.center === "date" ? "time only" : "time")} label={time} />
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

// Do Not Disturb on, for as long as it is, as a Mac's menu bar shows a Focus:
// otherwise nothing said the banners were being held back
function QuietIcon() {
    return (
        <Gtk.Image
            visible={dontDisturb}
            class="quietIcon"
            pixelSize={16}
            iconName="notifications-disabled-symbolic"
        />
    )
}

function NetworkIcon() {
    return (
        <Gtk.Image
            class="networkIcon"
            iconSize={Gtk.IconSize.NORMAL}
            // the cable's state and the signal's strength change on their own
            // objects, which are followed too
            iconName={createComputed((get) => {
                const wired = get(wiredBinding)
                const ap = get(activeAPBinding)
                return networkIcon(
                    wired ? get(createBinding(wired, "state")) : null,
                    get(wifiStateBinding),
                    ap ? get(createBinding(ap, "strength")) : null,
                )
            })}
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

function networkIcon(wiredState: number | null, wifiState: number, strength: number | null) {

    if (wiredState === Network.DeviceState.ACTIVATED) {
        return "network-wired-activated-symbolic"
    }
    if (
        wifiState === Network.DeviceState.UNAVAILABLE ||
        wifiState === Network.DeviceState.UNMANAGED
    ) {
        return "network-wireless-disabled-symbolic"
    }
    if (wifiState === Network.DeviceState.ACTIVATED) {
        return strength !== null
            ? wifiIcon(strength)
            : "network-wireless-signal-none-symbolic"
    }
    return "network-wireless-signal-none-symbolic"
}