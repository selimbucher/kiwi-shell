import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix"
import Mpris from "gi://AstalMpris"
import { createState } from "ags"

import { logger } from "../../log"
import { call as bluez } from "./bluez"

const log = logger("airpods")

// ─── AirPods ──────────────────────────────────────────────────────────────────
// AirPods tell a Mac each bud's charge, the case's and which buds are in an
// ear over a channel of Apple's own beside the audio (AAP, on L2CAP; the
// packets as LibrePods worked them out), and nothing over the ones other
// headphones use. bluez connects it for the shell as a profile of its own
// and hands over the socket; the AirPods then send each change.
//
// The buds' charge goes back to bluez as the device's battery, so it shows
// wherever any headset's does (UPower, the Bluetooth menu, the island).

export type PodPart = "left" | "right" | "case" | "headphones"
export type PodCharge = { part: PodPart, level: number, charging: boolean }
export type Pods = { path: string, name: string, charges: PodCharge[] }

const [pods, setPods] = createState<Pods[]>([])
export { pods }

const AAP = "74ec2172-0bad-4d01-8f77-997b2be0722a"
const PROFILE_PATH = "/org/kiwi/airpods"
const BATTERIES_PATH = "/org/kiwi/airpods/batteries"

// what they wait for before they answer anything, then: send every change
const HELLO = [0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
const SUBSCRIBE = [0x04, 0x00, 0x04, 0x00, 0x0f, 0x00, 0xff, 0xff, 0xff, 0xff]

const BATTERY = 0x04
const EARS = 0x06
const PARTS: Record<number, PodPart> = { 0x01: "headphones", 0x02: "right", 0x04: "left", 0x08: "case" }
const CHARGING = 0x01
const GONE = 0x04
const IN_EAR = 0x00

// ConnectProfile while bluez is still connecting the audio: InProgress
const RETRIES = 5
const RETRY_MS = 2000
// a hello while they're still connecting the audio goes unanswered: again
const HELLOS = 5
const HELLO_MS = 2000

// 04 00 04 00 04 00, a count, then each: part, 01, level, status, 01
function chargesOf(packet: Uint8Array): PodCharge[] {
    const found: PodCharge[] = []
    for (let i = 0; i < packet[6]; i++) {
        const at = 7 + i * 5
        if (at + 4 > packet.length) break
        const part = PARTS[packet[at]], level = packet[at + 2], status = packet[at + 3]
        // (255: not known yet, the case's for a while after a bud goes in)
        if (!part || status === GONE || level > 100) continue
        found.push({ part, level: level / 100, charging: status === CHARGING })
    }
    return found
}

// ─── As a Mac shows them ──────────────────────────────────────────────────────

export type ShownPart = "buds" | PodPart
export type Shown = { part: ShownPart, level: number, charging: boolean }

// as far apart as two buds shown as one may be
const TOGETHER = 0.1

/**
 * The buds as one while they're together (both in ears, or both in the
 * case) at about the same charge, each on its own otherwise; the case
 * while a bud is in it (the only time the AirPods know its charge).
 */
export function shownCharges(p: Pods): Shown[] {
    const left = p.charges.find(c => c.part === "left")
    const right = p.charges.find(c => c.part === "right")
    const shown: Shown[] = left && right && left.charging === right.charging && Math.abs(left.level - right.level) <= TOGETHER
        ? [{ part: "buds", level: Math.min(left.level, right.level), charging: left.charging }]
        : [left, right].filter((c): c is PodCharge => !!c)
    return [...shown, ...p.charges.filter(c => c.part === "headphones" || c.part === "case")]
}

// (kiwi's own, alone: GTK looks through every theme for all of a list's
// names before it looks at its own icons)
export const PART_ICONS: Record<ShownPart, string[]> = {
    buds: ["airpods-symbolic"],
    left: ["airpods-left-symbolic"],
    right: ["airpods-right-symbolic"],
    case: ["airpods-case-symbolic"],
    headphones: ["audio-headphones-symbolic"],
}

export const PART_NAMES: Record<ShownPart, string> = {
    buds: "", left: "Left", right: "Right", case: "Case", headphones: "",
}

// ─── The battery bluez shows ──────────────────────────────────────────────────
// The lowest bud in an ear (out of the case: not charging), or of both
// while both are in the case.

const BATTERY_XML = `<node>
  <interface name="org.bluez.BatteryProvider1">
    <property name="Device" type="o" access="read"/>
    <property name="Percentage" type="y" access="read"/>
    <property name="Source" type="s" access="read"/>
  </interface>
</node>`

const batteries = Gio.DBusObjectManagerServer.new(BATTERIES_PATH)
const provided = new Map<string, { object: Gio.DBusObjectSkeleton, battery: Gio.DBusExportedObject, percent: number }>()
// by adapter, once (a resume brings the adapter back new, without it)
const providing = new Set<string>()

function percentOf(charges: PodCharge[]): number | null {
    const buds = charges.filter(c => c.part !== "case")
    const out = buds.filter(c => !c.charging)
    const counted = out.length ? out : buds
    return counted.length ? Math.round(Math.min(...counted.map(c => c.level)) * 100) : null
}

function provide(device: string, percent: number | null) {
    const known = provided.get(device)
    if (percent === null) {
        if (known) batteries.unexport(known.object.get_object_path())
        provided.delete(device)
        return
    }
    if (known) {
        if (known.percent === percent) return
        known.percent = percent
        known.battery.emit_property_changed("Percentage", GLib.Variant.new_byte(percent))
        return
    }
    const entry = { percent } as { object: Gio.DBusObjectSkeleton, battery: Gio.DBusExportedObject, percent: number }
    entry.battery = Gio.DBusExportedObject.wrapJSObject(BATTERY_XML, {
        get Device() { return device },
        get Percentage() { return entry.percent },
        get Source() { return "AirPods" },
    })
    entry.object = Gio.DBusObjectSkeleton.new(`${BATTERIES_PATH}/${device.split("/").pop()}`)
    // (GJS's exported object is an interface skeleton; its types don't say so)
    entry.object.add_interface(entry.battery as unknown as Gio.DBusInterfaceSkeleton)
    batteries.export(entry.object)
    provided.set(device, entry)

    const adapter = device.slice(0, device.lastIndexOf("/"))
    if (providing.has(adapter)) return
    providing.add(adapter)
    bluez(adapter, "org.bluez.BatteryProviderManager1", "RegisterBatteryProvider", new GLib.Variant("(o)", [BATTERIES_PATH]))
        .catch(e => log.info("bluez takes no batteries (Experimental is off in its main.conf):", e))
}

// ─── Taking one out ───────────────────────────────────────────────────────────
// As on a Mac: a bud taken out of an ear pauses what's playing, and putting
// it back plays it again; with both out it stays paused. Only what was
// paused here plays again, and only if nothing played or stopped it since.

// playerctld stands in for whichever player is current
const PROXY = "org.mpris.MediaPlayer2.playerctld"

// buds in ears, from the first report on (connecting says nothing)
const inEars = new Map<string, number>()
let resume: { device: string, players: string[] } | null = null

function control(busName: string, method: "Play" | "Pause") {
    Gio.DBus.session.call(busName, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", method, null, null,
        Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
            try {
                bus!.call_finish(result)
            } catch (e) {
                log.debug(`${method} to ${busName} failed:`, e)
            }
        })
}

