import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import SystemMenu, { systemMenuTabState } from "./SystemMenu"
import { createPoll } from "ags/time"
import Workspaces from "./Workspaces"
import { createBinding, createComputed } from "ags"
import PowerMenu from "./PowerMenu"

import Battery from "gi://AstalBattery"
import Network from "gi://AstalNetwork"

import { stopBluetoothDiscovery, startBluetoothDiscovery } from "./BluetoothTab"
import { rescanWifi } from "./NetworkTab"
import Tray from "./Tray"
import { conf } from "./config"

const battery = Battery.get_default()
const network = Network.get_default()
const wifi = network.wifi
// New bindings reused in computed (avoid recreating each poll)
const wiredBinding = createBinding(network, "wired")
const wifiStateBinding = createBinding(wifi, "state")
const activeAPBinding = createBinding(wifi, "activeAccessPoint")

const hasBattery = battery.get_is_present()

export default function Bar(gdkmonitor: Gdk.Monitor) {

  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  return (
    <window
      css={conf.as(conf => 
        `
        --primary: ${conf.primary_color};
        --bar-bottom-margin: ${conf.bottom_margin}px;
        `
      )}
      visible
      name="ags-bar"
      class={conf.as(conf => `Bar theme-${conf.theme}`)}
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT | RIGHT}
      application={app}
      layer={Astal.Layer.TOP}

    >
      <centerbox class="centerbox">
        <Tray $type="start"/>
        <Workspaces $type="center"/>
        <MenuButtons $type="end" />
      </centerbox>
    </window>
  )
}

function MenuButtons() {
  const time = createPoll("", 1000, "date '+%a %b %d  %H:%M'")

  return (
    <box class="MenuButtons">
      <menubutton class="toggle-powermenu">
        <box class="icons">
          <PreferencesIcon />
          <NetworkIcon />
          <BatteryIcon/>
        </box>
        <popover
          hasArrow={false}
          class="system-menu-popover"
          autohide={true}
          onShow={() => {
            const [activeTab] = systemMenuTabState
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
            try {
              stopBluetoothDiscovery()
              console.log("Stopped Bluetooth Discovery")
            } catch {}
            
          }}
        >
          <SystemMenu />
        </popover>
      </menubutton>
      <label class="time" label={time} />
      <menubutton
      class={'powermenu-toggle'}
      >
        <Gtk.Image
        class="power-icon"
          iconName={'system-shutdown-symbolic'}
          pixelSize={14}
        />
        <popover
        class="power-popover"
          hasArrow={false}
          autohide={true}
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
      iconName={
        createComputed(get =>
          networkIcon(
            get(wiredBinding),
            get(wifiStateBinding),
            get(activeAPBinding),
          )
        )
      }
    />
  )
}

function PreferencesIcon() {
  return (
    <Gtk.Image 
      class="preferencesIcon"
      pixelSize={11}
      iconName="tweaks-app-symbolic"
    />
  )
}

// Updated: now uses wifiState + active access point strength
function networkIcon(wired, wifiState, activeAP) {
  if (wired && wired.state === Network.Internet.ACTIVATED) {
    return "am-network-symbolic"
  }

  if (
    wifiState === Network.DeviceState.UNAVAILABLE ||
    wifiState === Network.DeviceState.UNMANAGED
  ) {
    return "network-wireless-disabled-symbolic"
  }

  if (wifiState === Network.DeviceState.ACTIVATED) {
    const strength = activeAP ? activeAP.strength : 0
    if (strength > 80) return "network-wireless-signal-excellent-symbolic"
    if (strength > 60) return "network-wireless-signal-good-symbolic"
    if (strength > 40) return "network-wireless-signal-ok-symbolic"
    if (strength > 20) return "network-wireless-signal-weak-symbolic"
    return "network-wireless-signal-none-symbolic"
  }

  return "network-wireless-signal-none-symbolic"
}