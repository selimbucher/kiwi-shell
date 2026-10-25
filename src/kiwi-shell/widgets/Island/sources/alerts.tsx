import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, onCleanup, type Accessor } from "ags"
import { battery } from "../../services/battery"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"
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
// iOS's: the charge, and a battery filled to it, in a colour for how full it
// is: red to 20%, yellow to 40%, green above.


const LEVELS = [
    { upTo: 0.2, name: "low", color: "#ff453a" },
    { upTo: 0.4, name: "mid", color: "#ffd60a" },
    { upTo: Infinity, name: "high", color: "#30d158" },
] as const
const levelOf = (charge: number) => LEVELS.find(l => charge <= l.upTo)!

// A battery as iOS draws one: a white outline and its cap, filled to the
// charge in its level's colour.
const BatteryGlyph = GObject.registerClass(
    { GTypeName: "KiwiBatteryGlyph" },
    class BatteryGlyph extends Gtk.Widget {
        charge = 1

        vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
            const size = orientation === Gtk.Orientation.HORIZONTAL ? 25 : 12
            return [size, size, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            const white = new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 1 })
            const rounded = (x: number, y: number, w: number, h: number, r: number) => {
                const radius = new Graphene.Size().init(r, r)
                return new Gsk.RoundedRect().init(new Graphene.Rect().init(x, y, w, h), radius, radius, radius, radius)
            }
            const fill = (rect: Gsk.RoundedRect, color: Gdk.RGBA) => {
                snapshot.push_rounded_clip(rect)
                snapshot.append_color(color, rect.bounds)
                snapshot.pop()
            }
            snapshot.append_border(rounded(0.5, 0.5, 21.5, 11, 3.5), [1, 1, 1, 1], [white, white, white, white])
            fill(rounded(23, 4, 2, 4, 1), new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 0.8 }))
            const width = Math.max(0, Math.min(1, this.charge)) * 18.5
            if (width <= 0) return
            const color = new Gdk.RGBA()
            color.parse(levelOf(this.charge).color)
            fill(rounded(2, 2, Math.max(width, 2), 8, 2), color)
        }
    },
)

/** The battery and "Charging", on the leading side. */
function Charging() {
    const glyph = new BatteryGlyph({ valign: Gtk.Align.CENTER })
    const update = () => {
        glyph.charge = battery.percentage
        glyph.queue_draw()
    }
    update()
    const id = battery.connect("notify::percentage", update)
    onCleanup(() => battery.disconnect(id))
    return (
        <box class="island-alert leading" valign={Gtk.Align.CENTER} spacing={7}>
            {glyph}
            <label label="Charging" valign={Gtk.Align.CENTER} />
        </box>
    )
}

/** The charge, on the trailing side. */
function Charge() {
    const charge = createBinding(battery, "percentage")
    return (
        <label class={charge(c => `island-alert trailing charge ${levelOf(c).name}`)} label={charge(c => `${Math.round(c * 100)}%`)}
            valign={Gtk.Align.CENTER} />
    )
}

if (battery.get_is_present()) {
    let wasCharging = battery.charging
    battery.connect("notify::charging", () => {
        const now = battery.charging
        if (now && !wasCharging && enabled("charging")) {
            showAlert({
                id: "charging", ms,
                leading: () => <Charging /> as Gtk.Widget,
                trailing: () => <Charge /> as Gtk.Widget,
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
