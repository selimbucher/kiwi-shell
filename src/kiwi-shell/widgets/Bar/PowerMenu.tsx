import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"

import { primaryColor } from "../config"
import { exec } from "ags/process"
import { exitSession } from "../../hypr"

import { openChoicePrompt } from "../prompts"

// logind knows whether this machine can hibernate (a swap area that holds
// RAM); asked once at start
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

// the destructive ones ask first; Enter is the verb, Escape backs out
const confirmed = (title: string, text: string, verb: string, run: () => unknown) => () =>
  openChoicePrompt(title, text, [{ label: verb, primary: true, run }])

// systemctl sleep is whatever logind's SleepOperation resolves to:
// suspend-then-hibernate where hibernation exists, plain suspend elsewhere.
// Where it exists the bed also offers hibernating right away, sealed now
// instead of after the delay.
const sleep = () => {
  if (!canHibernate) {
    exec("systemctl sleep")
    return
  }
  openChoicePrompt("Sleep",
    "Sleep keeps everything in memory and wakes instantly. Hibernate powers off and wakes in a few seconds with the security key.",
    [
      { label: "Hibernate", run: () => exec("systemctl hibernate") },
      { label: "Sleep", primary: true, run: () => exec("systemctl sleep") },
    ])
}

const buttons = [
  { name: "shutdown", icon: "system-shutdown-symbolic", exec: confirmed("Shut Down", "Shut down the computer?", "Shut Down", () => exec("poweroff")) },
  { name: "reboot", icon: "system-reboot-symbolic", exec: confirmed("Restart", "Restart the computer?", "Restart", () => exec("reboot")) },
  { name: "sleep", icon: "bed-symbolic", exec: sleep },
  { name: "lock", icon: "object-locked-symbolic", exec: "hyprlock" },
  { name: "exit", icon: "exit-symbolic", exec: confirmed("Log Out", "End the session? Unsaved work in open apps is lost.", "Log Out", exitSession) },
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