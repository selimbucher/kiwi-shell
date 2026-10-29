import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState, createBinding, createComputed, createRoot, onCleanup } from "ags"
import { battery } from "../../services/battery"

import { CircularProgress } from "../../Misc"

import SystemTab from "./tabs/SystemTab"
import NetworkTab, { rescanWifi } from "./tabs/NetworkTab"
import { setHardwarePolling } from "./tabs/hardwarePolling"
import ThemeTab from "./tabs/ThemeTab"
import PerformanceTab from "./tabs/PerformanceTab"

import { conf } from "../../config"
import { minuteNow, twelveHours, clockTime } from "../../services/minuteClock"
import { Icon } from "../../iconNames"
import { playSound } from "../../sound"
import { closeNc } from "../../Notifications/NotificationCenter"
import { keyboardWhileOpen } from "../../monitors"
import { debugMode, logger } from "../../../log"
const log = logger("system-menu")

import BluetoothTab from "./tabs/BluetoothTab"
import {
  hasAdapter,
  startBluetoothDiscovery,
  stopBluetoothDiscovery,
} from "./tabs/BluetoothTab"
import { notify, closeNotification } from "../../../notify"
import { network } from "../../services/network"

// whether the machine has Wi-Fi, and Bluetooth, now: a USB adapter plugged
// in, or NetworkManager and bluez starting after the shell, bring them later
const hasWifi = createComputed((get) => !!get(network).wifi)

const hasBattery = battery.get_is_present()

const batPercent = createBinding(battery, "percentage")
const batCharging = createBinding(battery, "charging")

// The charger plugged in: UPower's OnBattery going false. Charging alone
// also comes and goes with a charge limit and on resume, and played it unasked.
if (hasBattery) {
  try {
    Gio.DBus.system.signal_subscribe("org.freedesktop.UPower", "org.freedesktop.DBus.Properties",
      "PropertiesChanged", "/org/freedesktop/UPower", "org.freedesktop.UPower", Gio.DBusSignalFlags.NONE,
      (_c, _sender, _path, _iface, _signal, params) => {
        const [, changed] = params.deep_unpack() as [string, Record<string, GLib.Variant>]
        if (changed.OnBattery?.unpack() === false) playSound("charging.mp3")
      })
  } catch (e) {
    log.warn("no charger sound without the system bus:", e as Error)
  }
}

// Low/critical battery notifications: warn once at 10%, alert once at 5%
// (critical urgency stays on screen until dismissed). Charging takes them
// away again, and re-arms them.
const BAT_WARN = 0.10
const BAT_CRITICAL = 0.05

if (hasBattery) {
  let warnedLow = false
  let warnedCritical = false
  const shown: number[] = []

  const checkBattery = () => {
    if (battery.charging) {
      warnedLow = false
      warnedCritical = false
      shown.splice(0).forEach(closeNotification)
      return
    }
    const p = battery.percentage
    const pct = `${Math.round(p * 100)}%`
    if (p <= BAT_CRITICAL && !warnedCritical) {
      warnedCritical = true
      notify("Battery critically low", `${pct} remaining — connect the charger now`,
        { app: "Battery", icon: "battery-caution-symbolic", urgency: 2, shown: id => shown.push(id) })
    } else if (p <= BAT_WARN && !warnedLow) {
      warnedLow = true
      notify("Battery low", `${pct} remaining`, { app: "Battery", icon: "battery-low-symbolic", shown: id => shown.push(id) })
    }
  }

  batPercent.subscribe(checkBattery)
  batCharging.subscribe(checkBattery)
}

// one per bar, each display's: the one open is whichever that is
const systemMenuPopovers = new Set<Gtk.Popover>()

export function closeSystemMenu() {
  for (const popover of systemMenuPopovers) popover.popdown()
}

// Expose active tab state so other modules can react to it (e.g., Bar popover open)
export const [systemMenuOpen, setSystemMenuOpen] = createState(false)

const [activeTab, setActiveTab] = createState(0)

export const systemTabOpen = createComputed((get) => {
  return get(activeTab) === 0 && get(systemMenuOpen)
})

export const bluetoothTabOpen = createComputed((get) => {
  return get(activeTab) === 2 && get(systemMenuOpen)
})

// hardware gauges poll only while they are actually on screen
const performanceTabOpen = createComputed((get) => {
  return get(activeTab) === 3 && get(systemMenuOpen)
})
performanceTabOpen.subscribe(() =>
  setHardwarePolling(performanceTabOpen.get()),
)

const tabs = [
  { name: "settings", title: "General", icon: "system-settings-symbolic", enabled: true },
  { name: "network", title: "Wi-Fi", icon: "network-wireless-symbolic", enabled: hasWifi },
  {
    name: "bluetooth",
    title: "Bluetooth",
    icon: "bluetooth-active-symbolic",
    enabled: hasAdapter,
  },
  {
    name: "performance",
    title: "Performance",
    icon: "power-profile-balanced-symbolic",
    enabled: true,
  },
  {
    name: "theme",
    title: "Wallpaper & Style",
    icon: "preferences-desktop-wallpaper-symbolic",
    enabled: true,
  },
]
// a tab whose hardware went (a dongle pulled out) gives way to the first
for (const tab of tabs) {
  if (typeof tab.enabled === "boolean") continue
  const index = tabs.indexOf(tab)
  tab.enabled.subscribe(() => {
    if (!(tab.enabled as typeof hasWifi).get() && activeTab.get() === index) setActiveTab(0)
  })
}

