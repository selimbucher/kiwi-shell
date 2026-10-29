import { createState, createBinding, createComputed, For, With } from "ags"
import { execAsync } from "ags/process"
import Network from "gi://AstalNetwork"
import { Gtk } from "ags/gtk4"

import { openWifiPrompt } from "../../../prompts"
import { ContextMenu } from "../../../ContextMenu"
import { wifiIcon } from "../../../iconNames"
import { logger } from "../../../../log"
import { network, wifiProperty, currentWifi, savedWifiProfile } from "../../../services/network"
import { openChoicePrompt } from "../../../prompts"
const log = logger("network")

// The current Wi-Fi device, followed across NetworkManager restarts
// (services/network.ts). A machine can have none at all, so everything here
// tolerates its absence.
const wifiEnabledRaw = wifiProperty("enabled", false)
const scanningBinding = wifiProperty("scanning", false)
const stateBinding = wifiProperty("state", Network.DeviceState.UNKNOWN)

const [frozen, setFrozen] = createState(false)
let unfreeze: ReturnType<typeof setTimeout> | null = null
const [frozenValue, setFrozenValue] = createState(currentWifi()?.enabled ?? false)

const wifiEnabledBinding = createComputed((get) =>
  get(frozen) ? get(frozenValue) : get(wifiEnabledRaw),
)

// NetworkManager reports PREPARE/CONFIG/IP_CONFIG on the *device*, not per
// access point, and activeAccessPoint still points at the previous network
// until association succeeds. So the row that started the attempt is remembered
// here — otherwise every row in the list lights up as "Connecting…".
const [connectingSsid, setConnectingSsid] = createState("")

export function rescanWifi() {
  currentWifi()?.scan()
}

