import { exec, execAsync } from "ags/process"
import { exitSession } from "../hypr"
import { openChoicePrompt } from "./prompts"

// ─── Power ────────────────────────────────────────────────────────────────────
// What the power menu and Spotlight's actions do, the same from either.

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

// Run and not waited for: these return when what they start is over (the
// lock screen once unlocked, sleep once woken), and the shell must not stand
// still meanwhile — notifications, Bluetooth and the compositor's events would
// all wait on it.
const run = (command: string) => () => {
  execAsync(command).catch(e => console.error(`${command}:`, e))
}

// systemctl sleep is whatever logind's SleepOperation resolves to:
// suspend-then-hibernate where hibernation exists, plain suspend elsewhere.
// Where it exists the bed also offers hibernating right away, sealed now
// instead of after the delay.
export const sleep = () => {
  if (!canHibernate) return run("systemctl sleep")()
  openChoicePrompt("Sleep",
    "Sleep keeps everything in memory and wakes instantly. Hibernate powers off and wakes in a few seconds with the security key.",
    [
      { label: "Hibernate", run: run("systemctl hibernate") },
      { label: "Sleep", primary: true, run: run("systemctl sleep") },
    ])
}

export const lock = run("hyprlock")
export const shutDown = confirmed("Shut Down", "Shut down the computer?", "Shut Down", run("poweroff"))
export const restart = confirmed("Restart", "Restart the computer?", "Restart", run("reboot"))
export const logOut = confirmed("Log Out", "End the session? Unsaved work in open apps is lost.", "Log Out", exitSession)
