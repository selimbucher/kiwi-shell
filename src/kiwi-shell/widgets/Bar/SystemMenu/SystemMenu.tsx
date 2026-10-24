import { Gtk, Gdk } from "ags/gtk4"
import { createState, createBinding, createComputed } from "ags"
import AstalBattery from "gi://AstalBattery"
import AstalPowerProfiles from "gi://AstalPowerProfiles"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"

import { CircularProgress } from "../../Misc"

import SystemTab from "./tabs/SystemTab"
import NetworkTab, { rescanWifi } from "./tabs/NetworkTab"
import { setHardwarePolling } from "./tabs/hardwarePolling"
import ThemeTab from "./tabs/ThemeTab"
import PerformanceTab from "./tabs/PerformanceTab"

import { conf } from "../../config"
import { minuteNow } from "../../services/minuteClock"
import { Icon } from "../../iconNames"
import { playSound } from "../../sound"
import { closeNc } from "../../Notifications/NotificationCenter"
import { debugMode } from "../../../log"

import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import BluetoothTab from "./tabs/BluetoothTab"
import {
  startBluetoothDiscovery,
  stopBluetoothDiscovery,
} from "./tabs/BluetoothTab"
import { notify, closeNotification } from "../../../notify"
import { network } from "../../services/network"

// present when the machine has Wi-Fi at all
const wifi = network.get().wifi

// .adapter is null when no bluetooth controller is present
const bluetooth: AstalBluetooth.Adapter | undefined =
  AstalBluetooth.get_default().adapter ?? undefined

const battery = AstalBattery.get_default()
const hasBattery = battery.get_is_present()

const batPercent = createBinding(battery, "percentage")
const batCharging = createBinding(battery, "charging")

if (hasBattery) {
  batCharging.subscribe(() => {
    if (!battery.charging) {
      return
    }
    playSound("charging.mp3")
  })
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

let systemMenuPopover: Gtk.Popover | null = null

export function closeSystemMenu() {
  systemMenuPopover?.popdown()
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
  { name: "settings", icon: "system-settings-symbolic", enabled: true },
  { name: "network", icon: "network-wireless-symbolic", enabled: wifi },
  {
    name: "bluetooth",
    icon: "bluetooth-active-symbolic",
    enabled: bluetooth,
  },
  {
    name: "performance",
    icon: "power-profile-balanced-symbolic",
    enabled: true,
  },
  {
    name: "theme",
    icon: "preferences-desktop-wallpaper-symbolic",
    enabled: true,
  },
]

export default function SystemMenu() {
  return (
    <popover
      hasArrow={false}
      class="system-menu-popover"
      autohide={debugMode((b) => !b)}
      $={(self) => (systemMenuPopover = self)}
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
      }}
    >
      <SystemMenuContent />
    </popover>
  )
}

