import { Gtk } from "ags/gtk4"
import { createBinding, type Accessor } from "ags"
import AstalBattery from "gi://AstalBattery"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"

import { conf } from "../../config"
import { Icon, BluetoothDeviceIcon } from "../../iconNames"
import { showAlert } from "../model"

// ─── Alerts ───────────────────────────────────────────────────────────────────
// iOS's island news, each the moment it happens: a charger plugged in, a
// Bluetooth device connected (iOS: AirPods, with their battery), Do Not
// Disturb turned on or off (iOS: a Focus). The Mac shows none of these:
// it chimes for the charger and leaves the rest to the menu bar icons.
//
// iOS's island grows into each one; here it shows them either side of the
// middle, which stays: the desktops, the date or the weather are still
// what they were.

const ms = 3000

// Words, and for a device the icon the Bluetooth tab shows it with (the
// theme's own where it has one: WhiteSur's headphones); the charger and Do
// Not Disturb have theirs at the bar's right end already.

/** What it is, on the leading side. */
function What({ title, icon }: { title: string; icon?: string }) {
    return (
        <box class="island-alert leading" valign={Gtk.Align.CENTER}>
            {icon ? <Icon class="symbol" iconName={icon} pixelSize={16} /> : <box />}
            <label label={title} valign={Gtk.Align.CENTER} />
        </box>
    )
}

/** How it stands, on the trailing side. */
function How({ value, visible = true }: { value: string | Accessor<string>; visible?: boolean | Accessor<boolean> }) {
    return <label class="island-alert trailing" label={value} visible={visible} valign={Gtk.Align.CENTER} />
}

const enabled = (key: "charging" | "devices" | "focus") => !!conf().island[key]

// ─── The charger ──────────────────────────────────────────────────────────────

const battery = AstalBattery.get_default()

if (battery.get_is_present()) {
    let wasCharging = battery.charging
    battery.connect("notify::charging", () => {
        const now = battery.charging
        if (now && !wasCharging && enabled("charging")) {
            const percent = createBinding(battery, "percentage").as(p => `${Math.round(p * 100)}%`)
            showAlert({
                id: "charging", ms,
                leading: () => <What title="Charging" /> as Gtk.Widget,
                trailing: () => <How value={percent} /> as Gtk.Widget,
            })
        }
        wasCharging = now
    })
}

// ─── Bluetooth devices ────────────────────────────────────────────────────────
// Only a device connecting, as on iOS: the shell starting with one already
// there, or one leaving, says nothing. Its battery shows when the device
// reports one, and fills in if it reports a moment later.

const bluetooth = AstalBluetooth.get_default()
const watched = new Map<AstalBluetooth.Device, number>()

function connected(device: AstalBluetooth.Device) {
    if (!device.connected || !enabled("devices")) return
    const battery = createBinding(device, "battery_percentage")
    showAlert({
        id: `bluetooth:${device.address}`, ms,
        leading: () => <What title={device.alias || device.name || "Device"}
            icon={device.icon ? BluetoothDeviceIcon(device.icon) : undefined} /> as Gtk.Widget,
        trailing: () => <How visible={battery(b => b > 0)} value={battery(b => `${Math.round(b * 100)}%`)} /> as Gtk.Widget,
    })
}

function watchDevices() {
    const devices = bluetooth.get_devices() ?? []
    for (const [device, id] of watched) {
        if (devices.includes(device)) continue
        device.disconnect(id)
        watched.delete(device)
    }
    for (const device of devices) {
        if (watched.has(device)) continue
        watched.set(device, device.connect("notify::connected", () => connected(device)))
    }
}

bluetooth.connect("notify::devices", watchDevices)
watchDevices()

// ─── Do Not Disturb ───────────────────────────────────────────────────────────

const notifd = AstalNotifd.get_default()
let quiet = notifd.dont_disturb

notifd.connect("notify::dont-disturb", () => {
    if (notifd.dont_disturb === quiet) return
    quiet = notifd.dont_disturb
    if (!enabled("focus")) return
    showAlert({
        id: "focus", ms: 2000,
        leading: () => <What title="Do Not Disturb" /> as Gtk.Widget,
        trailing: () => <How value={quiet ? "On" : "Off"} /> as Gtk.Widget,
    })
})
