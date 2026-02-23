import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createEffect, For } from "ags"
import { monitorFile } from "ags/file"
import Hyprland from "gi://AstalHyprland"
import { primaryColor, conf } from "./config"
import { initWindowCacher } from "./clientCachingService"
import filterApp from "./filterAppIcons"

export const [isVisible, setVisibility] = createState(false)

// State to track the selected client using its unique Hyprland address
export const [selectedAddress, setSelectedAddress] = createState<string | null>(null)

// State to hold the sorted clients while the switcher is open
export const [displayedClients, setDisplayedClients] = createState<any[]>([])

const hyprland = Hyprland.get_default()

// --- MRU (Most Recently Used) Tracking ---
let mruAddresses: string[] = []

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    if (client) {
        const addr = client.get_address()
        // Entferne die Adresse, falls vorhanden, und setze sie an den Anfang
        mruAddresses = [addr, ...mruAddresses.filter(a => a !== addr)]
        
        // Begrenze die Liste, um Speicherlecks über lange Laufzeiten zu vermeiden
        if (mruAddresses.length > 50) {
            mruAddresses.length = 50
        }
    }
})
// -----------------------------------------

// Start the background service
initWindowCacher(isVisible)

export function toggleAppSwitcher(cmd: string) {
    switch (cmd) {
      case "open":
        showAppSwitcher()
        break
      case "open-next":
        if (!isVisible())
          showAppSwitcher()
        selectNextClient()
        break
      case "close":
        hideAppSwitcher()
        break
      case "toggle":
        if (isVisible())
          hideAppSwitcher()
        else
          showAppSwitcher()
        break
      case "next":
        selectNextClient()
        break
      case "previous":
        selectPreviousClient()
        break
      case "confirm":
        executeSelectedAndClose()
        break
    }
}

function showAppSwitcher() {
  const clients = hyprland.get_clients()
  
  // Sortiere die aktuellen Fenster anhand der MRU-Historie
  const sortedClients = [...clients].sort((a, b) => {
      const indexA = mruAddresses.indexOf(a.get_address())
      const indexB = mruAddresses.indexOf(b.get_address())
      
      // Wenn ein Fenster noch nie fokussiert wurde, ans Ende der Liste setzen
      const posA = indexA === -1 ? 9999 : indexA
      const posB = indexB === -1 ? 9999 : indexB
      
      return posA - posB
  })
  
  setDisplayedClients(sortedClients)

  if (sortedClients.length > 0) {
      setSelectedAddress(sortedClients[0].get_address())
  } else {
      setSelectedAddress(null)
  }
  
  setVisibility(true)
}

function hideAppSwitcher() {
  setVisibility(false)
}

function selectNextClient() {
    if (!isVisible())
      return
    
    const clients = displayedClients()
    if (clients.length === 0) return

    const currentAddr = selectedAddress()
    const currentIndex = clients.findIndex(c => c.get_address() === currentAddr)
    
    const nextIndex = (currentIndex + 1) % clients.length
    setSelectedAddress(clients[nextIndex].get_address())
}

function selectPreviousClient() {
    if (!isVisible())
      return
      
    const clients = displayedClients()
    if (clients.length === 0) return

    const currentAddr = selectedAddress()
    const currentIndex = clients.findIndex(c => c.get_address() === currentAddr)
    
    const prevIndex = (currentIndex - 1 + clients.length) % clients.length
    setSelectedAddress(clients[prevIndex].get_address())
}

function executeSelectedAndClose() {
    const currentAddr = selectedAddress()
    const clients = displayedClients()
    const selectedClient = clients.find(c => c.get_address() === currentAddr)
    
    if (selectedClient) {
        console.log(`Selected Client: ${selectedClient.get_title()} (Address: ${currentAddr})`)
        selectedClient.focus()
    }
    
    setVisibility(false)
}

export default function AppSwitcher(gdkmonitor: Gdk.Monitor) {
  return (
    <window
      css={primaryColor((hex: string) => `--primary: ${hex};`)}
      visible={isVisible}
      name="ags-app-switcher"
      class={conf.as((conf: any) => `AppSwitcher theme-${conf.theme}`)}
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={
        Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT
      }
      application={app}
      layer={Astal.Layer.TOP}
    >
      <Windows />
    </window>
  )
}

function Windows() {
    // Nutzt nun den statischen State anstatt des direkten Live-Bindings,
    // damit die Reihenfolge stabil bleibt, solange das Menü offen ist.
    return (
        <centerbox class="app-switch-menu">
            <box $type="center" class="app-switch-container" spacing={4}>
                <For each={displayedClients}>
                    {(client) => <WindowPreview client={client} />}
                </For>
            </box>
        </centerbox>
    )
}

export function WindowPreview({ client }: { client: any }) {
    if (!client) return null

    const address = client.get_address()
    const path = `/tmp/win-cache-${address}.png`
    
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    const updateTexture = () => {
        try {
            setTexture(Gdk.Texture.new_from_filename(path))
        } catch (e) {
            // Silent catch if file isn't ready
        }
    }

    updateTexture()
    monitorFile(path, updateTexture)

    const container = (
        <box 
            orientation={Gtk.Orientation.VERTICAL} 
            spacing={8} 
            class="window-preview"
        >
            <scrolledwindow hscrollbarPolicy={Gtk.PolicyType.EXTERNAL} vscrollbarPolicy={Gtk.PolicyType.NEVER}>
                  <box><AppIcon client={client}/> <label label={client.get_title()} /></box>
            </scrolledwindow>
            
            <box>
                <Gtk.ScrolledWindow
                    class="window-preview-container"
                    overflow={Gtk.Overflow.HIDDEN}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.NEVER}
                    heightRequest={160} 
                    propagateNaturalWidth={true}
                >
                    <Gtk.Picture
                        canShrink={true}
                        contentFit={Gtk.ContentFit.CONTAIN}
                        heightRequest={150}
                        widthRequest={-1} 
                        paintable={texture}
                    />
                </Gtk.ScrolledWindow>
            </box>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedAddress() === address) {
            container.add_css_class("selected")
        } else {
            container.remove_css_class("selected")
        }
    })

    return container
}

export function AppIcon({ client }: { client: any }) {
    if (!client) return null

    const appClass = client.get_class()

    const iconName = appClass ? appClass : "application-x-executable"
    return (
        <Gtk.Image
            iconName={filterApp(iconName)}
            pixelSize={24}
        />
    )
}