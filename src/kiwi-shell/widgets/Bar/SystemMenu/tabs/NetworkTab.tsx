import { createState, createBinding, createComputed, For, With } from "ags"
import { execAsync } from "ags/process"
import Network from "gi://AstalNetwork"
import { Gtk } from "ags/gtk4"

const network = Network.get_default()
const wifi = network.wifi
const wifiEnabledBinding = createBinding(wifi, "enabled");

export function rescanWifi(){
  wifi.scan()
}

export default function NetworkTab({ visible }) {
    const accessPointsBinding = createComputed((get) => {
      const aps = get(createBinding(wifi, "accessPoints"))
      const activeAP = get(createBinding(wifi, "activeAccessPoint"))
      
      // Filter out hidden networks
      const visibleAPs = aps.filter(ap => ap.ssid && ap.ssid.trim() !== "")
      
      // Group by SSID and keep only the strongest AP for each network
      const uniqueNetworks = visibleAPs.reduce((acc, ap) => {
        const existing = acc.get(ap.ssid)
        if (!existing || ap.strength > existing.strength) {
          acc.set(ap.ssid, ap)
        }
        return acc
      }, new Map())

      // Sort: active network first, then by strength
      return Array.from(uniqueNetworks.values())
        .sort((a, b) => {
          const aIsActive = activeAP?.ssid === a.ssid
          const bIsActive = activeAP?.ssid === b.ssid
          
          if (aIsActive && !bIsActive) return -1
          if (!aIsActive && bIsActive) return 1
          
          return b.strength - a.strength
        })
    })

  const [rotation, setRotation] = createState(0)
  return (
    <box class="tab-content" visible={visible} orientation={Gtk.Orientation.VERTICAL}>
      <box class="section-header">
        <box halign={Gtk.Align.START}>Wi-Fi</box>
        <button class="refresh-button"
            visible={false}
            onClicked={() => {
            wifi.scan()
            setRotation(rotation.get() + 180)
          }}
          css={rotation(r => `transform: rotate(${r}deg);`)}
        >
          <Gtk.Image
            iconName="update-symbolic"
            pixelSize={14}
          />
          
        </button>
        <box hexpand={true} />
        
        <switch
          active={wifiEnabledBinding}
          onStateSet={(self, state) => {
            wifi.enabled = state
            return false
          }}
        />
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand={true}>
        <For each={accessPointsBinding}>
          {(ap) => AccessPoint(ap)}
        </For>
      </box>
    </box>
  )
}



function getSignalIcon(strength: number) {
    if (strength >= 80) return "network-wireless-signal-excellent-symbolic"
    if (strength >= 60) return "network-wireless-signal-good-symbolic"
    if (strength >= 40) return "network-wireless-signal-ok-symbolic"
    if (strength >= 20) return "network-wireless-signal-weak-symbolic"
    return "network-wireless-signal-none-symbolic"
}

function AccessPoint(ap) {
  const isActiveBinding = createBinding(wifi, "activeAccessPoint").as(
    activeAP => activeAP?.ssid === ap.ssid
  )
    
 return (
  <button 
    class={isActiveBinding.as(isActive => isActive ? "network-item active" : "network-item")}
      onClicked={() => {
      if (!wifi.activeAccessPoint || wifi.activeAccessPoint.ssid !== ap.ssid) {
        execAsync(`nmcli device wifi connect "${ap.ssid}"`)
        .catch(err => console.error("Failed to connect: ", err))
      }
    }}
  >
    <box spacing={8}>
        <Gtk.Image 
        class="networkIcon"
        pixelSize={16}
        iconName={createBinding(ap, "strength").as(s => getSignalIcon(s))}
        />
        <label label={ap.ssid || "(Hidden Network)"} hexpand={true} halign={Gtk.Align.START} />
        <label
        label = "Connected"
        visible={isActiveBinding}
        />
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