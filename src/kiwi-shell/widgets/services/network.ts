import Network from "gi://AstalNetwork"
import NM from "gi://NM"
import { createBinding, createComputed, createState } from "ags"
import { logger } from "../../log"

const log = logger("network")

// AstalNetwork builds its Wi-Fi and wired objects once, from the devices
// NetworkManager has when it is first asked. When NetworkManager restarts —
// a system rebuild, a package update — its devices come back as new objects
// and the old ones go dead: no connection, no networks, the Wi-Fi menu
// searching forever. So a device coming back means a fresh Network, and
// everything that shows the network follows this rather than holding on to
// the first one.
export const [network, setNetwork] = createState(Network.get_default())

let watched: { client: NM.Client; id: number } | null = null

function watch(net: Network.Network) {
    if (watched) watched.client.disconnect(watched.id)
    watched = null
    // no NetworkManager (another network manager, or none): no network
    // devices to show, and none coming back
    if (!net.client) {
        log.info("no NetworkManager: the network goes unshown")
        return
    }
    const id = net.client.connect("device-added", (_client: NM.Client, device: NM.Device) => {
        // by type: a container's virtual cable (veth) is an Ethernet device to
        // GObject, and each one built the whole Network again
        const type = device.get_device_type()
        if (type !== NM.DeviceType.WIFI && type !== NM.DeviceType.ETHERNET) return
        const current = network.get()
        if (device === current.wifi?.device || device === current.wired?.device) return
        log.info(`NetworkManager brought back ${device.get_iface()}, following it`)
        const next = new Network.Network()
        watch(next)
        setNetwork(next)
    })
    watched = { client: net.client, id }
}

watch(network.get())

/** A property of the current Wi-Fi device, or `fallback` while there is none. */
export function wifiProperty<T>(name: string, fallback: T) {
    return createComputed(get => {
        const wifi = get(network).wifi
        return wifi ? get(createBinding(wifi, name as any)) as T : fallback
    })
}

/** The current Wi-Fi device, if any: for acting on it, not for showing it. */
export const currentWifi = () => network.get().wifi

/**
 * The saved profile for a Wi-Fi network, by its SSID: a profile's name is
 * only the SSID until it is renamed, copied ("Home 1") or written by a
 * system config, and by name those were neither joined nor forgotten. The
 * last one used, when there are several.
 */
export function savedWifiProfile(ssid: string): NM.RemoteConnection | null {
    const client = network.get().client
    if (!client) return null
    let best: NM.RemoteConnection | null = null
    for (const conn of client.get_connections()) {
        const bytes = conn.get_setting_wireless()?.get_ssid()
        const data = bytes?.get_data()
        if (!data || NM.utils_ssid_to_utf8(data) !== ssid) continue
        const used = (c: NM.RemoteConnection) => c.get_setting_connection()?.get_timestamp() ?? 0
        if (!best || used(conn) > used(best)) best = conn
    }
    return best
}
