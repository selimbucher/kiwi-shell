import AstalBattery from "gi://AstalBattery"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "ags"

import { logger } from "../../log"
import { PART_ICONS, PART_NAMES, pods, shownCharges, type Pods } from "./airpods"

const log = logger("batteries")

// ─── Batteries ────────────────────────────────────────────────────────────────
// Everything with a battery UPower knows of, for the Batteries widget: the
// computer's own, and the mice, keyboards, headphones, controllers and pens
// connected to it (over Bluetooth, a receiver or a cable). UPower says when
// a level changes; nothing here asks. A device it only remembers (a pen
// put away, a receiver's mouse switched off) isn't present, and isn't shown.
// AirPods are their buds and case instead, as on a Mac (services/airpods).

export type Battery = {
    key: string
    name: string
    // the device it's a part of (AirPods' Left, Right and Case)
    of?: string
    // the best first, then what themes without it have
    icon: string[]
    // 0 to 1
    level: number
    charging: boolean
    // full and on the charger
    full: boolean
    // on the charger and not charging, short of full: held at a charge
    // limit (a laptop's 80%), or waiting to start
    held: boolean
    // the computer's own
    internal: boolean
    // seconds, 0 when UPower doesn't know
    left: number
    // the computer's: what's left of its first capacity (0 to 1), its charge
    // cycles and the power going in or out (watts); 0 where unknown
    health: number
    cycles: number
    watts: number
}

const { Type, State } = AstalBattery

const ICONS: [number, string][] = [
    [Type.MOUSE, "input-mouse-symbolic"],
    [Type.KEYBOARD, "input-keyboard-symbolic"],
    [Type.HEADSET, "audio-headset-symbolic"],
    [Type.HEADPHONES, "audio-headphones-symbolic"],
    [Type.SPEAKERS, "audio-speakers-symbolic"],
    [Type.OTHER_AUDIO, "audio-speakers-symbolic"],
    [Type.PHONE, "phone-symbolic"],
    [Type.TABLET, "input-tablet-symbolic"],
    [Type.PEN, "input-tablet-symbolic"],
    [Type.GAMING_INPUT, "input-gaming-symbolic"],
    [Type.TOUCHPAD, "input-touchpad-symbolic"],
    [Type.UPS, "uninterruptible-power-supply-symbolic"],
    [Type.WEARABLE, "watch-symbolic"],
    [Type.MEDIA_PLAYER, "multimedia-player-symbolic"],
    [Type.CAMERA, "camera-photo-symbolic"],
    [Type.PRINTER, "printer-symbolic"],
]

const NAMES: [number, string][] = [
    [Type.MOUSE, "Mouse"],
    [Type.KEYBOARD, "Keyboard"],
    [Type.HEADSET, "Headset"],
    [Type.HEADPHONES, "Headphones"],
    [Type.GAMING_INPUT, "Controller"],
    [Type.PEN, "Pen"],
    [Type.PHONE, "Phone"],
]

const [batteries, setBatteries] = createState<Battery[]>([])
export { batteries }

function read(device: AstalBattery.Device): Battery | null {
    if (device.deviceType === Type.LINE_POWER || !device.isPresent || !device.isBattery) return null
    const internal = device.deviceType === Type.BATTERY && device.powerSupply
    // UPS: a battery of its own, but not the computer's
    const charging = device.state === State.CHARGING
    const model = (device.model ?? "").trim()
    return {
        key: device.nativePath || model,
        name: internal ? "This Computer"
            : model || NAMES.find(([t]) => t === device.deviceType)?.[1] || device.vendor || "Device",
        icon: internal ? ["computer-laptop-symbolic", "computer-symbolic"]
            : [ICONS.find(([t]) => t === device.deviceType)?.[1] ?? "battery-symbolic", "battery-symbolic"],
        level: Math.max(0, Math.min(1, device.percentage)),
        charging,
        full: device.state === State.FULLY_CHARGED,
        held: device.state === State.PENDING_CHARGE,
        internal,
        left: charging ? device.timeToFull : device.timeToEmpty,
        health: internal && device.capacity > 0 && device.capacity <= 1 ? device.capacity : 0,
        cycles: internal && device.chargeCycles > 0 ? device.chargeCycles : 0,
        watts: internal ? Math.abs(device.energyRate) : 0,
    }
}

function partsOf(p: Pods): Battery[] {
    return shownCharges(p).map(c => ({
        key: `${p.path}:${c.part}`,
        name: PART_NAMES[c.part] || p.name,
        of: PART_NAMES[c.part] ? p.name : undefined,
        icon: PART_ICONS[c.part],
        level: c.level,
        charging: c.charging,
        full: c.charging && c.level >= 1,
        held: false,
        internal: false,
        left: 0,
        health: 0,
        cycles: 0,
        watts: 0,
    }))
}

