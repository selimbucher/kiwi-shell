import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createPoll } from "ags/time"
import { createBinding, createComputed, onCleanup } from "ags"

import Battery from "gi://AstalBattery"
import Network from "gi://AstalNetwork"

import SystemMenu, { systemMenuTabState } from "./SystemMenu/SystemMenu"
import Workspaces from "./Workspaces"
import PowerMenu from "./PowerMenu"
import Tray from "./Tray"
import { conf } from "../config"
import { Icon, iconTheme, wifiIcon } from "../iconNames"

const battery = Battery.get_default()
const network = Network.get_default()
const wifi = network.wifi
// New bindings reused in computed (avoid recreating each poll)
const wiredBinding = createBinding(network, "wired")
const wifiStateBinding = createBinding(wifi, "state")
const activeAPBinding = createBinding(wifi, "activeAccessPoint")

const hasBattery = battery.get_is_present()

export default function Bar({  gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {

  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  return (
    <window
      css={conf.as(conf => 
        `
        --primary: ${conf.primary_color};
        --bar-margin: ${conf.bar_margin}px;
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
      $={(self) => onCleanup(() => self.destroy())}

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
        <SystemMenu />
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
    <Icon 
      class="preferencesIcon"
      pixelSize={iconTheme.as(theme => theme.includes("WhiteSur") || theme.includes("Fluent") || theme.includes("Reversal") ? 11 : 16)}
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
    if (activeAP) {
      return wifiIcon(activeAP.strength)
    } else {
      return "network-wireless-signal-none-symbolic"
    }
  }

  return "network-wireless-signal-none-symbolic"
}