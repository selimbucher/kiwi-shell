import GLib from "gi://GLib"
import { exec, execAsync } from "ags/process"
import { exitSession, hasFeature } from "../hypr"
import { openChoicePrompt } from "./prompts"
import { notify } from "../notify"
import { isLocked } from "./services/screen"

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
    "Sleep keeps everything in memory and wakes instantly. Hibernate saves everything to disk and powers off; it takes a few seconds to wake.",
    [
      { label: "Hibernate", run: run("systemctl hibernate") },
      { label: "Sleep", primary: true, run: run("systemctl sleep") },
    ])
}

// Locked by hyprlock where it is installed; otherwise the session is asked
// to lock (loginctl), which whatever locker the user runs with their idle
// daemon answers. The shell doesn't bring a locker of its own: one without
// the system's login setup (PAM) for it would lock with no way back in.
// Should nothing lock, it says so rather than leave the screen open.
export const lock = () => {
  if (GLib.find_program_in_path("hyprlock")) return run("hyprlock")()
  execAsync(["loginctl", "lock-session"]).catch(e => console.error("loginctl lock-session:", e))
  // (the plugin says when the session is locked, screen.cpp)
  if (!hasFeature("stacking")) return
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
    if (!isLocked())
      notify("The screen didn't lock", "No screen locker answered. Install hyprlock, or set one up with your idle daemon (hypridle's lock_cmd).", { urgency: 2 })
    return GLib.SOURCE_REMOVE
  })
}
export const shutDown = confirmed("Shut Down", "Shut down the computer?", "Shut Down", run("poweroff"))
export const restart = confirmed("Restart", "Restart the computer?", "Restart", run("reboot"))
export const logOut = confirmed("Log Out", "End the session? Unsaved work in open apps is lost.", "Log Out", exitSession)
