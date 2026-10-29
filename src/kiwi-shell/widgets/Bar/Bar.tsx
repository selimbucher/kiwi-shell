import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { destroyWindow, keyboardWhileOpen, remeasureOn } from "../monitors"
import { createBinding, createComputed, onCleanup } from "ags"

import { battery } from "../services/battery"
import Network from "gi://AstalNetwork"
import Notifd from "gi://AstalNotifd"

import SystemMenu, { systemMenuOpen, closeSystemMenu } from "./SystemMenu/SystemMenu"
import { closeNc } from "../Notifications/NotificationCenter"
import Island from "../Island/Island"
import PowerMenu from "./PowerMenu"
import { toggleLauncher } from "../Launcher/Launcher"
import Tray, { hasTrayItems } from "./Tray"
import { conf } from "../config"
import { network, wifiProperty } from "../services/network"
import { Icon, iconTheme, wifiIcon } from "../iconNames"
import { themeClasses, LAYER } from "../services/theme"
import { minuteNow, twelveHours, clockTime } from "../services/minuteClock"

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
    const time = createComputed(get => {
        const t = get(minuteNow)
        get(twelveHours)
        return `${t.format(get(conf).island?.center === "date" ? "%a" : "%a %b %d ")} ${clockTime(t)}`
    })

    return (
        <box class="MenuButtons">
            {/* Spotlight for the pointer too, as macOS has it in its menu
                bar: a key alone (Super) left no way in without the keyboard,
                and with it none to an app not in the dock */}
            <button class="powermenu-toggle spotlight-toggle" tooltipText="Spotlight: search apps, windows and the web"
                onClicked={toggleLauncher}>
                <Gtk.Image iconName="system-search-symbolic" pixelSize={14} />
            </button>
            <menubutton class="toggle-powermenu" tooltipText="Control Center">
                <box class="icons">
                    <QuietIcon />
                    <PreferencesIcon />
                    <NetworkIcon />
                    <BatteryIcon />
                </box>
                <SystemMenu />
            </menubutton>
            <button class="toggle-nc" onclicked={toggleNc} $={(self) => onToggleNcReady(self)}
                tooltipText={minuteNow(now => `${now.format("%A, %e %B %Y")?.replace(/\s+/g, " ")}\nClick for notifications`)}>
                <label class={conf(c => c.island?.center === "date" ? "time only" : "time")} label={time} />
            </button>
            <menubutton class={"powermenu-toggle"} tooltipText="Shut Down, Restart, Sleep…">
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
                    $={(self: Gtk.Popover) => keyboardWhileOpen(self)}
                >
                    <PowerMenu />
                </popover>
            </menubutton>
        </box>
    )
}

// "2:05" for 7500 s; nothing for an estimate UPower doesn't have yet
const duration = (seconds: number) =>
    seconds > 0 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}` : ""

function BatteryIcon() {
    // the level and how long it lasts, under the pointer: the icon alone says
    // neither to the minute
    const tooltip = createComputed(get => {
        const percent = `${Math.round(get(createBinding(battery, "percentage")) * 100)}%`
        if (get(createBinding(battery, "charging"))) {
            const full = duration(get(createBinding(battery, "timeToFull")))
            return full ? `${percent}, full in ${full}` : `${percent}, charging`
        }
        const left = duration(get(createBinding(battery, "timeToEmpty")))
        return left ? `${percent}, ${left} left` : percent
    })
    return (
        <Gtk.Image
            visible={hasBattery}
            class="batteryIcon"
            pixelSize={16}
            tooltipText={tooltip}
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

// With Wi-Fi, its signal; with a cable alone (a desktop on Ethernet),
// whether the cable is connected; with neither, nothing. Followed, since
// NetworkManager can come back with other devices (a USB Wi-Fi stick).
function NetworkIcon() {
    return (
        <Gtk.Image
            class="networkIcon"
            visible={network(n => !!(n.wifi || n.wired))}
            iconSize={Gtk.IconSize.NORMAL}
            // the cable's state and the signal's strength change on their own
            // objects, which are followed too
            iconName={createComputed((get) => {
                const wired = get(wiredBinding)
                const ap = get(activeAPBinding)
                return networkIcon(
                    wired ? get(createBinding(wired, "state")) : null,
                    get(network).wifi ? get(wifiStateBinding) : null,
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

function networkIcon(wiredState: number | null, wifiState: number | null, strength: number | null) {

    if (wiredState === Network.DeviceState.ACTIVATED) {
        return "network-wired-activated-symbolic"
    }
    // no Wi-Fi at all: the cable's
    if (wifiState === null) return "network-wired-disconnected-symbolic"
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