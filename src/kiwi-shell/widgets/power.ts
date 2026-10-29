import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import { logger } from "../log"
import { exitSession, hasFeature } from "../hypr"
import { openChoicePrompt } from "./prompts"
import { notify } from "../notify"
import { isLocked } from "./services/screen"

// ─── Power ────────────────────────────────────────────────────────────────────
// What the power menu and Spotlight's actions do, the same from either: asked
// of logind (elogind where there is no systemd, the same interface) rather
// than of systemctl, whose verbs come and go with its version (`systemctl
// sleep` is systemd 256's) and which isn't there without systemd.

const log = logger("power")

function login1(method: string, args: GLib.Variant | null = null): Promise<GLib.Variant> {
  return new Promise((resolve, reject) => {
    try {
      // (polkit may ask for a password, as systemctl lets it)
      Gio.DBus.system.call("org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
        method, args, null, Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, null, (bus, result) => {
          try {
            resolve(bus!.call_finish(result))
          } catch (e) {
            reject(e)
          }
        })
    } catch (e) {
      reject(e)
    }
  })
}

const can = (what: string) =>
  login1(`Can${what}`).then(reply => reply.deepUnpack<[string]>()[0] === "yes").catch(() => false)

// whether this machine can hibernate (a swap area that holds RAM): asked once
// at start, and not waited on
let canHibernate = false
void can("Hibernate").then(yes => { canHibernate = yes })

const INTERACTIVE = () => new GLib.Variant("(b)", [true])

// Not waited for: sleep returns once woken, and the shell must not stand
// still meanwhile. What won't happen says so, rather than nothing happening.
const failed = (what: string) => (e: unknown) => {
  log.error(`${what}:`, e as Error)
  if (e instanceof GLib.Error) Gio.DBusError.strip_remote_error(e)
  const reason = e instanceof GLib.Error ? e.message : String(e)
  notify(`Couldn't ${what.toLowerCase()}`, reason, { icon: "dialog-error-symbolic" })
}
const act = (what: string, method: string) => () => { login1(method, INTERACTIVE()).catch(failed(what)) }

// Sleep is whatever logind's SleepOperation resolves to: suspend-then-
// hibernate where hibernation exists, plain suspend elsewhere. Before logind
// had Sleep (256), the same by hand.
const sleepNow = () => {
  login1("Sleep", new GLib.Variant("(t)", [0]))
    .catch(async () => login1(await can("SuspendThenHibernate") ? "SuspendThenHibernate" : "Suspend", INTERACTIVE()))
    .catch(failed("Sleep"))
}

// Where hibernating exists the bed also offers it right away, sealed now
// instead of after the delay.
export const sleep = () => {
  if (!canHibernate) return sleepNow()
  openChoicePrompt("Sleep",
    "Sleep keeps everything in memory and wakes instantly. Hibernate saves everything to disk and powers off; it takes a few seconds to wake.",
    [
      { label: "Hibernate", run: act("Hibernate", "Hibernate") },
      { label: "Sleep", primary: true, run: sleepNow },
    ])
}

// Run and not waited for: the lock screen returns once unlocked.
const run = (command: string) => () => {
  execAsync(command).catch(e => log.error(`${command}:`, e as Error))
}

// the destructive ones ask first; Enter is the verb, Escape backs out
const confirmed = (title: string, text: string, verb: string, run: () => unknown) => () =>
  openChoicePrompt(title, text, [{ label: verb, primary: true, run }])

// Locked by hyprlock where it is installed; otherwise the session is asked
// to lock (loginctl), which whatever locker the user runs with their idle
// daemon answers. The shell doesn't bring a locker of its own: one without
// the system's login setup (PAM) for it would lock with no way back in.
// Should nothing lock, it says so rather than leave the screen open.
export const lock = () => {
  if (GLib.find_program_in_path("hyprlock")) return run("hyprlock")()
  execAsync(["loginctl", "lock-session"]).catch(e => log.error("loginctl lock-session:", e as Error))
  // (the plugin says when the session is locked, screen.cpp)
  if (!hasFeature("stacking")) return
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
    if (!isLocked())
      notify("The screen didn't lock", "No screen locker answered. Install hyprlock, or set one up with your idle daemon (hypridle's lock_cmd).", { urgency: 2 })
    return GLib.SOURCE_REMOVE
  })
}
export const shutDown = confirmed("Shut Down", "Shut down the computer?", "Shut Down", act("Shut Down", "PowerOff"))
export const restart = confirmed("Restart", "Restart the computer?", "Restart", act("Restart", "Reboot"))
export const logOut = confirmed("Log Out", "End the session? Unsaved work in open apps is lost.", "Log Out", exitSession)
