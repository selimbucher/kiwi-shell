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

import { primaryColor } from "../../config"
import { Icon } from "../../iconNames"
import { playSound } from "../../sound"

const battery = AstalBattery.get_default()
const hasBattery = battery.get_is_present()

const batPercentBinding = createBinding(battery, "percentage");
const batChargingBinding = createBinding(battery, "charging");

if (hasBattery) {
  batChargingBinding.subscribe(() => {
    if (!battery.charging) { return }
    playSound('charging.mp3') 
  })
}



// Expose active tab state so other modules can react to it (e.g., Bar popover open)
const [systemMenuOpen, setSystemMenuOpen] = createState(false)

const [activeTab, setActiveTab] = createState(0)

export const systemTabOpen = createComputed(get => {
  return get(activeTab) === 0 && get(systemMenuOpen)
})

export const bluetoothTabOpen = createComputed(get => {
  print("Active tab:", get(activeTab), "System menu open:", get(systemMenuOpen))
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
      autohide={true}
      onShow={() => {
        setSystemMenuOpen(true)
        if (activeTab.get() === 1) {
          rescanWifi()
        }
        if (activeTab.get() === 2) {
          try{
            startBluetoothDiscovery()
            console.log("Started Bluetooth Discovery")
          } catch {}
          
        }
      }}
      onClosed={() => {
        setSystemMenuOpen(false)
        try {
          stopBluetoothDiscovery()
          console.log("Stopped Bluetooth Discovery")
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
              console.log("Started Bluetooth Discovery")
            } catch {}
          } else {
            try {
              stopBluetoothDiscovery()
              console.log("Stopped Bluetooth Discovery")
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
                />
                <CircularProgress progress={batPercentBinding} size={64} lineWidth={7} color={createComputed(get => batteryBarColor(get(batPercentBinding), get(batChargingBinding), get(primaryColor)))}/>
              </overlay>
        </box>
        
        <box class="tab-bar" halign={Gtk.Align.CENTER} hexpand={false} spacing={6}>
          {tabs.map((tab, i) => TabButton(i, tab))}
        </box>
        <box class="tab-container" hexpand={true}>
          <SystemTab visible={activeTab(t => t === 0)} />
          <NetworkTab visible={activeTab(t => t === 1)} />
          <BluetoothTab visible={activeTab(t => t === 2)} />
          <PerformanceTab visible={activeTab(t => false)} />
          <ThemeTab visible={activeTab(t => t === 4)}/>      
        </box>
      </box>
    )
}

function batteryBarColor(percentage, isCharging, primaryColor){
  if (isCharging) {
    return "#4bd452"
  }
  if (percentage <= 0.1) {
    return "#ec4a34"
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



