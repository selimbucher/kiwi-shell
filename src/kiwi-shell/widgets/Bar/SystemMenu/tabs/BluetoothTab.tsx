import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import GLib from "gi://GLib"
import { createBinding, createComputed, createState, onCleanup } from "ags"

import { Icon, BluetoothDeviceIcon } from "../../../iconNames"
import { KeyedList } from "../../../KeyedList"
import { ContextMenu } from "../../../ContextMenu"
import { logger } from "../../../../log"
import { registerBluetoothAgent, expectPairing, pairingOver } from "../../../../bluetoothAgent"
import { call as bluez, devicePath, onAdapter, setAdapter, setProperty } from "../../../services/bluez"
const log = logger("bluetooth")
import { bluetoothTabOpen } from "../SystemMenu"
import { openChoicePrompt } from "../../../prompts"

// bluez tears the Adapter1 object down and registers a fresh one on every
// suspend/hibernate resume (the controller re-enumerates, firmware reloads,
// "MGMT ver" reappears in dmesg). A cached Adapter is therefore a dead proxy
// after the first resume: powered reads false forever, discovery/power calls go
// nowhere, and the tab claims Bluetooth is off while the AirPods are playing.
// Never hold the adapter — read it off the Astal singleton each time, and bind
// to the singleton's is-powered, which Astal re-syncs as adapters come and go.
// (bluez coming up after the shell, or a USB dongle plugged in, brings the
// adapter later: nothing here is decided once at startup)
const bluetooth = AstalBluetooth.get_default()
registerBluetoothAgent()

const liveAdapter = (): AstalBluetooth.Adapter | undefined =>
  bluetooth?.adapter ?? undefined

const [adapterState, setAdapterState] = createState(liveAdapter())
/** Whether there is a Bluetooth adapter now. */
export const hasAdapter = adapterState.as(a => a !== undefined)

// Seen by other devices and open to their pairing only while the Bluetooth
// tab is open, as a Mac is while its Bluetooth settings are: the rest of the
// time nothing nearby can find the laptop or start pairing with it.
function advertise() {
  const adapter = liveAdapter()
  if (!adapter?.powered) return
  const open = bluetoothTabOpen()
  const set = (name: string, now: boolean) => {
    if (now !== open)
      setAdapter(adapter, name, open).catch(e => log.warn("could not set the adapter's visibility:", e as Error))
  }
  set("Discoverable", adapter.discoverable)
  set("Pairable", adapter.pairable)
}
// (SystemMenu and this file import each other: its state is there once both are)
if (bluetooth) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
  bluetoothTabOpen.subscribe(advertise)
  advertise()
  return GLib.SOURCE_REMOVE
})

function onAdapterPowered(adapter: AstalBluetooth.Adapter) {
  if (adapter !== liveAdapter() || !adapter.powered) return
  advertise()
  if (bluetoothTabOpen()) startBluetoothDiscovery()
}

function trackAdapter(adapter: AstalBluetooth.Adapter) {
  adapter.connect("notify::powered", () => onAdapterPowered(adapter))
}

if (bluetooth) {
  const current = liveAdapter()
  if (current) trackAdapter(current)
  bluetooth.connect("adapter-added", (_, adapter) => {
    trackAdapter(adapter)
    setAdapterState(liveAdapter())
    // A resumed, already-powered adapter never fires notify::powered.
    onAdapterPowered(adapter)
  })
  bluetooth.connect("adapter-removed", () => setAdapterState(liveAdapter()))
}

const bluetoothEnabledRaw = bluetooth ? createBinding(bluetooth, "is_powered") : null
const devicesBinding = bluetooth ? createBinding(bluetooth, "devices") : null

// discovering lives on the adapter, so it has to follow adapter replacement.
const discoveringRaw = createComputed((get) => {
  const adapter = get(adapterState)
  return adapter ? get(createBinding(adapter, "discovering")) : false
})

// A device's address is stable while names resolve during discovery; keying on
// it lets KeyedList keep existing rows untouched (For re-appends every child on
// each list emission, which drops hover state and flickers).
const deviceKey = (device: AstalBluetooth.Device) =>
  device.address ?? device.get_object_path?.() ?? String(device)

const bluetoothEnabledBinding = createComputed((get) =>
  bluetoothEnabledRaw ? get(bluetoothEnabledRaw) : false,
)