export default function SystemMenu() {
  return (
    <popover
      hasArrow={false}
      class="system-menu-popover"
      autohide={debugMode((b) => !b)}
      $={(self: Gtk.Popover) => {
        systemMenuPopovers.add(self)
        keyboardWhileOpen(self)
        // Built a moment after the shell is up, or at a first opening that
        // comes sooner: its five tabs, wallpaper pictures and all, took a
        // tenth of a second of every start, on every display.
        let dispose: (() => void) | null = null
        const build = () => {
          if (dispose) return
          createRoot((done) => {
            dispose = done
            self.set_child(<SystemMenuContent /> as Gtk.Widget)
          })
        }
        let soon = GLib.timeout_add(GLib.PRIORITY_LOW, BUILD_AFTER_MS, () => {
          soon = 0
          build()
          return GLib.SOURCE_REMOVE
        })
        self.connect("show", build)
        onCleanup(() => {
          systemMenuPopovers.delete(self)
          if (soon) GLib.source_remove(soon)
          dispose?.()
        })
      }}
      onShow={() => {
        setSystemMenuOpen(true)
        closeNc()
        if (activeTab.get() === 1) {
          rescanWifi()
        }
        if (activeTab.get() === 2) {
          try {
            startBluetoothDiscovery()
          } catch {}
        }
      }}
      onClosed={() => {
        setSystemMenuOpen(false)
        try {
          stopBluetoothDiscovery()
        } catch {}
        // opened again on General, as macOS's Control Center is: from the
        // Wi-Fi icon it came up on whatever tab was last, the wallpapers say
        setActiveTab(0)
      }}
    />
  )
}

const BUILD_AFTER_MS = 2500

function SystemMenuContent() {
  const TabButton = (index: number, tab: (typeof tabs)[0]) => (
    <button
      class={activeTab((t) =>
        t === index ? "tab-button active" : "tab-button",
      )}
      visible={tab.enabled}
      tooltipText={tab.title}
      onClicked={() => {
        setActiveTab(index)
        if (hasAdapter.get() && index == 2) {
          try {
            startBluetoothDiscovery()
          } catch {}
        } else {
          try {
            stopBluetoothDiscovery()
          } catch (err) {}
        }
        if (hasWifi.get() && index == 1) {
          rescanWifi()
        }
      }}
    >
      <Icon class={`icon-${tab.name}`} pixelSize={16} iconName={tab.icon} />
    </button>
  )

  return (
    <box class="system-menu" orientation={Gtk.Orientation.VERTICAL}>
      <box class="main-box">
        <Time />
        <box hexpand={true} />
        <overlay visible={hasBattery}>
          <Icon
            $type="overlay"
            pixelSize={24}
            iconName="preferences-system-power-symbolic"
            visible={batCharging}
          />
          <box
            $type="overlay"
            visible={batCharging((b) => !b)}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            class={batPercent(
              (p) => "system-percentage" + (p == 1 ? " full" : ""),
            )}
          >
            <label
              class="percent-value"
              label={batPercent((p) => `${Math.floor(p * 100)}`)}
            />
            <label class="percent-symbol" valign={Gtk.Align.END} label="%" />
          </box>

          <CircularProgress
            progress={batPercent}
            size={64}
            lineWidth={7}
            color={createComputed((get) =>
              batteryBarColor(
                get(batPercent),
                get(batCharging),
                get(conf).primary_color,
              ),
            )}
          />
        </overlay>
      </box>

      <box
        class="tab-bar"
        halign={Gtk.Align.CENTER}
        hexpand={false}
        spacing={6}
      >
        {tabs.map((tab, i) => TabButton(i, tab))}
      </box>
      <box class="tab-container" hexpand={true}>
        <SystemTab visible={activeTab((t) => t === 0)} />
        <NetworkTab visible={activeTab((t) => t === 1)} />
        <BluetoothTab visible={activeTab((t) => t === 2)} />
        <PerformanceTab visible={activeTab((t) => t === 3)} />
        <ThemeTab visible={activeTab((t) => t === 4)} />
      </box>
    </box>
  )
}

function batteryBarColor(percentage, isCharging, primaryColor) {
  if (isCharging) {
    return primaryColor
  }
  if (percentage <= 0.1) {
    return "#ee5a46"
  }
  if (percentage <= 0.2) {
    return "#d6be5dff"
  }
  return primaryColor
}

function Time() {
  // formatted in-process — no `date` spawn every second
  // (the big clock without its AM or PM, as a phone's lock screen has it)
  const time = createComputed(get => { get(twelveHours); return clockTime(get(minuteNow), false) })
  return (
    <box class="time">
      <label label={time} />
    </box>
  )
}
