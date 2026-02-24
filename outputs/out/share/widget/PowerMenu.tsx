import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"

import { primaryColor } from "./config"
import { exec } from "ags/process"

const buttons = [
  { name: "shutdown", icon: "system-shutdown-symbolic", exec: "poweroff", confirm: true},
  { name: "reboot", icon: "system-reboot-symbolic", exec: "reboot", confirm: true },
  { name: "sleep", icon: "bed-symbolic", exec: "systemctl sleep", confirm: false },
  { name: "lock", icon: "object-locked-symbolic", exec: "hyprlock", confirm: false },
  { name: "lock", icon: "exit-symbolic", exec: "hyprctl dispatch exit", confirm: false },
]

function PowerButton(icon: string, command: string) {
  return (
    <button
      onClicked={(self) => {
        exec(command)
      }}
    >
      <Gtk.Image
        iconName={icon}
        pixelSize={32}
        />
    </button>
  )
}

export default function PowerMenu(){
  return (
      <box class="PowerMenu"
        spacing={12}
      >
        
        {buttons.map((button) => PowerButton(button.icon, button.exec))}
      </box>
  )
}