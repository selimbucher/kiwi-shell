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

import { logger } from "./log"
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

// Auto-accepting confirm/authorize is safe on this setup: bluez only consults
// the agent for pairings we initiate while the adapter stays Pairable=no, so
// nothing incoming can ride these accepts. PIN/passkey *entry* is refused —
// accepting those would mean inventing digits the peer expects a human to
// type, which fails pairing anyway but only after a confusing timeout.
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
  RequestConfirmation(device: string, passkey: number) {
    log.info("auto-confirming passkey", String(passkey).padStart(6, "0"), "for", device)
  },
  RequestAuthorization(device: string) {
    log.info("auto-authorizing", device)
  },
  AuthorizeService(device: string, uuid: string) {
    log.debug("authorizing service", uuid, "for", device)
  },
  Cancel() {
    log.debug("pairing request cancelled by bluez")
  },
}

let registered = false

export function registerBluetoothAgent() {
  if (registered) return
  registered = true

  const bus = Gio.DBus.system
  try {
    const exported = Gio.DBusExportedObject.wrapJSObject(AGENT_XML, agentImpl)
    exported.export(bus, AGENT_PATH)
  } catch (err) {
    registered = false
    log.error("failed to export agent object:", err)
    return
  }

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
        registered = false
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
