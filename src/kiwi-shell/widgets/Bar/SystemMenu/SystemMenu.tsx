import { Gtk } from "ags/gtk4"
import { createState, createBinding, createComputed } from "ags"
import { createPoll } from "ags/time"
import AstalBattery from "gi://AstalBattery"

import { CircularProgress } from "../../Misc"

import SystemTab from "./tabs/SystemTab"
import NetworkTab, { rescanWifi } from "./tabs/NetworkTab"
import BluetoothTab from "./tabs/BluetoothTab"
import ThemeTab from "./tabs/ThemeTab"
import PerformanceTab from "./tabs/PerformanceTab"
import { startBluetoothDiscovery, stopBluetoothDiscovery } from "./tabs/BluetoothTab"

import { conf } from "../../config"
import { Icon } from "../../iconNames"
import { playSound } from "../../sound"
import { debug } from "../../../app"

const battery = AstalBattery.get_default()
const hasBattery = battery.get_is_present()

const batPercent = createBinding(battery, "percentage");
const batCharging = createBinding(battery, "charging");

if (hasBattery) {
  batCharging.subscribe(() => {
    if (!battery.charging) { return }
    playSound('charging.mp3') 
  })
}

let systemMenuPopover: Gtk.Popover | null = null

export function closeSystemMenu() {
  systemMenuPopover?.popdown()
}

// Expose active tab state so other modules can react to it (e.g., Bar popover open)
export const [systemMenuOpen, setSystemMenuOpen] = createState(false)

const [activeTab, setActiveTab] = createState(0)

export const systemTabOpen = createComputed(get => {
  return get(activeTab) === 0 && get(systemMenuOpen)
})

export const bluetoothTabOpen = createComputed(get => {
  return get(activeTab) === 2 && get(systemMenuOpen)
})

// Define your tabs
const tabs = [
  { name: "settings", icon: "system-settings-symbolic" },
  { name: "network", icon: "network-wireless-symbolic" },
  { name: "bluetooth", icon: "bluetooth-active-symbolic" },
  { name: "performance", icon: "power-profile-balanced-symbolic" },
  { name: "theme", icon: "preferences-desktop-wallpaper-symbolic" }
]

export default function SystemMenu() {
  return (
    <popover
      hasArrow={false}
      class="system-menu-popover"
      autohide={debug(b => !b)}
      $={self => systemMenuPopover = self}
      onShow={() => {
        setSystemMenuOpen(true)
        if (activeTab.get() === 1) {
          rescanWifi()
        }
        if (activeTab.get() === 2) {
          try{
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

    const TabButton = (index: number, tab: typeof tabs[0]) => (
      <button 
        class={activeTab(t => t === index ? "tab-button active" : "tab-button")}
        onClicked={() => {
          setActiveTab(index)
          if (index == 2) {
            try {
              startBluetoothDiscovery()
            } catch {}
          } else {
            try {
              stopBluetoothDiscovery()
            } catch (err) {}
          }
          if (index == 1) {
            rescanWifi()
          }
        }}
      >
        <Icon
          class={`icon-${tab.name}`}
          pixelSize={16}
          iconName={tab.icon}
        />
      </button>
    )

    return (
      <box class="system-menu" orientation={Gtk.Orientation.VERTICAL}>
        <box class="main-box">
              <Time />
              <box hexpand={true}/>
              <overlay visible={hasBattery}>
                <Icon
                  $type="overlay"
                  pixelSize={24}
                  iconName="preferences-system-power-symbolic"
                  visible={batCharging}
                />
                <box $type="overlay"
                  visible={batCharging(b => !b)}
                  halign={Gtk.Align.CENTER}
                  valign={Gtk.Align.CENTER}
                  class={batPercent(p => "system-percentage" + (p==1 ? " full" : ""))}
                >
                  <label class="percent-value" label={batPercent(p => `${Math.floor(p*100)}`)}
                  />
                  <label class="percent-symbol" valign={Gtk.Align.END} label="%"/>
                </box>
                
                <CircularProgress progress={batPercent} size={64} lineWidth={7} color={createComputed(get => batteryBarColor(get(batPercent), get(batCharging), get(conf).primary_color))}/>
              </overlay>
        </box>
        
        <box class="tab-bar" halign={Gtk.Align.CENTER} hexpand={false} spacing={6}>
          {tabs.map((tab, i) => TabButton(i, tab))}
        </box>
        <box class="tab-container" hexpand={true}>
          <SystemTab visible={activeTab(t => t === 0)} />
          <NetworkTab visible={activeTab(t => t === 1)} />
          <BluetoothTab visible={activeTab(t => t === 2)} />
          <PerformanceTab visible={activeTab(t => t === 3)} />
          <ThemeTab visible={activeTab(t => t === 4)}/>      
        </box>
      </box>
    )
}

function batteryBarColor(percentage, isCharging, primaryColor){
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



function Time(){
  const time = createPoll("9:41", 1000, "date '+%H:%M'")
  return (
    <box class="time">
      <label label={time}/>
    </box>
  )
}



