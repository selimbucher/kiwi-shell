import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For, onCleanup } from "ags"
import { conf } from "../config"
import { hyprland, list, unpinnedList, DOCK_HIDE_TIMEOUT, DOCK_HIDE_TIMEOUT_EDGE, JUMP_ANIMATION_CLASS_TIMEOUT } from "./dock-state"
import { AppIcon } from "./AppIcon"
import { HomeFolderButton, TrashButton } from "./DockButtons"

const clients = createBinding(hyprland, "clients")
const activeWorkspace = createBinding(hyprland, "focusedWorkspace")

export default function Dock({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const [dockTrigger, setDockTrigger] = createState(false)
    const [dockHovered, setDockHovered] = createState(false)
    const [menuOpen, setMenuOpen] = createState(false)
    let hideTimeout: number | null = null
    let leaveTimeout: number | null = null

    const showDock = createComputed(get => {
        const config = get(conf)
        if (get(list).length + get(unpinnedList).length == 0)
            return false

        const mode = config.dock
        const trigger = get(dockTrigger)
        const hovered = get(dockHovered)
        const hasMenu = get(menuOpen)

        if (mode == "disabled") return false
        if (mode != "auto-hide") return true
        if (trigger || hovered || hasMenu) return true

        // Subscribe so this recomputes on every workspace switch
        get(activeWorkspace)

        const activeId = hyprland.get_monitors()
            .find(m => m.name === gdkmonitor.get_connector())
            ?.activeWorkspace?.id

        const hastiledWindow = get(clients).some(client =>
            client.workspace.id === activeId
        )

        return !hastiledWindow
    })

    return [(
        <window
            css={conf.as(conf =>
                `
                --primary: ${conf.primary_color};
                --dock-margin: ${conf.dock_margin}px;
                --jumptime: ${JUMP_ANIMATION_CLASS_TIMEOUT}ms;
                `
            )}
            name="ags-dock"
            class={conf.as(conf =>
                `Dock theme-${conf.theme}`
            )}
            gdkmonitor={gdkmonitor}
            exclusivity={conf.as(conf =>
                conf.dock == "auto-hide" ? Astal.Exclusivity.NORMAL : Astal.Exclusivity.EXCLUSIVE
            )}
            anchor={Astal.WindowAnchor.BOTTOM}
            visible={showDock}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                onCleanup(() => self.destroy())
                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", () => {
                    if (leaveTimeout) {
                        clearTimeout(leaveTimeout)
                        leaveTimeout = null
                    }
                    setDockHovered(true)
                })
                motionController.connect("leave", () => {
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", () => {
                    if (leaveTimeout) {
                        clearTimeout(leaveTimeout)
                        leaveTimeout = null
                    }
                    setDockHovered(true)
                })
                dragMotion.connect("leave", () => {
                    leaveTimeout = setTimeout(() => {
                        setDockHovered(false)
                        leaveTimeout = null
                    }, DOCK_HIDE_TIMEOUT)
                })
                self.add_controller(dragMotion)
            }}
        >
            <DockBar setMenuOpen={setMenuOpen} />
        </window>
    ), <EdgeSensor gdkmonitor={gdkmonitor} hideTimeout={hideTimeout} setDockTrigger={setDockTrigger} />]
}

function EdgeSensor({ gdkmonitor, hideTimeout, setDockTrigger }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            name="ags-dock-sensor"
            class="edge-sensor-bottom"
            gdkmonitor={gdkmonitor}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT}
            exclusivity={Astal.Exclusivity.NORMAL}
            layer={Astal.Layer.TOP}
            application={app}
            visible={conf.as(conf => conf.dock == "auto-hide")}
            $={(self) => {
                onCleanup(() => self.destroy())
                const motionController = new Gtk.EventControllerMotion()
                motionController.connect("enter", () => {
                    if (hideTimeout) {
                        clearTimeout(hideTimeout)
                        hideTimeout = null
                    }
                    setDockTrigger(true)
                    hideTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        hideTimeout = null
                    }, DOCK_HIDE_TIMEOUT_EDGE)
                })
                self.add_controller(motionController)

                const dragMotion = new Gtk.DropControllerMotion()
                dragMotion.connect("enter", () => {
                    if (hideTimeout) {
                        clearTimeout(hideTimeout)
                        hideTimeout = null
                    }
                    setDockTrigger(true)
                    hideTimeout = setTimeout(() => {
                        setDockTrigger(false)
                        hideTimeout = null
                    }, DOCK_HIDE_TIMEOUT_EDGE)
                })
                self.add_controller(dragMotion)
            }}
        >
            <box css="min-height: 1px;" />
        </window>
    )
}

function DockBar({ setMenuOpen }: { setMenuOpen: (v: boolean) => void }) {
    const pinnedBinding = createComputed(get => get(list))

    return (
        <box class="dock-bar" halign={Gtk.Align.CENTER}>
            <box $type="center" class="dock-box" orientation={Gtk.Orientation.HORIZONTAL}>
                <box>
                    <For each={pinnedBinding}>
                        {(entry) => <AppIcon entry={entry} setMenuOpen={setMenuOpen} />}
                    </For>
                </box>
                <box
                    vexpand={true}
                    class="dock-spacer"
                    visible={createComputed(get =>
                        get(list).length > 0 && get(unpinnedList).length > 0
                    )}
                />
                <box>
                    <For each={unpinnedList}>
                        {(entry) => <AppIcon entry={entry} setMenuOpen={setMenuOpen} />}
                    </For>
                </box>
                <box
                    vexpand={true}
                    class="dock-spacer"
                    visible={createComputed(get =>
                        (get(list).length > 0 || get(unpinnedList).length > 0) &&
                        (get(conf).dock_home == true || get(conf).dock_trash == true)
                    )}
                />
                <HomeFolderButton setMenuOpen={setMenuOpen} />
                <TrashButton setMenuOpen={setMenuOpen} />
            </box>
        </box>
    )
}