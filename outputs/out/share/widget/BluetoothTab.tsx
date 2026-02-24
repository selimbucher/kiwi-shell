import { Gtk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import { createBinding, createComputed, For } from "ags"
import { BluetoothDeviceIcon } from "./iconNames"

const bluetooth = AstalBluetooth.get_default()
const adapter = bluetooth.adapter

const bluetoothEnabledBinding = createBinding(adapter, "powered")
const devicesBinding = createBinding(bluetooth, "devices")

export function startBluetoothDiscovery() {
    adapter.start_discovery()
}

export function stopBluetoothDiscovery() {
    adapter.stop_discovery()
}

export default function BluetoothTab({visible}) {

    return (
        <box class="tab-content" visible={visible} orientation={Gtk.Orientation.VERTICAL}>
            <box class="section-header">
                <box halign={Gtk.Align.START}>Bluetooth</box>
                <box hexpand={true} />
                
                <switch
                    active={bluetoothEnabledBinding}
                    onStateSet={(self, state) => {
                        if (bluetoothEnabledBinding.get()) {
                            adapter.powered = false
                        } else {
                            adapter.powered = true
                            adapter.pairable = true
                        }
                    }}
                />
            </box>
            <box class="paired-devices" orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand={true}>
                <For each={devicesBinding}>
                   {(device) =>
                        <Device device={device} paired={true} />
                    }
                </For>
            </box>

            <box class="section-header mt">
                <box halign={Gtk.Align.START}>Other Devices</box>
                <box hexpand={true} />
            </box>

            <box class="unkown-devices" orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand={true}>
                <For each={devicesBinding}>
                    {(device) =>
                        <Device device={device} paired={false} />
                    }
                </For>
            </box>

        </box>
    )
}

function Device({device, paired}){
    const iconBinding = createBinding(device, "icon");
    const connectedBinding = createBinding(device, "connected")
    const deviceName = createBinding(device, "name")
    const pairedBinding = createBinding(device, "paired")

    const visibility = createComputed((get) => {
        return (get(pairedBinding) == paired) && get(deviceName);
    })

    return (
      <button 
      visible = {visibility}
        class={connectedBinding.as( b => b ? "bluetooth-item active" : "bluetooth-item")}
          onClicked={() => {
            handleDeviceClick(device)
        }}
      >
        <box spacing={8}>
            <Gtk.Image 
            pixelSize={16}
            iconName={iconBinding.as(s => BluetoothDeviceIcon(s))}
            />
            <label label={device.name || "Unkown Device"} hexpand={true} halign={Gtk.Align.START} />
            <label
            label = "Connected"
            visible={connectedBinding}
            />
            
        </box>
        </button>
      )
}

async function  handleDeviceClick(device) {
        try {
            if (!device.paired) {
                // Pair is synchronous
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
                // Already paired, just connect
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
                // Already connected, disconnect
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