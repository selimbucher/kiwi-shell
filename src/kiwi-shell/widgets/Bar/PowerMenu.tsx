import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"

import { primaryColor } from "../config"
import { shutDown, restart, sleep, lock, logOut } from "../power"

const buttons = [
  { name: "shutdown", icon: "system-shutdown-symbolic", exec: shutDown },
  { name: "reboot", icon: "system-reboot-symbolic", exec: restart },
  { name: "sleep", icon: "bed-symbolic", exec: sleep },
  { name: "lock", icon: "object-locked-symbolic", exec: lock },
  { name: "exit", icon: "exit-symbolic", exec: logOut },
]

function PowerButton(icon: string, command: () => unknown) {
  return (
    <button onClicked={() => command()}>
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