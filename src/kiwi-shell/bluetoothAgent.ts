// BlueZ pairing agent. Astal's Bluetooth lib only wraps Device/Adapter — it
// never registers an org.bluez.Agent1, so with no other agent on the bus
// (blueman, an open bluetoothctl, ...) any pairing that needs an auth step
// dies instantly in bluetoothd with "No agent available for request type N" /
// "device_confirm_passkey: Operation not permitted" before the device gets a
// say. Registering as NoInputNoOutput makes bluez negotiate "just works"
// pairing, which is all a shell without pairing dialogs can honestly offer:
// mice/headphones pair, PIN-entry keyboards still need a real agent.
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalBluetooth from "gi://AstalBluetooth"

import { logger } from "./log"
import { openChoicePrompt } from "./widgets/prompts"
const log = logger("bt-agent")

const AGENT_PATH = "/org/kiwi/bluetooth_agent"

const AGENT_XML = `<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="RequestPinCode">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="pincode" direction="out"/>
    </method>
    <method name="DisplayPinCode">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="pincode" direction="in"/>
    </method>
    <method name="RequestPasskey">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="out"/>
    </method>
    <method name="DisplayPasskey">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="in"/>
      <arg type="q" name="entered" direction="in"/>
    </method>
    <method name="RequestConfirmation">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="in"/>
    </method>
    <method name="RequestAuthorization">
      <arg type="o" name="device" direction="in"/>
    </method>
    <method name="AuthorizeService">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="uuid" direction="in"/>
    </method>
    <method name="Cancel"/>
  </interface>
</node>`

// Who may pair, as on macOS. A pairing the shell started (a device picked in
// the Bluetooth tab) is confirmed without asking: the click was the asking.
// Anything else — a phone pairing with the laptop, which can only happen
// while the tab is open and the laptop can be seen and paired with
// (BluetoothTab) — is put to the user, with the code to compare when there
// is one. A device asking to use a service is let in only once paired and
// trusted. PIN/passkey *entry* is refused — accepting those would mean
// inventing digits the peer expects a human to type, which fails pairing
// anyway but only after a confusing timeout.

// pairings the shell started, by the device's object path
const expected = new Set<string>()

export function expectPairing(path: string) {
  expected.add(path)
}

export function pairingOver(path: string) {
  expected.delete(path)
}

const deviceAt = (path: string): AstalBluetooth.Device | undefined =>
  AstalBluetooth.get_default().devices.find(d => d.get_object_path?.() === path)

function nameOf(path: string): string {
  const device = deviceAt(path)
  return device?.alias || device?.name || path.split("/").pop()?.replace(/^dev_/, "").replace(/_/g, ":") || "A device"
}

// the question on screen for bluez, which it may take back (Cancel)
let withdraw: (() => void) | null = null

function reject(invocation: Gio.DBusMethodInvocation, why: string) {
  invocation.return_dbus_error("org.bluez.Error.Rejected", why)
}

// The user's answer, for a pairing the shell didn't start.
function ask(invocation: Gio.DBusMethodInvocation, device: string, text: string) {
  if (expected.has(device)) {
    invocation.return_value(null)
    return
  }
  withdraw?.()
  const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  log.info("asking whether to pair with", device)
  withdraw = openChoicePrompt("Bluetooth Pairing Request", escape(text), [{
    label: "Pair",
    primary: true,
    run: () => {
      withdraw = null
      invocation.return_value(null)
    },
  }], () => {
    withdraw = null
    reject(invocation, "declined")
  })
}

const agentImpl = {
  Release() {
    log.debug("agent released by bluez")
  },
  RequestPinCodeAsync(_params: unknown[], invocation: Gio.DBusMethodInvocation) {
    invocation.return_dbus_error(
      "org.bluez.Error.Rejected",
      "kiwi-shell has no PIN entry UI",
    )
  },
  DisplayPinCode(_device: string, pincode: string) {
    log.info("peer displays PIN", pincode)
  },
  RequestPasskeyAsync(_params: unknown[], invocation: Gio.DBusMethodInvocation) {
    invocation.return_dbus_error(
      "org.bluez.Error.Rejected",
      "kiwi-shell has no passkey entry UI",
    )
  },
  DisplayPasskey(_device: string, passkey: number, _entered: number) {
    log.info("peer displays passkey", String(passkey).padStart(6, "0"))
  },
  RequestConfirmationAsync([device, passkey]: [string, number], invocation: Gio.DBusMethodInvocation) {
    const code = String(passkey).padStart(6, "0")
    ask(invocation, device, `“${nameOf(device)}” wants to pair with this computer. Make sure it shows the code ${code}.`)
  },
  RequestAuthorizationAsync([device]: [string], invocation: Gio.DBusMethodInvocation) {
    ask(invocation, device, `“${nameOf(device)}” wants to pair with this computer.`)
  },
  AuthorizeServiceAsync([device, uuid]: [string, string], invocation: Gio.DBusMethodInvocation) {
    const known = deviceAt(device)
    if (expected.has(device) || (known?.paired && known?.trusted)) {
      log.debug("authorizing service", uuid, "for", device)
      invocation.return_value(null)
    } else {
      log.info("refusing service", uuid, "for a device not paired and trusted:", device)
      reject(invocation, "not paired")
    }
  },
  Cancel() {
    log.debug("pairing request cancelled by bluez")
    // its question goes, unanswered: bluez has already given up on it
    const close = withdraw
    withdraw = null
    close?.()
  },
}

// Registered with bluez whenever it is there: at start, and again each time
// bluetoothd comes back (a restart, a rebuild touching bluez), which forgets
// its agents — pairing from the shell failed with "No agent available".
// (held here, so the collector never takes it while bluez still calls it)
let exported: Gio.DBusExportedObject | null = null
let watching = 0

function register(bus: Gio.DBusConnection) {
  bus.call(
    "org.bluez",
    "/org/bluez",
    "org.bluez.AgentManager1",
    "RegisterAgent",
    new GLib.Variant("(os)", [AGENT_PATH, "NoInputNoOutput"]),
    null,
    Gio.DBusCallFlags.NONE,
    -1,
    null,
    (_bus, res) => {
      try {
        bus.call_finish(res)
      } catch (err) {
        log.error("RegisterAgent failed:", err)
        return
      }
      // Default agent = the one bluez consults for auth requests it can't
      // route to a per-request agent (i.e. all pairings the shell starts).
      bus.call(
        "org.bluez",
        "/org/bluez",
        "org.bluez.AgentManager1",
        "RequestDefaultAgent",
        new GLib.Variant("(o)", [AGENT_PATH]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_bus2, res2) => {
          try {
            bus.call_finish(res2)
            log.info("pairing agent registered (NoInputNoOutput)")
          } catch (err) {
            // Registered but not default: pairings we initiate still reach us.
            log.warn("RequestDefaultAgent failed:", err)
          }
        },
      )
    },
  )
}

export function registerBluetoothAgent() {
  if (watching) return
  const bus = Gio.DBus.system
  if (!exported) {
    try {
      exported = Gio.DBusExportedObject.wrapJSObject(AGENT_XML, agentImpl)
      exported.export(bus, AGENT_PATH)
    } catch (err) {
      log.error("failed to export agent object:", err)
      return
    }
  }
  watching = Gio.bus_watch_name_on_connection(bus, "org.bluez", Gio.BusNameWatcherFlags.NONE,
    () => register(bus),
    () => {
      withdraw?.()
      withdraw = null
      expected.clear()
    })
}
