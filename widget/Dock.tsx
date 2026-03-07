import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For } from "ags"
import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { conf, primaryColor } from "./config"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix"

import filterApp from "./filterAppIcons"

import Apps from "gi://AstalApps"
import Hyprland from "gi://AstalHyprland"

const hyprland = Hyprland.get_default()

const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/desktop/dock-apps.json`

const initialAppList = JSON.parse(readFile(APPLIST_FILE))
export const [list, setList] = createState(initialAppList)

async function saveList() {
    const currentList = list()
        .map(({ pinned, ...rest }) => rest)

    const jsonString = JSON.stringify(currentList, null, 2);
    
    try {
        await writeFileAsync(APPLIST_FILE, jsonString)
    } catch (error) {
        console.error("Failed to save config:", error)
    }
}


export default function Dock(gdkmonitor: Gdk.Monitor) {

  return (
    <window
      css={primaryColor(hex => 
        `--primary: ${hex};`
      )}
      name="ags-dock"
      class={conf.as(conf =>
        `Dock theme-${conf.theme}`
      )}
      gdkmonitor={gdkmonitor}
      exclusivity={conf.as(conf =>
        conf.dock == "auto-hide" ? Astal.Exclusivity.NORMAL : Astal.Exclusivity.EXCLUSIVE
      )}
      anchor={
        Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT
      }
      visible={conf.as(conf =>
        conf.dock != "disabled"
    )}
      application={app}
      layer={Astal.Layer.TOP}
    >
      <DockBar />
    </window>
  )
}

function DockBar(){
  const unpinnedList = createComputed(get => {
    const clients = get(createBinding(hyprland, "clients"))
    const unpinnedClients = clients.filter(client => {
      const pinned = get(list).map(app => app.entry)
      return !pinned.includes(client["initial-class"]+".desktop")
    })
    const seen = new Set()
    const unpinnedApps = unpinnedClients.reduce((acc, client) => {
      const icon = filterApp(client["initial-class"])
      if (seen.has(icon)) return acc
      seen.add(icon)
      acc.push({
        "entry": (client["initial-class"]+".desktop"),
        "icon": icon,
        "name": client.title.split("- ").at(-1),
        "pinned": false
      })
      return acc
    }, [])
    return unpinnedApps;
  })
  return (
      <centerbox class="dock-bar">
        <box $type="center" class="dock-box" orientation={Gtk.Orientation.HORIZONTAL}>
          <For each={list}>
              {(app) => <AppIcon app={app} />}
          </For>
          <box vexpand={true} class="dock-spacer" visible={unpinnedList.as(list => list.length > 0)}/>
          <For each={unpinnedList}>
              {(app) => <AppIcon app={app} />}
          </For>
        </box>
      </centerbox>
    )
}

function AppIcon({ app }){
  const initClass = app.entry.split(".").slice(0,-1).join(".");
  const application = GioUnix.DesktopAppInfo.new(app.entry)

  const [pinned, setPinned] = createState(app.pinned !== false)

  const clientsBinding = createComputed((get => {
    const clients = get(createBinding(hyprland, "clients"))
    const matchingClients = clients.filter(client => client["initial-class"] == initClass)
    return matchingClients
  }))

  const onPinChange = (newPinned: boolean) => {
    setPinned(newPinned)
    app.pinned = newPinned

    if (newPinned) {
      const newList = [...list(), app]
      setList(newList)
      saveList()
    } else {
      const newList = list().filter(a => a.entry !== app.entry)
      setList(newList)
      saveList()
    }
  }
  
  const menu = AppContextMenu(app, clientsBinding, application, pinned, onPinChange);

  return(
    <button
      onclicked={() => {
        const client = clientsBinding()[0]
        if (client)
          client.focus()
        else
          application.launch([], null)
      }}
      $={(self) => {
          const gesture = new Gtk.GestureClick()
          gesture.set_button(3) 
          
          gesture.connect("released", () => {
              menu.popup(app)
          })

          self.add_controller(gesture)
      }}
      class="app-launch-button"
    >
      <box orientation={Gtk.Orientation.VERTICAL}>
        {menu}
        <overlay>
          <Gtk.Image
            iconName={app.icon}
            pixelSize={56}
            class="dock-app-icon"
          />
          <box $type="overlay" class="dots-container" orientation={Gtk.Orientation.VERTICAL}>
            <box vexpand={true}></box>
            <box class="client-dots" halign={Gtk.Align.CENTER} spacing={3}>
              <For each={clientsBinding}>
                  {(client) => <ActiveClientDot />}
              </For>
            </box>
          </box>
        </overlay>
      </box>
    </button>
  )
}

function ActiveClientDot(){
  return (
    <box class="active-client-dot" />
  )
}

function AppContextMenu(app, clientsBinding, application, pinned, onPinChange){
  let popover: Gtk.Popover;

  return (
    <popover autohide={true} class="app-context-menu" $={(self) => { popover = self }}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <button
          onclicked={() => {
            popover.popdown()
            application.launch([], null)
          }}
        >
          <box>
            <DockContextIcon icon={app.icon} />
            <label halign={Gtk.Align.START} label={app.name}/>
          </box>
        </button>

        <button
          visible={pinned.as(p => p === true)}
          onclicked={() => {
            popover.popdown()
            onPinChange(false)
          }}
        >
          <box>
            <DockContextIcon icon="unpin-symbolic"/>
            <label halign={Gtk.Align.START} label="Unpin from Dock"/>
          </box>
        </button>

        <button
          visible={pinned.as(p => p === false)}
          onclicked={() => {
            popover.popdown()
            onPinChange(true)
          }}
        >
          <box>
            <DockContextIcon icon="pin-symbolic"/>
            <label halign={Gtk.Align.START} label="Pin to Dock"/>
          </box>
        </button>
        
        <button
          onclicked={() => {
            popover.popdown()
            for (const client of clientsBinding()){
              client.kill()          
            }
          }}
          visible={clientsBinding.as(clients => clients.length > 0)}
        >
          <box>
            <DockContextIcon icon="window-close-symbolic" />
            <label halign={Gtk.Align.START} label="Close Window"/>
          </box>
        </button>
      </box>
    </popover>
  )
}

function DockContextIcon({ icon }) {
  return (
    <Gtk.Image
      class="dock-context-icon"
      iconName={icon}
      pixelSize={20}
    />
  )
}