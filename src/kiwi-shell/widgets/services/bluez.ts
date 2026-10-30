import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalBluetooth from "gi://AstalBluetooth"

// ─── bluez, without waiting for it ────────────────────────────────────────────
// Astal's adapter calls (discovery, power, visibility, forgetting a device)
// and its property writes are synchronous D-Bus calls: the shell stood still
// until bluez answered, a second and more while the controller was busy with
// a connection. The same calls here, answered later. Astal doesn't say where
// its objects are on the bus, so their paths are worked out here too.

/** A device's bluez object: under its adapter's, by its address. */
export const devicePath = (device: AstalBluetooth.Device) =>
    `${device.adapter}/dev_${(device.address ?? "").replace(/:/g, "_")}`

/** One of bluez's methods, its reply. */
export function call(path: string, iface: string, method: string,
    args: GLib.Variant | null = null, timeout = 25_000): Promise<GLib.Variant> {
    return new Promise((resolve, reject) =>
        Gio.DBus.system.call("org.bluez", path, iface, method, args, null,
            Gio.DBusCallFlags.NONE, timeout, null, (bus, result) => {
                try {
                    resolve(bus!.call_finish(result))
                } catch (e) {
                    reject(e)
                }
            }))
}

export const setProperty = (path: string, iface: string, name: string, value: GLib.Variant) =>
    call(path, "org.freedesktop.DBus.Properties", "Set", new GLib.Variant("(ssv)", [iface, name, value]))

// looked up once for each (a resume brings a new adapter, looked up anew)
const adapterPaths = new WeakMap<AstalBluetooth.Adapter, Promise<string>>()

/** The adapter's bluez object, by its address. */
export function adapterPath(adapter: AstalBluetooth.Adapter): Promise<string> {
    let path = adapterPaths.get(adapter)
    if (!path) {
        path = call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects").then(reply => {
            const [objects] = reply.deepUnpack() as [Record<string, Record<string, Record<string, GLib.Variant>>>]
            const adapters = Object.keys(objects).filter(p => objects[p]["org.bluez.Adapter1"])
            const found = adapters.find(p => objects[p]["org.bluez.Adapter1"].Address?.unpack() === adapter.address)
                ?? adapters[0]
            if (!found) throw new Error("bluez has no adapter")
            return found
        })
        // (asked again next time)
        path.catch(() => adapterPaths.delete(adapter))
        adapterPaths.set(adapter, path)
    }
    return path
}

/** One of the adapter's methods; false where bluez refused it. */
export function onAdapter(adapter: AstalBluetooth.Adapter | undefined, method: string,
    args: GLib.Variant | null = null): Promise<boolean> {
    if (!adapter) return Promise.resolve(false)
    return adapterPath(adapter)
        .then(path => call(path, "org.bluez.Adapter1", method, args))
        .then(() => true, () => false)
}

/** One of the adapter's settings (Powered, Discoverable, Pairable). */
export function setAdapter(adapter: AstalBluetooth.Adapter, name: string, value: boolean): Promise<void> {
    return adapterPath(adapter)
        .then(path => setProperty(path, "org.bluez.Adapter1", name, GLib.Variant.new_boolean(value)))
        .then(() => {})
}
