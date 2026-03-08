import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf, primaryColor } from "./config"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GObject from "gi://GObject"

import filterApp from "./filterAppIcons"

import Hyprland from "gi://AstalHyprland"

const DOCK_HIDE_TIMEOUT = 600
const DOCK_HIDE_TIMEOUT_EDGE = 1200

const hyprland = Hyprland.get_default()

const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/desktop/dock-apps.json`

let initialAppList

try {
    initialAppList = JSON.parse(readFile(APPLIST_FILE))
} catch (error) {
    initialAppList = []
}

const [list, setList] = createState(initialAppList)

async function saveList() {
    const currentList = list()
        .map(({ pinned, ...rest }) => rest)
    const jsonString = JSON.stringify(currentList, null, 2)
    try {
        await writeFileAsync(APPLIST_FILE, jsonString)
    } catch (error) {
        console.error("Failed to save config:", error)
    }
}

const unpinnedList = createComputed(get => {
    const clients = get(createBinding(hyprland, "clients"))
    const pinnedEntries = new Set(get(list).map(app => app.entry))

    const unpinnedClients = clients.filter(client => {
        return !pinnedEntries.has(client["initial-class"] + ".desktop")
    })

    const seen = new Set()
    return unpinnedClients.reduce((acc, client) => {
        const icon = filterApp(client["initial-class"])
        if (seen.has(icon)) return acc
        seen.add(icon)
        acc.push({
            "entry": (client["initial-class"] + ".desktop"),
            "icon": icon,
            "name": client.title.split("- ").at(-1),
            "pinned": false
        })
        return acc
    }, [])
})

function openUri(uri: string) {
    GLib.spawn_command_line_async(`nautilus --new-window ${uri}`)
}

function openPath(path: string) {
    GLib.spawn_command_line_async(`nautilus --new-window ${path}`)
}

function emptyTrash() {
    try {
        const filesDir = Gio.File.new_for_path(`${GLib.get_user_data_dir()}/Trash/files`)
        const infoDir = Gio.File.new_for_path(`${GLib.get_user_data_dir()}/Trash/info`)

        for (const dir of [filesDir, infoDir]) {
            try {
                const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
                let info
                while ((info = enumerator.next_file(null)) !== null) {
                    const child = dir.get_child(info.get_name())
                    child.delete(null)
                }
            } catch {
                // directory may not exist
            }
        }
    } catch (error) {
        console.error("Failed to empty trash:", error)
    }
}

const [dockTrigger, setDockTrigger] = createState(false)
const [dockHovered, setDockHovered] = createState(false)
const [menuOpen, setMenuOpen] = createState(false)
let hideTimeout: number | null = null
let leaveTimeout: number | null = null

const clients = createBinding(hyprland, "clients")
const activeWorkspace = createBinding(hyprland, "focusedWorkspace")

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

    
    
    const activeId = get(activeWorkspace)?.id

    const hastiledWindow = get(clients).some(client => {
        const floating = get(createBinding(client, "floating"))
        return client.workspace.id === activeId && !floating
    })

    return !hastiledWindow
})

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
            anchor={Astal.WindowAnchor.BOTTOM}
            visible={showDock}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
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
            <DockBar />
        </window>
    )
}

export function EdgeSensor(gdkmonitor: Gdk.Monitor) {
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
            <box css="min-height: 1px;"></box>
        </window>
    )
}

function DockBar() {
    const pinnedBinding = createComputed(get => get(list))

    return (
        <box class="dock-bar">
            <box $type="center" class="dock-box" orientation={Gtk.Orientation.HORIZONTAL}>
                <box>
                    <For each={pinnedBinding}>
                        {(app) => <AppIcon app={app} />}
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
                        {(app) => <AppIcon app={app} />}
                    </For>
                </box>
                <box
                    vexpand={true}
                    class="dock-spacer"
                    visible={createComputed(get =>
                        (get(list).length > 0 || get(unpinnedList).length > 0) && (get(conf).dock_home == true || get(conf).dock_trash == true)
                    )}
                />
                <HomeFolderButton />
                <TrashButton />
            </box>
        </box>
    )
}

function HomeFolderButton() {
    const commonDirs = [
        { name: "Home", path: HOME, icon: "user-home" },
        { name: "Desktop", path: `${HOME}/Desktop`, icon: "user-desktop" },
        { name: "Documents", path: `${HOME}/Documents`, icon: "folder-documents" },
        { name: "Downloads", path: `${HOME}/Downloads`, icon: "folder-download" },
        { name: "Music", path: `${HOME}/Music`, icon: "folder-music" },
        { name: "Pictures", path: `${HOME}/Pictures`, icon: "folder-pictures" },
        { name: "Videos", path: `${HOME}/Videos`, icon: "folder-videos" },
        { name: "Public", path: `${HOME}/Public`, icon: "folder-publicshare" },
    ].filter(d => GLib.file_test(d.path, GLib.FileTest.IS_DIR))

    let popover: Gtk.Popover

    const menu = (
        <popover
            autohide={true}
            class="app-context-menu"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setMenuOpen(self.visible)
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                {commonDirs.map(dir => (
                    <button onclicked={() => {
                        popover.popdown()
                        openPath(dir.path)
                    }}>
                        <box>
                            <DockContextIcon icon={dir.icon} />
                            <label halign={Gtk.Align.START} label={dir.name} />
                        </box>
                    </button>
                ))}
            </box>
        </popover>
    )

    return (
        <button
            visible={conf.as(conf => conf.dock_home == true)}
            class="app-launch-button"
            onclicked={() => openPath(HOME)}
            $={(self) => {
                const gesture = new Gtk.GestureClick()
                gesture.set_button(3)
                gesture.connect("released", () => {
                    popover.popup()
                })
                self.add_controller(gesture)
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL}>
                {menu}
                <Gtk.Image
                    iconName="user-home"
                    pixelSize={56}
                    class="dock-app-icon"
                />
            </box>
        </button>
    )
}

function TrashButton() {
    const TRASH_FILES = `${GLib.get_user_data_dir()}/Trash/files`

    const isTrashEmpty = () => {
        try {
            const dir = GLib.Dir.open(TRASH_FILES, 0)
            const first = dir.read_name()
            return first === null
        } catch {
            return true
        }
    }

    const [trashEmpty, setTrashEmpty] = createState(isTrashEmpty())

    const trashDir = Gio.File.new_for_path(TRASH_FILES)
    const monitor = trashDir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", () => {
        setTrashEmpty(isTrashEmpty())
    })

    let popover: Gtk.Popover

    const menu = (
        <popover
            autohide={true}
            class="app-context-menu"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setMenuOpen(self.visible)
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                <button
                    onclicked={() => {
                        popover.popdown()
                        openUri("trash:///")
                    }}
                >
                    <box>
                        <DockContextIcon icon="user-trash" />
                        <label halign={Gtk.Align.START} label="Open Trash" />
                    </box>
                </button>
                <button
                    onclicked={() => {
                        popover.popdown()
                        emptyTrash()
                        setTrashEmpty(true)
                    }}
                >
                    <box>
                        <DockContextIcon icon="edit-clear-symbolic" />
                        <label halign={Gtk.Align.START} label="Empty Trash" />
                    </box>
                </button>
            </box>
        </popover>
    )

    return (
        <button
            visible={conf.as(conf => conf.dock_trash == true)}
            class="app-launch-button"
            onclicked={() => openUri("trash:///")}
            $={(self) => {
                const gesture = new Gtk.GestureClick()
                gesture.set_button(3)
                gesture.connect("released", () => {
                    popover.popup()
                })
                self.add_controller(gesture)

                const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE | Gdk.DragAction.COPY)
                dropTarget.connect("accept", (_target, drop) => {
                    return drop.get_formats().contain_mime_type("text/uri-list")
                })
                dropTarget.connect("drop", (_target, value, _x, _y) => {
                    if (typeof value === "string") {
                        const uris = value.trim().split("\n").filter(Boolean)
                        for (const uri of uris) {
                            const path = decodeURIComponent(uri.replace(/^file:\/\//, "").trim())
                            const file = Gio.File.new_for_path(path)
                            file.trash(null)
                        }
                        setTrashEmpty(false)
                        return true
                    }
                    return false
                })
                dropTarget.connect("enter", () => {
                    self.add_css_class("drag-hover")
                    return Gdk.DragAction.MOVE
                })
                dropTarget.connect("leave", () => {
                    self.remove_css_class("drag-hover")
                })
                self.add_controller(dropTarget)
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL}>
                {menu}
                <Gtk.Image
                    iconName={trashEmpty.as(empty => empty ? "user-trash" : "user-trash-full")}
                    pixelSize={56}
                    class="dock-app-icon"
                />
            </box>
        </button>
    )
}

function AppIcon({ app }) {
    const initClass = app.entry.split(".").slice(0, -1).join(".")
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

    const menu = AppContextMenu(app, clientsBinding, application, pinned, onPinChange)

    return (
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

function ActiveClientDot() {
    return (
        <box class="active-client-dot" />
    )
}

function AppContextMenu(app, clientsBinding, application, pinned, onPinChange) {
    let popover: Gtk.Popover

    return (
        <popover
            autohide={true}
            class="app-context-menu"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setMenuOpen(self.visible)
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                <button
                    onclicked={() => {
                        popover.popdown()
                        application.launch([], null)
                    }}
                >
                    <box>
                        <DockContextIcon icon={app.icon} />
                        <label halign={Gtk.Align.START} label={app.name} />
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
                        <DockContextIcon icon="unpin-symbolic" />
                        <label halign={Gtk.Align.START} label="Unpin from Dock" />
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
                        <DockContextIcon icon="pin-symbolic" />
                        <label halign={Gtk.Align.START} label="Pin to Dock" />
                    </box>
                </button>

                <button
                    onclicked={() => {
                        popover.popdown()
                        for (const client of clientsBinding()) {
                            client.kill()
                        }
                    }}
                    visible={clientsBinding.as(clients => clients.length > 0)}
                >
                    <box>
                        <DockContextIcon icon="window-close-symbolic" />
                        <label halign={Gtk.Align.START} label="Close Window" />
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