function SystemMenuContent() {
  const TabButton = (index: number, tab: (typeof tabs)[0]) => (
    <button
      class={activeTab((t) =>
        t === index ? "tab-button active" : "tab-button",
      )}
      onClicked={() => {
        setActiveTab(index)
        if (bluetooth && index == 2) {
          try {
            startBluetoothDiscovery()
          } catch {}
        } else {
          try {
            stopBluetoothDiscovery()
          } catch (err) {}
        }
        if (wifi && index == 1) {
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
          <box
            $type="overlay"
            orientation={Gtk.Orientation.VERTICAL}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            spacing={2}
          >
            <BatteryGlyph />
            <box
              halign={Gtk.Align.CENTER}
              class={batPercent(
                (p) => "system-percentage" + (p == 1 ? " full" : ""),
              )}
              css={batteryColor((c) => `color: ${c};`)}
            >
              <label
                class="percent-value"
                label={batPercent((p) => `${Math.floor(p * 100)}`)}
              />
              <label class="percent-symbol" valign={Gtk.Align.END} label="%" />
            </box>
          </box>

          <CircularProgress
            progress={batPercent}
            size={64}
            lineWidth={7}
            color={batteryColor}
          />
        </overlay>
      </box>

      <box
        class="tab-bar"
        halign={Gtk.Align.CENTER}
        hexpand={false}
        spacing={6}
      >
        {tabs.map((tab, i) => (tab.enabled ? TabButton(i, tab) : ""))}
      </box>
      <box class="tab-container" hexpand={true}>
        <SystemTab visible={activeTab((t) => t === 0)} />
        {wifi && <NetworkTab visible={activeTab((t) => t === 1)} />}
        {bluetooth && <BluetoothTab visible={activeTab((t) => t === 2)} />}
        <PerformanceTab visible={activeTab((t) => t === 3)} />
        <ThemeTab visible={activeTab((t) => t === 4)} />
      </box>
    </box>
  )
}

// iOS's battery colours (its Batteries widget): green, red from 20% down,
// yellow in Low Power Mode, here the power saver profile; green charging
const BATTERY_GREEN = "#30d158"
const BATTERY_RED = "#ff453a"
const BATTERY_YELLOW = "#ffd60a"

const powerProfiles = AstalPowerProfiles.get_default()
const saving = powerProfiles
  ? createBinding(powerProfiles, "active_profile").as((p) => p === "power-saver")
  : createState(false)[0]

const batteryColor = createComputed((get) => {
  if (get(batCharging)) return BATTERY_GREEN
  if (get(saving)) return BATTERY_YELLOW
  if (get(batPercent) <= 0.2) return BATTERY_RED
  return BATTERY_GREEN
})

// A battery as iOS draws one: a white outline and its cap, filled to the
// charge in the battery's colour, a bolt across it while it charges.
const BOLT = Gsk.Path.parse("M 12.6 1.4 L 7.2 6.9 L 10.6 6.9 L 9.4 10.6 L 14.8 5.1 L 11.4 5.1 Z")

const BatteryGlyphWidget = GObject.registerClass(
  { GTypeName: "KiwiBatteryGlyph" },
  class BatteryGlyphWidget extends Gtk.Widget {
    level = 1
    color = BATTERY_GREEN
    charging = false

    vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
      const size = orientation === Gtk.Orientation.HORIZONTAL ? 24 : 12
      return [size, size, -1, -1]
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
      const white = new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 1 })
      const fill = new Gdk.RGBA()
      fill.parse(this.color)
      const rounded = (x: number, y: number, w: number, h: number, r: number) => {
        const radius = new Graphene.Size().init(r, r)
        return new Gsk.RoundedRect().init(new Graphene.Rect().init(x, y, w, h), radius, radius, radius, radius)
      }
      // the outline, and the cap at its end
      const body = rounded(0.75, 0.75, 20.5, 10.5, 3.2)
      snapshot.append_border(body, [1.5, 1.5, 1.5, 1.5], [white, white, white, white])
      const cap = rounded(22.2, 3.8, 1.8, 4.4, 0.9)
      snapshot.push_rounded_clip(cap)
      snapshot.append_color(new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 0.8 }), cap.bounds)
      snapshot.pop()
      // the charge
      const width = Math.max(0, Math.min(1, this.level)) * 16.5
      if (width > 0) {
        const charge = rounded(2.5, 2.5, width, 7, 1.6)
        snapshot.push_rounded_clip(charge)
        snapshot.append_color(fill, charge.bounds)
        snapshot.pop()
      }
      if (this.charging && BOLT) snapshot.append_fill(BOLT, Gsk.FillRule.WINDING, white)
    }
  },
)

function BatteryGlyph() {
  const glyph = new BatteryGlyphWidget({ halign: Gtk.Align.CENTER })
  const update = () => {
    glyph.level = battery.percentage
    glyph.color = batteryColor.get()
    glyph.charging = battery.charging
    glyph.queue_draw()
  }
  batPercent.subscribe(update)
  batteryColor.subscribe(update)
  batCharging.subscribe(update)
  update()
  return glyph
}

function Time() {
  // formatted in-process — no `date` spawn every second
  const time = minuteNow(t => t.format("%H:%M") ?? "")
  return (
    <box class="time">
      <label label={time} />
    </box>
  )
}