function earsChanged(device: string, packet: Uint8Array) {
    if (packet.length < 8) return
    const now = [packet[6], packet[7]].filter(s => s === IN_EAR).length
    const before = inEars.get(device)
    inEars.set(device, now)
    if (before === undefined || now === before) return
    const players = (Mpris.get_default().players ?? []).filter(p => p.bus_name !== PROXY)
    if (now < before) {
        const playing = players.filter(p => p.playback_status === Mpris.PlaybackStatus.PLAYING).map(p => p.bus_name)
        for (const name of playing) control(name, "Pause")
        if (now === 0) resume = null
        else if (playing.length) resume = { device, players: playing }
        return
    }
    if (resume?.device !== device) return
    for (const name of resume.players)
        if (players.find(p => p.bus_name === name)?.playback_status === Mpris.PlaybackStatus.PAUSED) control(name, "Play")
    resume = null
}

// ─── The channel ──────────────────────────────────────────────────────────────

type Link = {
    device: string, input: GioUnix.InputStream, output: GioUnix.OutputStream, cancel: Gio.Cancellable,
    answered: boolean, hello: number,
}
const links = new Map<string, Link>()
const charges = new Map<string, PodCharge[]>()

function publish() {
    const all = [...charges].map(([path, found]) => ({ path, name: devices.get(path)?.name || "AirPods", charges: found }))
    if (JSON.stringify(all) === JSON.stringify(pods.peek())) return
    log.debug("charges:", all.map(p => `${p.name} ${p.charges.map(c => `${c.part} ${Math.round(c.level * 100)}%${c.charging ? "+" : ""}`).join(", ")}`))
    setPods(all)
}

