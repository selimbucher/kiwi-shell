import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"

import { primaryColor } from "../config"
import { exec } from "ags/process"
import { exitSession } from "../../hypr"

const buttons = [
  { name: "shutdown", icon: "system-shutdown-symbolic", exec: "poweroff", confirm: true},
  { name: "reboot", icon: "system-reboot-symbolic", exec: "reboot", confirm: true },
  { name: "sleep", icon: "bed-symbolic", exec: "systemctl sleep", confirm: false },
  { name: "lock", icon: "object-locked-symbolic", exec: "hyprlock", confirm: false },
  { name: "exit", icon: "exit-symbolic", exec: exitSession, confirm: false },
]

function PowerButton(icon: string, command: string | (() => unknown)) {
  return (
    <button
      onClicked={(self) => {
        if (typeof command === "string") exec(command)
        else command()
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