// ─── Following UPower ─────────────────────────────────────────────────────────

let upower: AstalBattery.UPower | null = null
let upowerSignals: number[] = []
let unsubscribePods: (() => void) | null = null
const watched = new Map<AstalBattery.Device, number[]>()
let wanted = 0
let gathering = 0
let gathered = ""

// once for a burst of changes (UPower sends a device's at once), and only
// what shows: a level to the percent, the power to a tenth of a watt
function gather() {
    if (gathering) return
    gathering = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        gathering = 0
        if (!upower) return GLib.SOURCE_REMOVE
        // (UPower's AirPods: the level of their buds, which bluez has from here)
        const airpods = pods.peek()
        const all = [
            ...(upower.devices ?? []).map(read)
                .filter((b): b is Battery => !!b && !airpods.some(p => p.path === b.key)),
            ...airpods.flatMap(partsOf),
        ]
        // the computer first, then by name, a device's parts together
        all.sort((a, b) => Number(b.internal) - Number(a.internal) || (a.of ?? a.name).localeCompare(b.of ?? b.name))
        const signature = JSON.stringify(all.map(b => [b.key, b.name, b.icon[0], Math.round(b.level * 100), b.charging, b.full, b.held,
            Math.round(b.left / 60), Math.round(b.health * 100), b.cycles, Math.round(b.watts * 10)]))
        if (signature !== gathered) {
            gathered = signature
            setBatteries(all)
        }
        return GLib.SOURCE_REMOVE
    })
}

function follow(device: AstalBattery.Device) {
    if (watched.has(device)) return
    watched.set(device, ["notify::percentage", "notify::state", "notify::is-present", "notify::model", "notify::energy-rate"]
        .map(signal => device.connect(signal as any, gather)))
}

function start() {
    try {
        upower = new AstalBattery.UPower()
    } catch (e) {
        log.info("no UPower, so no batteries:", (e as Error).message)
        return
    }
    for (const device of upower.devices ?? []) follow(device)
    unsubscribePods = pods.subscribe(gather)
    upowerSignals = [
        upower.connect("device-added", (_u: unknown, device: AstalBattery.Device) => {
            follow(device)
            gather()
        }),
        upower.connect("device-removed", (_u: unknown, device: AstalBattery.Device) => {
            for (const id of watched.get(device) ?? []) device.disconnect(id)
            watched.delete(device)
            gather()
        }),
    ]
    gather()
}

function stop() {
    for (const [device, ids] of watched) for (const id of ids) device.disconnect(id)
    watched.clear()
    for (const id of upowerSignals) upower?.disconnect(id)
    upowerSignals = []
    unsubscribePods?.()
    unsubscribePods = null
    upower = null
    if (gathering) GLib.source_remove(gathering)
    gathering = 0
    gathered = ""
    setBatteries([])
}

/** A widget showing batteries: UPower is followed while one is. */
export function wantBatteries(): () => void {
    if (wanted++ === 0) start()
    let released = false
    return () => {
        if (released) return
        released = true
        if (--wanted === 0) stop()
    }
}

// ─── The day's charge ─────────────────────────────────────────────────────────

export type Charge = { time: number, level: number, charging: boolean }

const call = (path: string, iface: string, method: string, args: GLib.Variant | null): Promise<GLib.Variant> =>
    new Promise((resolve, reject) => Gio.DBus.system.call("org.freedesktop.UPower", path, iface, method, args, null,
        Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
            try {
                resolve(bus!.call_finish(result))
            } catch (e) {
                reject(e)
            }
        }))

/**
 * A battery's level over the last `seconds`, oldest first, from UPower's own
 * record (it notes each change); empty where it keeps none.
 */
export async function chargeHistory(battery: Battery, seconds = 86400): Promise<Charge[]> {
    try {
        const [paths] = (await call("/org/freedesktop/UPower", "org.freedesktop.UPower", "EnumerateDevices", null))
            .deepUnpack() as [string[]]
        for (const path of paths) {
            const [native] = (await call(path, "org.freedesktop.DBus.Properties", "Get",
                new GLib.Variant("(ss)", ["org.freedesktop.UPower.Device", "NativePath"]))).deepUnpack() as [GLib.Variant]
            if (native.deepUnpack() !== battery.key) continue
            const [records] = (await call(path, "org.freedesktop.UPower.Device", "GetHistory",
                new GLib.Variant("(suu)", ["charge", seconds, 200]))).deepUnpack() as [[number, number, number][]]
            const since = Date.now() / 1000 - seconds
            return records
                .filter(([time, level]) => time >= since && level > 0)
                .map(([time, level, state]) => ({ time, level: level / 100, charging: state === 1 || state === 5 }))
                .sort((a, b) => a.time - b.time)
        }
    } catch (e) {
        log.debug("no charge history:", (e as Error).message)
    }
    return []
}