function chargesChanged(device: string, found: PodCharge[] | null) {
    if (found) charges.set(device, found)
    else charges.delete(device)
    provide(device, found && percentOf(found))
    publish()
}

function send(link: Link, bytes: number[]): Promise<void> {
    return new Promise((resolve, reject) =>
        link.output.write_bytes_async(new GLib.Bytes(Uint8Array.from(bytes)), GLib.PRIORITY_DEFAULT, link.cancel, (stream, result) => {
            try {
                stream!.write_bytes_finish(result)
                resolve()
            } catch (e) {
                reject(e)
            }
        }))
}

// one packet a read (a seqpacket socket)
function read(link: Link) {
    link.input.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, link.cancel, (stream, result) => {
        let packet: Uint8Array | null = null
        try {
            packet = stream!.read_bytes_finish(result).toArray()
        } catch (e) {
            if (!link.cancel.is_cancelled()) log.debug("AirPods channel closed:", e)
        }
        if (packet?.length) {
            link.answered = true
            if (packet[4] === BATTERY) chargesChanged(link.device, chargesOf(packet))
            else if (packet[4] === EARS) earsChanged(link.device, packet)
            return read(link)
        }
        // gone, or let go: closed here, with no read waiting on it
        if (link.hello) GLib.source_remove(link.hello)
        link.hello = 0
        try {
            link.input.close(null)
        } catch { /* closed */ }
        if (links.get(link.device) !== link) return
        links.delete(link.device)
        inEars.delete(link.device)
        chargesChanged(link.device, null)
    })
}

function open(device: string, fd: number) {
    links.get(device)?.cancel.cancel()
    const link: Link = {
        device,
        input: GioUnix.InputStream.new(fd, true),
        output: GioUnix.OutputStream.new(fd, false),
        cancel: new Gio.Cancellable(),
        answered: false,
        hello: 0,
    }
    links.set(device, link)
    const hello = () => send(link, HELLO).then(() => send(link, SUBSCRIBE)).catch(e => log.debug("AirPods didn't take the hello:", e))
    let hellos = 1
    hello()
    link.hello = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HELLO_MS, () => {
        if (link.answered || hellos++ >= HELLOS) {
            if (!link.answered) log.debug("AirPods didn't answer")
            link.hello = 0
            return GLib.SOURCE_REMOVE
        }
        hello()
        return GLib.SOURCE_CONTINUE
    })
    read(link)
}

const PROFILE_XML = `<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" name="device" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="properties" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" name="device" direction="in"/>
    </method>
  </interface>
</node>`

let registered = false

const profile = {
    Release() {
        registered = false
    },
    NewConnectionAsync([device, index]: [string, number, unknown], invocation: Gio.DBusMethodInvocation) {
        let fd = -1
        try {
            fd = invocation.get_message().get_unix_fd_list()?.get(index) ?? -1
        } catch (e) {
            log.warn("bluez's AirPods socket didn't come:", e)
        }
        invocation.return_value(null)
        log.debug("AirPods channel open")
        if (fd >= 0) open(device, fd)
    },
    RequestDisconnection(device: string) {
        links.get(device)?.cancel.cancel()
    },
}

// ─── Which, and when ──────────────────────────────────────────────────────────
// From bluez's own objects and signals: Astal's devices carry no UUIDs.

// (audio: their audio is set up, a media transport under the device. Asked
// for while they're still connecting themselves, the channel came and the
// AirPods never said a word on it)
type Device = { uuids: string[], connected: boolean, audio: Set<string>, name: string }
const devices = new Map<string, Device>()
const connecting = new Set<string>()

function reach(path: string, tries = 0) {
    const device = devices.get(path)
    if (!device?.connected) return links.get(path)?.cancel.cancel()
    if (!registered || !device.audio.size || !device.uuids.includes(AAP) || links.has(path) || (connecting.has(path) && !tries)) return
    connecting.add(path)
    log.debug(tries ? `connecting the AirPods channel (again, ${tries})` : "connecting the AirPods channel")
    bluez(path, "org.bluez.Device1", "ConnectProfile", new GLib.Variant("(s)", [AAP])).then(() => connecting.delete(path), e => {
        log.debug("AirPods channel:", e)
        if (Gio.DBusError.get_remote_error(e) === "org.bluez.Error.InProgress" && tries < RETRIES) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
                reach(path, tries + 1)
                return GLib.SOURCE_REMOVE
            })
            return
        }
        connecting.delete(path)
    })
}