// GTK4 emits state-set from set_active() too, not only for a click. Pushing
// is-powered into the switch therefore runs the handler, which used to answer
// with set_powered() and a two-second "frozen" state. Freezing was applied
// before the frozen value was stored, so the switch snapped to the stale value
// for one turn, that programmatic state-set saw a state that differed from the
// adapter's and powered it the other way, and bluez's reply re-entered the
// whole dance: the controller cycled on/off about seven times a second until
// the shell was restarted, the tab's rows vanished with every "off", and any
// right-click menu on them went with it. The flag marks the writes that come
// from the adapter so the handler only ever acts on a click.
let syncingSwitch = false
// how long a power change has to show on the adapter
const POWER_SETTLE_MS = 1500

// the device being paired, "Pairing…" on its row
const [pairingAddress, setPairingAddress] = createState("")
// A pairing or connection that failed says so on the device's row for a
// while, as a Mac's Bluetooth settings do, rather than the row just going
// back to how it was.
const [failure, setFailure] = createState<{ address: string; text: string } | null>(null)
let failureTimer = 0
const FAILURE_SHOWN_MS = 5000
function failed(address: string, text: string) {
  if (failureTimer) GLib.source_remove(failureTimer)
  setFailure({ address, text })
  failureTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FAILURE_SHOWN_MS, () => {
    failureTimer = 0
    setFailure(null)
    return GLib.SOURCE_REMOVE
  })
}

const MAC_NAME = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/

// Which section a device belongs to, or null when it should not be listed at
// all. Row visibility and the two empty states both go through this so they can
// never disagree about what is on screen.
//
// "Other Devices" is strictly for devices that are discoverable RIGHT NOW
// (in pairing mode). bluez auto-purges unpaired+untrusted registry entries
// ~30s after discovery ends, so anything that isn't paired/connected/trusted
// IS a live discovery. Trusted covers the bond-drop relic case (e.g.
// AirPods re-keying gets refused, Paired flips to no but Trusted survives):
// such a device is one of ours and must never fall under "Other Devices" —
// it stays in the known section, where a click re-pairs it.
function deviceSection(
  name: string,
  paired: boolean,
  connected: boolean,
  trusted: boolean,
): "known" | "other" | null {
  if (!name || MAC_NAME.test(name)) return null
  return paired || connected || trusted ? "known" : "other"
}

// KeyedList only knows how many widgets it built, not how many of them the
// per-row filter above left visible — so the empty states count it themselves.
const sectionCounts = createComputed((get) => {
  const counts = { known: 0, other: 0 }
  for (const device of devicesBinding ? get(devicesBinding) : []) {
    const section = deviceSection(
      get(createBinding(device, "name")),
      get(createBinding(device, "paired")),
      get(createBinding(device, "connected")),
      get(createBinding(device, "trusted")),
    )
    if (section) counts[section]++
  }
  return counts
})

const otherEmptyLabel = createComputed((get) => {
  if (get(sectionCounts).other > 0) return ""
  if (get(discoveringRaw)) return "Searching…"
  return "No devices found"
})

// (refused when already discovering: nothing to do)
export function startBluetoothDiscovery() {
  return onAdapter(liveAdapter(), "StartDiscovery")
}

// bluez refuses with "No discovery started" when nothing is scanning. This is
// routine, not an error: pairDevice() stops discovery and then calls
// connectDevice(), which stops it again. Letting that throw used to abort
// connectDevice() *before* connect_device() ran, so a successful pair never
// connected and discovery was left stopped (the finally never ran either).
export function stopBluetoothDiscovery() {
  return onAdapter(liveAdapter(), "StopDiscovery")
}

