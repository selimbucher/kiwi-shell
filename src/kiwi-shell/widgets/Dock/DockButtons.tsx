import { Gtk, Gdk } from "ags/gtk4"
import { createState } from "ags"
import Gio from "gi://Gio"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { conf } from "../config"
import { playSound } from "../sound"
import { HOME, JUMP_ANIMATION_CLASS_TIMEOUT } from "./dock-state"
import { openUri, openPath, emptyTrash, DockContextIcon } from "./dock-utils"

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

export function TrashButton({ setMenuOpen }: { setMenuOpen: (v: boolean) => void }) {
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
                        popover.popdown()
                        if (!trashEmpty()) {
                            playSound("trash.wav")
                        }
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