function know(path: string, properties: Record<string, GLib.Variant>) {
    const device = devices.get(path) ?? { uuids: [], connected: false, audio: new Set<string>(), name: "" }
    if (properties.UUIDs) device.uuids = properties.UUIDs.deepUnpack() as string[]
    if (properties.Connected) device.connected = properties.Connected.deepUnpack() as boolean
    if (properties.Alias) device.name = properties.Alias.deepUnpack() as string
    devices.set(path, device)
    reach(path)
}

type Objects = Record<string, Record<string, Record<string, GLib.Variant>>>

// a transport's device: /org/bluez/hci0/dev_74_77_86_8F_37_AC/sep1/fd0
const deviceOf = (transport: string) => transport.match(/^\/org\/bluez\/[^/]+\/dev_[0-9A-F_]+/)?.[0] ?? ""

function audio(transport: string, there: boolean) {
    const path = deviceOf(transport)
    const device = devices.get(path)
    if (!device) return
    if (there) device.audio.add(transport)
    else device.audio.delete(transport)
    reach(path)
}

function register() {
    bluez("/org/bluez", "org.bluez.ProfileManager1", "RegisterProfile", new GLib.Variant("(osa{sv})", [PROFILE_PATH, AAP, {
        Name: new GLib.Variant("s", "AirPods"),
        Role: new GLib.Variant("s", "client"),
    }])).then(() => {
        registered = true
        return bluez("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects")
    }).then(reply => {
        const [objects] = reply.deepUnpack() as [Objects]
        for (const [path, ifaces] of Object.entries(objects))
            if (ifaces["org.bluez.Device1"]) know(path, ifaces["org.bluez.Device1"])
        for (const [path, ifaces] of Object.entries(objects))
            if (ifaces["org.bluez.MediaTransport1"]) audio(path, true)
    }, e => log.warn("bluez didn't take the AirPods profile:", e))
}

function follow(bus: Gio.DBusConnection) {
    bus.signal_subscribe("org.bluez", "org.freedesktop.DBus.Properties", "PropertiesChanged", null, "org.bluez.Device1",
        Gio.DBusSignalFlags.NONE, (_bus, _sender, path, _iface, _signal, params) => {
            const [, changed] = params.deepUnpack() as [string, Record<string, GLib.Variant>]
            if (changed.UUIDs || changed.Connected || changed.Alias) know(path, changed)
        })
    bus.signal_subscribe("org.bluez", "org.freedesktop.DBus.ObjectManager", "InterfacesAdded", "/", null,
        Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
            const [path, ifaces] = params.deepUnpack() as [string, Objects[string]]
            if (ifaces["org.bluez.Device1"]) know(path, ifaces["org.bluez.Device1"])
            if (ifaces["org.bluez.MediaTransport1"]) audio(path, true)
        })
    bus.signal_subscribe("org.bluez", "org.freedesktop.DBus.ObjectManager", "InterfacesRemoved", "/", null,
        Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
            const [path, ifaces] = params.deepUnpack() as [string, string[]]
            if (ifaces.includes("org.bluez.MediaTransport1")) audio(path, false)
            if (ifaces.includes("org.bluez.Device1")) {
                devices.delete(path)
                links.get(path)?.cancel.cancel()
            }
            // (a resume: the adapter comes back new, without the batteries)
            if (ifaces.includes("org.bluez.Adapter1")) providing.delete(path)
        })
}

// (held: GJS collects an exported object nothing holds, and bluez's next
// NewConnection found nothing there)
let exported: Gio.DBusExportedObject | null = null

/** Each AirPods' charge and ears, while they're connected. */
export default function airpodsService() {
    if (exported) return
    const bus = Gio.DBus.system
    try {
        exported = Gio.DBusExportedObject.wrapJSObject(PROFILE_XML, profile)
        exported.export(bus, PROFILE_PATH)
        batteries.set_connection(bus)
    } catch (e) {
        log.error("failed to export the AirPods profile:", e)
        return
    }
    follow(bus)
    Gio.bus_watch_name_on_connection(bus, "org.bluez", Gio.BusNameWatcherFlags.NONE,
        () => register(),
        () => {
            registered = false
            providing.clear()
            devices.clear()
            connecting.clear()
            for (const link of links.values()) link.cancel.cancel()
        })
}
