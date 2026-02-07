import { Gtk } from "ags/gtk4"
import { createState, createBinding, createComputed } from "ags"
import { createPoll } from "ags/time"
import AstalBattery from "gi://AstalBattery"

import { CircularProgress } from "./Misc"

import SystemTab from "./SystemTab"
import NetworkTab from "./NetworkTab"
import BluetoothTab from "./BluetoothTab"
import ThemeTab from "./ThemeTab"
import PerformanceTab from "./PerformanceTab"

import { startBluetoothDiscovery, stopBluetoothDiscovery } from "./BluetoothTab"
import { rescanWifi } from "./NetworkTab"

import { primaryColor } from "./colors"

const battery = AstalBattery.get_default()

const batPercentBinding = createBinding(battery, "percentage");
const batChargingBinding = createBinding(battery, "charging");


// Expose active tab state so other modules can react to it (e.g., Bar popover open)
export const systemMenuTabState = createState(0)

// Define your tabs
const tabs = [
  { name: "settings", icon: "prefs-tweaks-symbolic" },
  { name: "network", icon: "network-wireless-symbolic" },
  { name: "bluetooth", icon: "bluetooth-active-symbolic" },
  { name: "performance", icon: "power-profile-performance-symbolic" },
  { name: "theme", icon: "image-round-symbolic" }
]

export default function SystemMenu() {
    // Use the shared state instead of a local state
    const [activeTab, setActiveTab] = systemMenuTabState

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
        <Gtk.Image 
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
              <overlay>
                <Gtk.Image 
                  $type="overlay"
                  pixelSize={24}
                  iconName="mintupdate-type-kernel-symbolic"
                />
                <CircularProgress progress={batPercentBinding} size={64} lineWidth={7} color={createComputed(get => batteryBarColor(get(batPercentBinding), get(batChargingBinding), get(primaryColor)))}/>
              </overlay>
        </box>
        
        <box class="tab-bar" halign={Gtk.Align.CENTER} hexpand={false}>
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