export default function BluetoothTab({ visible }) {
  return (
    <box
      class="tab-content"
      visible={visible}
      orientation={Gtk.Orientation.VERTICAL}
    >
      <box class="section-header">
        <box halign={Gtk.Align.START}>Bluetooth</box>
        <box hexpand={true} />
        <switch
          sensitive={adapterState((a) => a !== undefined)}
          $={(self) => {
            const follow = () => {
              syncingSwitch = true
              try {
                self.set_active(bluetoothEnabledBinding.get())
              } finally {
                syncingSwitch = false
              }
            }
            follow()
            onCleanup(bluetoothEnabledBinding.subscribe(follow))
            ;(self as Gtk.Switch).connect("state-set", (_self: Gtk.Switch, state: boolean) => {
              if (syncingSwitch) return false
              const adapter = liveAdapter()
              if (adapter && state !== adapter.powered) {
                // bluez answers once the controller has actually changed
                // state, and the is-powered update that follows finds the
                // switch already there. One refused (rfkill, airplane mode)
                // changes nothing, and the switch goes back to say so.
                setAdapter(adapter, "Powered", state)
                  .catch(e => log.warn("couldn't switch Bluetooth:", e as Error))
                  .finally(() => GLib.timeout_add(GLib.PRIORITY_DEFAULT, POWER_SETTLE_MS, () => {
                    follow()
                    return GLib.SOURCE_REMOVE
                  }))
              }
              return false
            })
          }}
        />
      </box>
      <box
        class="paired-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
        visible={bluetoothEnabledBinding}
      >
        <label
          class="list-empty"
          halign={Gtk.Align.START}
          label="No paired devices"
          visible={sectionCounts((c) => c.known === 0)}
        />
        {devicesBinding && (
          <KeyedList
            each={devicesBinding}
            keyFn={deviceKey}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            children={(device) => <Device device={device} paired={true} />}
          />
        )}
      </box>

      <box class="section-header mt" visible={bluetoothEnabledBinding}>
        <box halign={Gtk.Align.START}>Other Devices</box>
        <box hexpand={true} />
      </box>

      <box
        class="unkown-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
        visible={bluetoothEnabledBinding}
      >
        <label
          class="list-empty"
          halign={Gtk.Align.START}
          label={otherEmptyLabel}
          visible={otherEmptyLabel((l) => l !== "")}
        />
        {devicesBinding && (
          <KeyedList
            each={devicesBinding}
            keyFn={deviceKey}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            children={(device) => <Device device={device} paired={false} />}
          />
        )}
      </box>
    </box>
  )
}

function Device({ device, paired }) {
  const iconBinding = createBinding(device, "icon")
  const connectedBinding = createBinding(device, "connected")
  const connectingBinding = createBinding(device, "connecting")
  const batteryBinding = createBinding(device, "batteryPercentage")
  const deviceName = createBinding(device, "name")
  const pairedBinding = createBinding(device, "paired")
  const trustedBinding = createBinding(device, "trusted")

  const visibility = createComputed((get) => {
    const section = deviceSection(
      get(deviceName),
      get(pairedBinding),
      get(connectedBinding),
      get(trustedBinding),
    )
    return section === (paired ? "known" : "other")
  })

  // battery_percentage is a 0..1 fraction (astal divides the bluez byte by 100)
  // and is -1 on anything without a Battery1 interface. A reading left over from
  // the last session says nothing about a device that isn't connected.
  const batteryLabel = createComputed((get) => {
    const percentage = get(batteryBinding)
    if (!get(connectedBinding) || percentage <= 0) return ""
    return `${Math.round(percentage * 100)}%`
  })

  const statusLabel = createComputed((get) => {
    const pairing = get(pairingAddress)
    if (pairing !== "" && pairing === device.address) return "Pairing…"
    if (get(connectingBinding)) return "Connecting…"
    if (get(connectedBinding)) return "Connected"
    const failing = get(failure)
    if (failing && failing.address === device.address) return failing.text
    return ""
  })

  const hasIcon = iconBinding.as((s) => !!s)

  const menu = DeviceContextMenu(
    device,
    connectedBinding,
    pairedBinding,
    trustedBinding,
  )

  return (
    <button
      visible={visibility}
      class={connectedBinding.as((b) =>
        b ? "bluetooth-item active" : "bluetooth-item",
      )}
      onClicked={() => {
        handleDeviceClick(device)
      }}
      $={(self) => {
        const gesture = new Gtk.GestureClick()
        gesture.set_button(3)
        gesture.connect("released", () => {
          menu.popup()
        })
        self.add_controller(gesture)
      }}
    >
      <box spacing={6}>
        {menu}
        <Icon
          pixelSize={16}
          visible={hasIcon}
          iconName={iconBinding.as((s) => BluetoothDeviceIcon(s))}
        />
        <label
          label={deviceName.as((n) => n || "Unknown Device")}
          hexpand={true}
          halign={Gtk.Align.START}
        />
        <label
          class="bt-battery"
          label={batteryLabel}
          visible={batteryLabel((b) => b !== "")}
        />
        <label label={statusLabel} visible={statusLabel((s) => s !== "")} />
      </box>
    </button>
  )
}

