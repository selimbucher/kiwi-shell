import { createState, createBinding, createComputed, For, With } from "ags"
import { execAsync } from "ags/process"
import Network from "gi://AstalNetwork"
import { Gtk } from "ags/gtk4"

import { openWifiPrompt } from "../../../prompts"
import { wifiIcon } from "../../../iconNames"

const network = Network.get_default()
const wifi = network.wifi

const wifiEnabledRaw = createBinding(wifi, "enabled")
const [frozen, setFrozen] = createState(false)
const [frozenValue, setFrozenValue] = createState(wifi?.enabled)

const wifiEnabledBinding = createComputed((get) => {
  if (get(frozen)) return get(frozenValue)
  return get(wifiEnabledRaw)
})

export function rescanWifi() {
  wifi.scan()
}

export default function NetworkTab({ visible }) {
  const accessPointsBinding = createComputed((get) => {
    const aps = get(createBinding(wifi, "accessPoints"))
    const activeAP = get(createBinding(wifi, "activeAccessPoint"))

    // Filter out hidden networks
    const visibleAPs = aps.filter((ap) => ap.ssid && ap.ssid.trim() !== "")

    // Group by SSID and keep only the strongest AP for each network
    const uniqueNetworks = visibleAPs.reduce((acc, ap) => {
      const existing = acc.get(ap.ssid)
      if (!existing || ap.strength > existing.strength) {
        acc.set(ap.ssid, ap)
      }
      return acc
    }, new Map())

    // Sort: active network first, then by strength
    return Array.from(uniqueNetworks.values()).sort((a, b) => {
      const aIsActive = activeAP?.ssid === a.ssid
      const bIsActive = activeAP?.ssid === b.ssid

      if (aIsActive && !bIsActive) return -1
      if (!aIsActive && bIsActive) return 1

      return b.strength - a.strength
    })
  })

  const [rotation, setRotation] = createState(0)
  return (
    <box
      class="tab-content"
      visible={visible}
      orientation={Gtk.Orientation.VERTICAL}
    >
      <box class="section-header">
        <box halign={Gtk.Align.START}>Wi-Fi</box>
        <button
          class="refresh-button"
          visible={false}
          onClicked={() => {
            wifi.scan()
            setRotation(rotation.get() + 180)
          }}
          css={rotation((r) => `transform: rotate(${r}deg);`)}
        >
          <Gtk.Image iconName="update-symbolic" pixelSize={14} />
        </button>
        <box hexpand={true} />

        <switch
          active={wifiEnabledBinding}
          onStateSet={(self, state) => {
            wifi.enabled = state
            setFrozenValue(state)
            setFrozen(true)
            setTimeout(() => setFrozen(false), 2000)
            return false
          }}
        />
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand={true}>
        <For each={accessPointsBinding}>{(ap) => AccessPoint(ap)}</For>
      </box>
    </box>
  )
}

const stateBinding = createBinding(wifi, "state")

function AccessPoint(ap) {
  const isConnectingBinding = createComputed((get) => {
    const activeAP = get(createBinding(wifi, "activeAccessPoint"))
    const state = get(stateBinding)
    return (
      (activeAP?.ssid === ap.ssid && state === Network.DeviceState.IP_CONFIG) ||
      state === Network.DeviceState.PREPARE ||
      state === Network.DeviceState.CONFIG
    )
  })

  const isActiveBinding = createComputed((get) => {
    const activeAP = get(createBinding(wifi, "activeAccessPoint"))
    const state = get(stateBinding)
    return activeAP?.ssid === ap.ssid && state === Network.DeviceState.ACTIVATED
  })

  const isFocusedBinding = createComputed((get) => {
    const focusedAP = get(createBinding(wifi, "activeAccessPoint"))
    return focusedAP?.ssid === ap.ssid
  })

  return (
    <button
      class={isActiveBinding.as((isActive) =>
        isActive ? "network-item active" : "network-item",
      )}
      onClicked={() => {
        if (isActiveBinding()) {
          return
        }
        onNetworkClick(ap.ssid, ap.flags !== 0).catch((e) => {
          if (
            String(e).includes("Secrets were required, but not provided") ||
            String(e).includes("property is invalid")
          ) {
            openWifiPrompt(ap.ssid, true)
          }
        })
      }}
    >
      <box spacing={8}>
        <Gtk.Image
          class="networkIcon"
          pixelSize={16}
          iconName={createBinding(ap, "strength").as((s) => wifiIcon(s))}
        />
        <label
          label={ap.ssid || "Hidden Network"}
          hexpand={true}
          halign={Gtk.Align.START}
        />
        <label label="Connected" visible={isActiveBinding} />
        {ap.flags !== 0 && (
          <Gtk.Image
            pixelSize={14}
            iconName="network-wireless-encrypted-symbolic"
          />
        )}
      </box>
    </button>
  )
}

async function onNetworkClick(ssid: string, secured: boolean) {
  const saved = await hasSavedPassword(ssid)
  if (saved) {
    await execAsync(`nmcli con up "${ssid}"`)
  } else {
    if (secured) openWifiPrompt(ssid)
    else await execAsync(`nmcli device wifi connect "${ssid}"`)
  }
}

async function hasSavedPassword(ssid: string): Promise<boolean> {
  try {
    await execAsync(`nmcli -s connection show "${ssid}"`)
    return true
  } catch (e) {
    return false
  }
}
