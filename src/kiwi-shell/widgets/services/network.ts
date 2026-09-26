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
    const id = net.client.connect("device-added", (_client: NM.Client, device: NM.Device) => {
        if (!(device instanceof NM.DeviceWifi || device instanceof NM.DeviceEthernet)) return
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