function DeviceContextMenu(
  device,
  connectedBinding,
  pairedBinding,
  trustedBinding,
) {
  return ContextMenu({
    class: "app-context-menu bt-context-menu",
    items: [
      {
        label: "Connect",
        icon: "bluetooth-active-symbolic",
        visible: createComputed((get) => get(pairedBinding) && !get(connectedBinding)),
        onClick: () => connectDevice(device),
      },
      {
        label: "Pair & Connect",
        icon: "bluetooth-active-symbolic",
        visible: pairedBinding.as((p) => !p),
        onClick: () => pairDevice(device),
      },
      {
        label: "Disconnect",
        icon: "bluetooth-disabled-symbolic",
        visible: connectedBinding,
        onClick: () => disconnectDevice(device),
      },
      {
        // Mirrors the "known device" test in Device(): a bond-drop relic (e.g.
        // AirPods that refused re-keying) has paired=no but trusted=yes, and it
        // still holds a bluez registry entry that remove_device() can clear.
        // Gating on paired alone left exactly those devices — the ones you most
        // need to forget — with no Forget item.
        label: "Forget Device",
        icon: "user-trash-symbolic",
        visible: createComputed((get) => get(pairedBinding) || get(trustedBinding)),
        // pairing it again needs the device in pairing mode, so asked first
        onClick: () => openChoicePrompt("Forget Device",
          `Forget “${device.alias || device.name || device.address}”? It will need to be paired again.`,
          [{ label: "Forget", primary: true, run: () => forgetDevice(device) }]),
      },
    ],
  })
}

function connectDevice(device) {
  log.debug("Connecting to", device.name)
  // Connecting/pairing while the adapter is actively scanning makes the
  // controller time-slice between scan and connect, which causes Page Timeout /
  // AuthenticationTimeout. Pause discovery for the operation and resume it
  // afterwards if the tab is still open (bluetoothctl does the same implicitly).
  void stopBluetoothDiscovery().then(() => device.connect_device((source, result) => {
    try {
      device.connect_device_finish(result)
      log.debug("Connected successfully!")
    } catch (err) {
      log.error("Connect failed:", err)
      failed(device.address ?? "", "Couldn't connect")
    } finally {
      if (bluetoothTabOpen()) void startBluetoothDiscovery()
    }
  }))
}

function disconnectDevice(device) {
  log.debug("Disconnecting from", device.name)
  device.disconnect_device((source, result) => {
    try {
      device.disconnect_device_finish(result)
      log.debug("Disconnected successfully!")
    } catch (err) {
      log.error("Disconnect failed:", err)
    }
  })
}

function pairDevice(device) {
  log.debug("Pairing with", device.name)
  const address = device.address ?? ""
  setPairingAddress(address)
  const path = address ? devicePath(device) : ""
  const over = (error: unknown | null) => {
    pairingOver(path)
    if (pairingAddress.get() === address) setPairingAddress("")
    // AlreadyExists → the device is in fact already paired at the bluez level;
    // fall through to connecting it. Any other error (AuthenticationTimeout /
    // AuthenticationFailed / ConnectionAttemptFailed "Page Timeout") means the
    // device didn't complete pairing — said on its row, and nothing more is
    // tried. connectDevice() manages discovery itself.
    if (error && !String(error).includes("AlreadyExists")) {
      log.error("Pair failed:", error)
      failed(address, "Couldn't pair")
      if (bluetoothTabOpen()) void startBluetoothDiscovery()
      return
    }
    setProperty(path, "org.bluez.Device1", "Trusted", GLib.Variant.new_boolean(true))
      .catch(e => log.warn("couldn't trust", device.name, e as Error))
      .finally(() => connectDevice(device))
  }
  if (!path) return over(new Error("the device has no address"))
  // asked for here: the agent confirms it without asking again
  expectPairing(path)
  // Pause scanning first: pairing while discovery runs is a common cause of the
  // AuthenticationTimeout / Page Timeout failures seen with these mice.
  // Astal's pair() is a synchronous call: the shell stood still until bluez
  // answered (10 s for a mouse gone back to sleep), and the agent, answering
  // from the same main loop, couldn't be asked anything meanwhile. Called
  // here without waiting, as bluetoothctl does; a minute leaves time to type
  // a code shown on the other device.
  void stopBluetoothDiscovery()
    .then(() => bluez(path, "org.bluez.Device1", "Pair", null, 60_000))
    .then(() => over(null), over)
}

// (bluez disconnects it first: seconds for one connected)
function forgetDevice(device) {
  log.debug("Removing device", device.name)
  bluez(device.adapter, "org.bluez.Adapter1", "RemoveDevice", new GLib.Variant("(o)", [devicePath(device)]))
    .catch(error => log.error("Failed to remove device:", error))
}

async function handleDeviceClick(device) {
  try {
    // Check connected first so a connected device always disconnects, and only
    // truly-unpaired devices go through pair(). A paired-but-disconnected device
    // (e.g. an MX Master re-appearing) connects rather than re-pairing.
    if (device.connected) {
      disconnectDevice(device)
    } else if (device.paired) {
      connectDevice(device)
    } else {
      pairDevice(device)
    }
  } catch (error) {
    log.error("Bluetooth operation failed:", error)
  }
}
