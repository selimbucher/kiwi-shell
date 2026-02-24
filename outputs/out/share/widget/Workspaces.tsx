import { Astal, Gtk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import AstalWp from "gi://AstalWp"
import { createBinding } from "gnim"

const wp = AstalWp.get_default()

const recordersBinding = createBinding(wp.audio, "recorders");
const micMutedBinding = createBinding(wp.audio.defaultMicrophone, "mute")

export default function Workspaces() {
  const hypr = Hyprland.get_default()
  
  const updateClasses = (btn: Gtk.Button, id: number) => {
    const workspace = hypr.get_workspace(id)
    const isFocused = hypr.focusedWorkspace.id === id
    const hasClients = workspace && workspace.get_clients().length > 0
    const hasUrgent = workspace && workspace.get_clients().some(c => c.urgent)
    
    if (isFocused) {
      btn.add_css_class("active")
    } else {
      btn.remove_css_class("active")
    }
    
    if (hasClients) {
      btn.add_css_class("filled")
    } else {
      btn.remove_css_class("filled")
    }
    
    if (hasUrgent) {
      btn.add_css_class("urgent")
    } else {
      btn.remove_css_class("urgent")
    }
  }
  
  const buttons = Array.from({ length: 5 }, (_, i) => i + 1).map(id => {
    const btn = <button
      vexpand={false}
      class="workspace"
      onClicked={() => {
        if (hypr.focusedWorkspace.id === id) {
          // Do something else when clicking active workspace
          hypr.dispatch("exec", "hyprctl dispatch hyprexpo:expo toggle")
        } else {
          hypr.dispatch("workspace", `${id}`)
        }
      }}
    > 
      <box class="tile" vexpand={false}/>
    </button> as Gtk.Button
    
    updateClasses(btn, id)
    
    hypr.connect("notify::focused-workspace", () => updateClasses(btn, id))
    hypr.connect("notify::workspaces", () => updateClasses(btn, id))
    hypr.connect("notify::clients", () => updateClasses(btn, id))
    
    return btn
  })
  
  return (
    <box class="workspaces">
      {buttons}
      <revealer
      transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
        revealChild={recordersBinding.as(
            a => !(a.length === 0)
          )}
      >
        <Gtk.Image
          class="mic-access"
          iconName={micMutedBinding.as(b =>
            b ? "audio-input-microphone-muted-symbolic" : "audio-input-microphone-symbolic"
          )}
          pixelSize={13}
        />
      </revealer>
      
    </box>
  )
}