export default function NetworkTab({ visible }) {
  const accessPointsBinding = createComputed((get) => {
    const wifi = get(network).wifi
    if (!wifi) return []
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

  const emptyLabel = createComputed((get) => {
    if (!get(wifiEnabledBinding)) return "Wi-Fi is off"
    if (get(accessPointsBinding).length > 0) return ""
    // The menu kicks off a scan on open, so an empty list is usually just an
    // unfinished scan rather than a dead radio.
    return get(scanningBinding) ? "Searching…" : "No networks found"
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
          visible={wifiEnabledBinding}
          onClicked={() => {
            currentWifi()?.scan()
            setRotation(rotation.get() + 180)
          }}
          css={rotation((r) => `transform: rotate(${r}deg);`)}
        >
          <box>
            <Gtk.Image
              iconName="update-symbolic"
              pixelSize={14}
              visible={scanningBinding((s) => !s)}
            />
            <Gtk.Spinner
              class="refresh-spinner"
              spinning={scanningBinding}
              visible={scanningBinding}
            />
          </box>
        </button>
        <box hexpand={true} />

        <switch
          active={wifiEnabledBinding}
          onStateSet={(self, state) => {
            const wifi = currentWifi()
            if (wifi) wifi.enabled = state
            setFrozenValue(state)
            setFrozen(true)
            // the last flip's: an earlier one's let go mid-change
            if (unfreeze) clearTimeout(unfreeze)
            unfreeze = setTimeout(() => { unfreeze = null; setFrozen(false) }, 2000)
            return false
          }}
        />
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} vexpand={true}>
        <label
          class="list-empty"
          halign={Gtk.Align.START}
          label={emptyLabel}
          visible={emptyLabel((l) => l !== "")}
        />
        <For each={accessPointsBinding}>{(ap) => AccessPoint(ap)}</For>
      </box>
    </box>
  )
}

function AccessPoint(ap) {
  const isConnectingBinding = createComputed((get) => {
    const state = get(stateBinding)
    const busy =
      state === Network.DeviceState.PREPARE ||
      state === Network.DeviceState.CONFIG ||
      state === Network.DeviceState.IP_CONFIG
    return busy && get(connectingSsid) === ap.ssid
  })

  const isActiveBinding = createComputed((get) => {
    const wifi = get(network).wifi
    const activeAP = wifi ? get(createBinding(wifi, "activeAccessPoint")) : null
    const state = get(stateBinding)
    return activeAP?.ssid === ap.ssid && state === Network.DeviceState.ACTIVATED
  })

  // Only a saved connection profile can be forgotten, and nmcli is the only one
  // who knows. Asking when the menu opens keeps it to one subprocess per
  // right-click instead of one per row on every list rebuild.
  const [saved, setSaved] = createState(false)

  const menu = NetworkContextMenu(ap, isActiveBinding, saved)

  return (
    <button
      class={isActiveBinding.as((isActive) =>
        isActive ? "network-item active" : "network-item",
      )}
      // The network joined already is just that, as on a Mac (Disconnect is
      // in its menu); clicked, it was dropped.
      onClicked={() => {
        if (isActiveBinding()) return
        join(ap.ssid, ap.flags !== 0)
      }}
      $={(self) => {
        const gesture = new Gtk.GestureClick()
        gesture.set_button(3)
        gesture.connect("released", () => {
          // A network we have never joined and are not on has nothing to offer,
          // so resolve the saved state first and skip the empty menu entirely.
          hasSavedPassword(ap.ssid).then((isSaved) => {
            setSaved(isSaved)
            if (isSaved || isActiveBinding()) menu.popup()
          })
        })
        self.add_controller(gesture)
      }}
    >
      <box spacing={8}>
        {menu}
        <Gtk.Image
          class="networkIcon"
          pixelSize={16}
          iconName={createComputed((get) => {
            const strength = get(createBinding(ap, "strength"))
            const isActive = get(isActiveBinding)
            if (!isActive) return wifiIcon(strength)
            const wired = get(network).wired
            const wiredState = wired ? get(createBinding(wired, "state")) : 0
            return networkIcon(wiredState, strength)
          })}
        />
        <label
          label={ap.ssid || "Hidden Network"}
          hexpand={true}
          halign={Gtk.Align.START}
        />
        <label label="Connecting…" visible={isConnectingBinding} />
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

function NetworkContextMenu(ap, isActiveBinding, savedBinding) {
  return ContextMenu({
    class: "app-context-menu network-context-menu",
    items: [
      {
        label: "Disconnect",
        icon: "network-offline-symbolic",
        visible: isActiveBinding,
        onClick: () => disconnectNetwork(ap.ssid),
      },
      {
        label: "Forget Network",
        icon: "user-trash-symbolic",
        visible: savedBinding,
        // its password goes with it, so asked first
        onClick: () => openChoicePrompt("Forget Network",
          `Forget the network “${ap.ssid}”? You'll need its password to join it again.`,
          [{ label: "Forget", primary: true, run: () => forgetNetwork(ap.ssid) }]),
      },
    ],
  })
}

function networkIcon(wiredState, strength) {
    if (wiredState == 100) {
      return "network-wired-activated-symbolic"
    }
    return wifiIcon(strength)
}

// Joining, "Connecting…" on its row meanwhile. A password wrong or missing
// asks for it; anything else that stops it says so, rather than the row just
// going back to how it was.
function join(ssid: string, secured: boolean) {
  setConnectingSsid(ssid)
  onNetworkClick(ssid, secured)
    .catch((e) => failed(ssid, e, () => join(ssid, secured)))
    .finally(() => setConnectingSsid(""))
}

// with the password typed in: "Connecting…" from Join until it's done
function joinWith(ssid: string, password: string) {
  setConnectingSsid(ssid)
  nmcli("device", "wifi", "connect", ssid, "password", password)
    .catch((e) => failed(ssid, e, () => askPassword(ssid, false)))
    .finally(() => setConnectingSsid(""))
}

const askPassword = (ssid: string, wrong: boolean) =>
  openWifiPrompt(ssid, wrong, (password) => joinWith(ssid, password))

function failed(ssid: string, e: unknown, retry: () => void) {
  const error = String(e)
  if (error.includes("Secrets were required, but not provided") || error.includes("property is invalid")) {
    askPassword(ssid, true)
    return
  }
  log.error(`joining ${ssid}:`, e)
  const reason = error.includes("Insufficient privileges")
    ? "You aren't allowed to change the network settings."
    : error.split("\n").map(l => l.replace(/^.*?Error:\s*/, "").trim()).filter(Boolean).pop()
  openChoicePrompt(`Couldn't join “${ssid}”`, reason ?? "The network couldn't be joined.",
    [{ label: "Try Again", primary: true, run: retry }])
}

// The network's name goes to nmcli as one argument of its own, never inside
// a command line: a name is anything a nearby access point cares to send,
// quotes included, and quoted into a line one could add arguments of its own.
// nmcli in English whatever the language: what went wrong is read off it.
export const nmcli = (...args: string[]) => execAsync(["env", "LC_ALL=C", "nmcli", ...args])

async function onNetworkClick(ssid: string, secured: boolean) {
  const saved = savedWifiProfile(ssid)
  if (saved) {
    await nmcli("connection", "up", "uuid", saved.get_uuid())
  } else {
    if (secured) askPassword(ssid, false)
    else await nmcli("device", "wifi", "connect", ssid)
  }
}

async function disconnectNetwork(ssid: string) {
  const saved = savedWifiProfile(ssid)
  try {
    if (saved) await nmcli("connection", "down", "uuid", saved.get_uuid())
    else await nmcli("connection", "down", "id", ssid)
  } catch (e) {
    log.error("Disconnect failed:", e)
  }
}

// Deleting the profile is what "forget" means to NetworkManager: it drops the
// saved secret too, so the next click prompts for the password again.
async function forgetNetwork(ssid: string) {
  const saved = savedWifiProfile(ssid)
  if (!saved) return
  try {
    await nmcli("connection", "delete", "uuid", saved.get_uuid())
  } catch (e) {
    log.error("Forget failed:", e)
  }
}

async function hasSavedPassword(ssid: string): Promise<boolean> {
  return savedWifiProfile(ssid) !== null
}
