import { Gtk } from "ags/gtk4"
import { shutDown, restart, sleep, lock, logOut } from "../power"

// Named under each, as macOS and Windows name them: five round symbols for
// shut down, restart and log out are too alike to tell apart. The ones that
// ask first say so with an ellipsis.
const buttons = [
  { name: "Shut Down…", icon: "system-shutdown-symbolic", exec: shutDown },
  { name: "Restart…", icon: "system-reboot-symbolic", exec: restart },
  { name: "Sleep", icon: "bed-symbolic", exec: sleep },
  { name: "Lock", icon: "object-locked-symbolic", exec: lock },
  { name: "Log Out…", icon: "exit-symbolic", exec: logOut },
]

function PowerButton({ name, icon, exec }: (typeof buttons)[number]) {
  return (
    <button onClicked={() => exec()}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <Gtk.Image iconName={icon} pixelSize={32} />
        <label class="power-label" label={name} />
      </box>
    </button>
  )
}

export default function PowerMenu() {
  return (
    <box class="PowerMenu" spacing={12} homogeneous>
      {buttons.map(PowerButton)}
    </box>
  )
}
