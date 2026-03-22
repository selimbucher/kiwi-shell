import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import GLib from "gi://GLib"
import { createBinding, createComputed, createState, For } from "ags"
import { exec } from "ags/process"

import { Icon, BluetoothDeviceIcon } from "../../../iconNames"
import { bluetoothTabOpen } from "../SystemMenu"

function hasBluetoothAdapter(): boolean {
  try {
    const dir = GLib.Dir.open("/sys/class/bluetooth", 0)
    return dir.read_name() !== null
  } catch {
    return false
  }
}

let bluetooth: ReturnType<typeof AstalBluetooth.get_default> | null = null
let adapter: AstalBluetooth.Adapter | undefined = undefined

if (hasBluetoothAdapter()) {
  bluetooth = AstalBluetooth.get_default()
  adapter = bluetooth.adapter ?? undefined
}

adapter?.connect("notify::powered", () => {
  if (bluetoothEnabledBinding()) {
    adapter!.set_discoverable(true)
    if (bluetoothTabOpen()) {
      startBluetoothDiscovery()
    }
  }
})

const bluetoothEnabledRaw = adapter ? createBinding(adapter, "powered") : null
const devicesBinding = bluetooth ? createBinding(bluetooth, "devices") : null

const [btFrozen, setBtFrozen] = createState(false)
const [btFrozenValue, setBtFrozenValue] = createState(adapter?.powered ?? false)

const bluetoothEnabledBinding = createComputed((get) => {
  if (get(btFrozen)) return get(btFrozenValue)
  if (!bluetoothEnabledRaw) return false
  return get(bluetoothEnabledRaw)
})

export function startBluetoothDiscovery() {
  try {
    adapter?.start_discovery()
  } catch (e) {
    // Already discovering, ignore
  }
}

export function stopBluetoothDiscovery() {
  adapter?.stop_discovery()
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
          sensitive={adapter !== undefined}
          active={bluetoothEnabledBinding}
          onStateSet={(self, state) => {
            if (state !== adapter?.powered) {
              adapter?.set_powered(state)
            }
            setBtFrozen(true)
            setBtFrozenValue(state)
            setTimeout(() => setBtFrozen(false), 2000)
          }}
        />
      </box>
      <box
        class="paired-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
      >
        {devicesBinding && (
          <For each={devicesBinding}>
            {(device) => <Device device={device} paired={true} />}
          </For>
        )}
      </box>

      <box class="section-header mt">
        <box halign={Gtk.Align.START}>Other Devices</box>
        <box hexpand={true} />
      </box>

      <box
        class="unkown-devices"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={4}
        vexpand={true}
      >
        {devicesBinding && (
          <For each={devicesBinding}>
            {(device) => <Device device={device} paired={false} />}
          </For>
        )}
      </box>
    </box>
  )
}

function Device({ device, paired }) {
  const iconBinding = createBinding(device, "icon")
  const connectedBinding = createBinding(device, "connected")
  const deviceName = createBinding(device, "name")
  const pairedBinding = createBinding(device, "paired")

  const visibility = createComputed((get) => {
    const name = get(deviceName)
    const isMac = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(name)
    return get(pairedBinding) == paired && name && !isMac
  })

  const hasIcon = iconBinding.as((s) => !!s)

  return (
    <button
      visible={visibility}
      class={connectedBinding.as((b) =>
        b ? "bluetooth-item active" : "bluetooth-item",
      )}
      onClicked={() => {
        handleDeviceClick(device)
      }}
    >
      <box spacing={6}>
        <Icon
          pixelSize={16}
          visible={hasIcon}
          iconName={iconBinding.as((s) => BluetoothDeviceIcon(s))}
        />
        <label
          label={device.name || "Unkown Device"}
          hexpand={true}
          halign={Gtk.Align.START}
        />
        <label label="Connected" visible={connectedBinding} />
      </box>
    </button>
  )
}

async function handleDeviceClick(device) {
  try {
    if (!device.paired) {
      console.log("Pairing with", device.name)
      device.pair()

      console.log("Trusting", device.name)
      device.trusted = true

      console.log("Connecting to", device.name)
      device.connect_device((source, result) => {
        try {
          device.connect_device_finish(result)
          console.log("Connected successfully!")
        } catch (err) {
          console.error("Connect failed:", err)
        }
      })
    } else if (!device.connected) {
      console.log("Connecting to", device.name)
      device.connect_device((source, result) => {
        try {
          device.connect_device_finish(result)
          console.log("Connected successfully!")
        } catch (err) {
          console.error("Connect failed:", err)
        }
      })
    } else {
      console.log("Disconnecting from", device.name)
      device.disconnect_device((source, result) => {
        try {
          device.disconnect_device_finish(result)
          console.log("Disconnected successfully!")
        } catch (err) {
          console.error("Disconnect failed:", err)
        }
      })
    }
  } catch (error) {
    console.error("Bluetooth operation failed:", error)
  }
}