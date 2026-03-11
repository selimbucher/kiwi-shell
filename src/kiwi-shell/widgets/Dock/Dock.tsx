import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { conf, primaryColor } from "../config"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GObject from "gi://GObject"

import Hyprland from "gi://AstalHyprland"
import { Icon } from "../iconNames"
import { playSound } from "../sound";

const DOCK_HIDE_TIMEOUT = 600
const DOCK_HIDE_TIMEOUT_EDGE = 1200
const JUMP_ANIMATION_CLASS_TIMEOUT = 400

const hyprland = Hyprland.get_default()

const HOME = GLib.getenv("HOME")
const APPLIST_FILE = `${HOME}/.config/kiwi-shell/dock-apps.json`

let initialAppList: string[]

try {
    initialAppList = JSON.parse(readFile(APPLIST_FILE))
} catch {
    initialAppList = []
}

const [list, setList] = createState<string[]>(initialAppList)

async function saveList() {
    try {
        await writeFileAsync(APPLIST_FILE, JSON.stringify(list(), null, 2))
    } catch (error) {
        console.error("Failed to save dock apps:", error)
    }
}

const unpinnedList = createComputed(get => {
    const clients = get(createBinding(hyprland, "clients"))
    const pinned = new Set(get(list))

    const seen = new Set<string>()
    return clients.reduce((acc, client) => {
        const entry = client["initial-class"] + ".desktop"
        if (pinned.has(entry) || seen.has(entry)) return acc
        seen.add(entry)
        acc.push(entry)
        return acc
    }, [] as string[])
})

const FILE_MANAGERS = [
    { bin: "nautilus", flag: "" },
    { bin: "dolphin",  flag: "" },
    { bin: "nemo",     flag: "" },
    { bin: "thunar",   flag: "" },
    { bin: "pcmanfm",  flag: "" },
]

function resolveFileManager(): { bin: string; flag: string } {
    const configured = conf().file_manager
    if (configured && configured !== "auto") {
        const flag = FILE_MANAGERS.find(f => f.bin === configured)?.flag ?? ""
        return { bin: configured, flag }
    }
    return FILE_MANAGERS.find(fm => !!GLib.find_program_in_path(fm.bin))
        ?? { bin: "xdg-open", flag: "" }
}

function openUri(uri: string) {
    const { bin, flag } = resolveFileManager()
    GLib.spawn_command_line_async([bin, flag, uri].filter(Boolean).join(" "))
}

function openPath(path: string) {
    const { bin, flag } = resolveFileManager()
    GLib.spawn_command_line_async([bin, flag, path].filter(Boolean).join(" "))
}

function emptyTrash() {
    try {
        GLib.spawn_command_line_async("gio trash --empty")
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
        return client.workspace.id === activeId /* && !floating */
    })

    return !hastiledWindow
})

export default function Dock(gdkmonitor: Gdk.Monitor) {
    return (
        <window
            css={primaryColor(hex =>
                `
                --primary: ${hex};
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
        <box class="dock-bar" halign={Gtk.Align.CENTER}>
            <box $type="center" class="dock-box" orientation={Gtk.Orientation.HORIZONTAL}>
                <box>
                    <For each={pinnedBinding}>
                        {(entry) => <AppIcon entry={entry} />}
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
                        {(entry) => <AppIcon entry={entry} />}
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
                <HomeFolderButton />
                <TrashButton />
            </box>
        </box>
    )
}

function HomeFolderButton() {
    const commonDirs = [
        // { name: "Home",      path: `${HOME}`,           icon: "user-home" },
        { name: "Desktop",   path: `${HOME}/Desktop`,   icon: "user-desktop" },
        { name: "Documents", path: `${HOME}/Documents`, icon: "folder-documents" },
        { name: "Downloads", path: `${HOME}/Downloads`, icon: "folder-download" },
        { name: "Music",     path: `${HOME}/Music`,     icon: "folder-music" },
        { name: "Pictures",  path: `${HOME}/Pictures`,  icon: "folder-pictures" },
        { name: "Videos",    path: `${HOME}/Videos`,    icon: "folder-videos" },
        { name: "Public",    path: `${HOME}/Public`,    icon: "folder-publicshare" },
    ].filter(d => GLib.file_test(d.path, GLib.FileTest.IS_DIR))

    let popover: Gtk.Popover
    const [jumping, setJumping] = createState(false)

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
            class={jumping.as(isJumping => isJumping ? "app-launch-button jumping" : "app-launch-button")}
            onclicked={() => {
                setJumping(true)
                setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                openPath(HOME)
            }}
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

let _trashMonitor: Gio.FileMonitor | null = null

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
    const [jumping, setJumping] = createState(false)

    const trashDir = Gio.File.new_for_path(TRASH_FILES)
    _trashMonitor = trashDir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    _trashMonitor.connect("changed", () => {
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
                        if (!trashEmpty()) {
                            playSound("trash.wav")
                        }
                        emptyTrash()
                        popover.popdown()
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
            class={jumping.as(isJumping => isJumping ? "app-launch-button jumping" : "app-launch-button")}
            onclicked={() => {
                setJumping(true)
                setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                openUri("trash:///")
            }}
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

function AppIcon({ entry }: { entry: string }) {
    const initClass = entry.replace(/\.desktop$/, "")
    const application = GioUnix.DesktopAppInfo.new(entry)
    const icon = application?.get_icon()?.to_string() ?? initClass
    const name = application?.get_name() ?? initClass

    const [pinned, setPinned] = createState(list().includes(entry))
    const [jumping, setJumping] = createState(false)

    const clientsBinding = createComputed(get => {
        const allClients = get(createBinding(hyprland, "clients"))
        return allClients.filter(client => client["initial-class"] === initClass)
    })

    const onPinChange = (newPinned: boolean) => {
        setPinned(newPinned)
        if (newPinned) {
            setList([...list(), entry])
        } else {
            setList(list().filter(e => e !== entry))
        }
        saveList()
    }

    const menu = AppContextMenu(entry, clientsBinding, application, icon, name, pinned, onPinChange)

    return (
        <button
            onclicked={() => {
                const client = clientsBinding()[0]
                if (client) {
                    client.focus()
                } else {
                    setJumping(true)
                    setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                    application.launch([], null)
                }
            }}
            $={(self) => {
                const gesture = new Gtk.GestureClick()
                gesture.set_button(3)
                gesture.connect("released", () => {
                    menu.popup()
                })
                self.add_controller(gesture)
            }}
            class={jumping.as(isJumping => isJumping ? "app-launch-button jumping" : "app-launch-button")}
        >
            <box orientation={Gtk.Orientation.VERTICAL}>
                {menu}
                <overlay>
                    <Gtk.Image
                        iconName={icon}
                        pixelSize={56}
                        class="dock-app-icon"
                    />
                    <box $type="overlay" class="dots-container" orientation={Gtk.Orientation.VERTICAL}>
                        <box vexpand={true}></box>
                        <box class="client-dots" halign={Gtk.Align.CENTER} spacing={3}>
                            <For each={clientsBinding}>
                                {(_client) => <ActiveClientDot />}
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

function AppContextMenu(entry, clientsBinding, application, icon, name, pinned, onPinChange) {
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
                        <DockContextIcon icon={icon} />
                        <label halign={Gtk.Align.START} label={name} />
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
        <Icon
            class="dock-context-icon"
            iconName={icon}
            pixelSize={20}
        />
    )
}