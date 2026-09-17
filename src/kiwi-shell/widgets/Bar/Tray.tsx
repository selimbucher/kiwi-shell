import AstalTray from "gi://AstalTray"
import { createBinding, For } from "ags"
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib?version=2.0"
import { exec } from "ags/process"

const tray = AstalTray.get_default()
const trayItems = createBinding(tray, 'items')

// An empty tray must unmap its whole window, not just hide the box: a shown
// layer window with nothing to draw never attaches a buffer, and Hyprland
// answers each of its commits with a new configure. GTK acks and commits
// again, so the compositor redrew the screen every frame while idle.
export const hasTrayItems = trayItems.as(items => items.length !== 0)

export default function Tray() {
    return (
        <box
            class="Tray"
            spacing={0}
            visible={hasTrayItems}
            $={(self) => {
                const unsub = trayItems.subscribe(() => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        const win = self.get_root()
                        if (win instanceof Gtk.Window) {
                            win.set_default_size(-1, -1)
                            win.queue_resize()
                        }
                        return GLib.SOURCE_REMOVE
                    })
                })
                self.connect("destroy", unsub)
            }}
        >
            <For each={trayItems}>
                {item =>
                    <menubutton class="tray-item">
                        <TrayIcon item={item} />
                        <Gtk.PopoverMenu
                            menuModel={item.get_menu_model()}
                            onRealize={(self) => {
                                const actionGroup = item.get_action_group()
                                if (actionGroup) {
                                    self.insert_action_group("dbusmenu", actionGroup)
                                }
                            }}
                            hasArrow={true}
                            class="tray-menu"
                        />
                    </menubutton>
                }
            </For>
        </box>
    )
}

function TrayIcon({item}){
    const iconName = item.get_icon_name()
    const iconThemePath = item.get_icon_theme_path()
    const iconPixbuf = item.get_icon_pixbuf()
    
    // Check if icon name is a file path (contains / or starts with /)
    const isFilePath = iconName && (iconName.includes('/') || iconName.startsWith('/'))
    
    // It's a system icon if:
    // - No custom theme path
    // - No pixbuf
    // - Icon name exists but is NOT a file path
    const isSystemIcon = !iconThemePath && !iconPixbuf && iconName && !isFilePath
    
    const className = isSystemIcon ? "tray-icon system" : "tray-icon"

    return (
        <Gtk.Image
            class={createBinding(item, 'icon-name').as((name) => className+' icon-'+name)}
            gicon={createBinding(item, 'gicon')}
            pixelSize={16}
        />
    )
}

function trayIconName(name: string) {
    switch (name) {
        case 'spotify-linux-32':
            return 'com.spotify.Client-symbolic'
        default:
            return name;
    }
}