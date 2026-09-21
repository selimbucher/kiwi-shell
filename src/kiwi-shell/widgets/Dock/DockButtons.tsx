import { Gtk, Gdk } from "ags/gtk4"
import { createState } from "ags"
import Gio from "gi://Gio"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { conf } from "../config"
import { playSound } from "../sound"
import { HOME, launchBounce, type Hop } from "./dock-state"
import { openUri, openPath, emptyTrash } from "./dock-utils"
import { ContextMenu } from "../ContextMenu"

export function HomeFolderButton({ setMenuOpen }: { setMenuOpen: (v: boolean) => void }) {
    const commonDirs = [
        { name: "Desktop",   path: `${HOME}/Desktop`,   icon: "user-desktop" },
        { name: "Documents", path: `${HOME}/Documents`, icon: "folder-documents" },
        { name: "Downloads", path: `${HOME}/Downloads`, icon: "folder-download" },
        { name: "Music",     path: `${HOME}/Music`,     icon: "folder-music" },
        { name: "Pictures",  path: `${HOME}/Pictures`,  icon: "folder-pictures" },
        { name: "Videos",    path: `${HOME}/Videos`,    icon: "folder-videos" },
        { name: "Public",    path: `${HOME}/Public`,    icon: "folder-publicshare" },
    ].filter(d => GLib.file_test(d.path, GLib.FileTest.IS_DIR))

    const [hop, setHop] = createState<Hop>("")

    const menu = ContextMenu({
        class: "app-context-menu",
        iconSize: 20,
        onVisible: setMenuOpen,
        items: [
            // what the left click does, spelled out — the rest of the menu is
            // shortcuts past home, so home itself has to be one of them
            { label: "Home", icon: "user-home", onClick: () => openPath(HOME) },
            { separator: true },
            ...commonDirs.map(dir => ({
                label: dir.name,
                icon: dir.icon,
                onClick: () => openPath(dir.path),
            })),
        ],
    })

    return (
        <box
            class="app-icon-container"
            visible={conf.as(conf => conf.dock_home == true)}
        >
            <button
                class={hop.as(h => h ? `app-launch-button ${h}` : "app-launch-button")}
                onclicked={() => {
                    launchBounce(setHop)
                    openPath(HOME)
                }}
                $={(self) => {
                    const gesture = new Gtk.GestureClick()
                    gesture.set_button(3)
                    gesture.connect("released", () => menu.popup())
                    self.add_controller(gesture)
                }}
            >
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {menu}
                    <Gtk.Image
                        iconName="user-home"
                        pixelSize={conf.as(conf => conf.dock_icon_size)}
                        class="dock-app-icon"
                    />
                </box>
            </button>
        </box>
    )
}

let _trashMonitor: Gio.FileMonitor | null = null

export function TrashButton({ setMenuOpen }: { setMenuOpen: (v: boolean) => void }) {
    const TRASH_FILES = `${GLib.get_user_data_dir()}/Trash/files`

    const isTrashEmpty = () => {
        try {
            const dir = GLib.Dir.open(TRASH_FILES, 0)
            return dir.read_name() === null
        } catch {
            return true
        }
    }

    const [trashEmpty, setTrashEmpty] = createState(isTrashEmpty())
    const [hop, setHop] = createState<Hop>("")

    const trashDir = Gio.File.new_for_path(TRASH_FILES)
    _trashMonitor = trashDir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
    _trashMonitor.connect("changed", () => setTrashEmpty(isTrashEmpty()))

    const menu = ContextMenu({
        class: "app-context-menu",
        iconSize: 20,
        onVisible: setMenuOpen,
        items: [
            {
                label: "Open Trash",
                icon: "user-trash",
                onClick: () => openUri("trash:///"),
            },
            {
                label: "Empty Trash",
                icon: "edit-clear-symbolic",
                // the monitor already tracks this; an always-live item on an
                // empty trash is the only one here that can do nothing
                sensitive: trashEmpty.as(e => !e),
                onClick: () => {
                    playSound("trash.wav")
                    emptyTrash()
                    setTrashEmpty(true)
                },
            },
        ],
    })

    return (
        <box
            class="app-icon-container"
            visible={conf.as(conf => conf.dock_trash == true)}
        >
            <button
                class={hop.as(h => h ? `app-launch-button ${h}` : "app-launch-button")}
                onclicked={() => {
                    launchBounce(setHop)
                    openUri("trash:///")
                }}
                $={(self) => {
                    const gesture = new Gtk.GestureClick()
                    gesture.set_button(3)
                    gesture.connect("released", () => menu.popup())
                    self.add_controller(gesture)

                    const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE | Gdk.DragAction.COPY)
                    dropTarget.connect("accept", (_target, drop) =>
                        drop.get_formats().contain_mime_type("text/uri-list")
                    )
                    dropTarget.connect("drop", (_target, value) => {
                        if (typeof value === "string") {
                            value.trim().split("\n").filter(Boolean).forEach(uri => {
                                const path = decodeURIComponent(uri.replace(/^file:\/\//, "").trim())
                                Gio.File.new_for_path(path).trash(null)
                            })
                            setTrashEmpty(false)
                            return true
                        }
                        return false
                    })
                    dropTarget.connect("enter", () => {
                        self.add_css_class("drag-hover")
                        return Gdk.DragAction.MOVE
                    })
                    dropTarget.connect("leave", () => self.remove_css_class("drag-hover"))
                    self.add_controller(dropTarget)
                }}
            >
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {menu}
                    <Gtk.Image
                        iconName={trashEmpty.as(e => e ? "user-trash" : "user-trash-full")}
                        pixelSize={conf.as(conf => conf.dock_icon_size)}
                        class="dock-app-icon"
                    />
                </box>
            </button>
        </box>
    )
}