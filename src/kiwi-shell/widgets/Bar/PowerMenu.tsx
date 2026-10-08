import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"

import { primaryColor } from "../config"
import { exec } from "ags/process"
import { exitSession } from "../../hypr"

// logind knows whether this machine can hibernate (a swap area that holds
// RAM); asked once, the button only exists where the answer is yes
const canHibernate = (() => {
  try {
    return exec([
      "busctl", "call", "org.freedesktop.login1", "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager", "CanHibernate",
    ]).includes('"yes"')
  } catch {
    return false
  }
})()

const buttons = [
  { name: "shutdown", icon: "system-shutdown-symbolic", exec: "poweroff", confirm: true},
  { name: "reboot", icon: "system-reboot-symbolic", exec: "reboot", confirm: true },
  // sleep = whatever logind's SleepOperation resolves to: suspend-then-hibernate
  // where hibernation exists, plain suspend elsewhere
  { name: "sleep", icon: "bed-symbolic", exec: "systemctl sleep", confirm: false },
  // seal it now instead of after the suspend-then-hibernate delay
  ...(canHibernate
    ? [{ name: "hibernate", icon: "system-hibernate-symbolic", exec: "systemctl hibernate", confirm: true }]
    : []),
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