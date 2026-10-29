import { Gtk, Gdk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { conf } from "../config"
import { playSound } from "../sound"
import { HOME, launchBounce, type Hop, type MenuSlot } from "./dock-state"
import { openUri, openPath, emptyTrash, letGoOnClose } from "./dock-utils"
import { ContextMenu } from "../ContextMenu"
import { openChoicePrompt } from "../prompts"

export function HomeFolderButton({ menuSlot }: { menuSlot: MenuSlot }) {
    const setMenuOpen = menuSlot()
    // the user's folders where they are (~/Schreibtisch, ~/Bilder), by the
    // names the file manager shows them under
    const commonDirs = ([
        [GLib.UserDirectory.DIRECTORY_DESKTOP, "user-desktop"],
        [GLib.UserDirectory.DIRECTORY_DOCUMENTS, "folder-documents"],
        [GLib.UserDirectory.DIRECTORY_DOWNLOAD, "folder-download"],
        [GLib.UserDirectory.DIRECTORY_MUSIC, "folder-music"],
        [GLib.UserDirectory.DIRECTORY_PICTURES, "folder-pictures"],
        [GLib.UserDirectory.DIRECTORY_VIDEOS, "folder-videos"],
        [GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, "folder-publicshare"],
    ] as const)
        .map(([dir, icon]) => ({ path: GLib.get_user_special_dir(dir), icon }))
        .filter((d): d is { path: string, icon: typeof d.icon } =>
            !!d.path && d.path !== HOME && GLib.file_test(d.path, GLib.FileTest.IS_DIR))
        .map(d => ({ ...d, name: GLib.path_get_basename(d.path) }))

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
                    letGoOnClose(menu, self)
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

// every dock's trash watch, held so none is collected (one per display)
const trashMonitors = new Set<Gio.FileMonitor>()

export function TrashButton({ menuSlot }: { menuSlot: MenuSlot }) {
    const setMenuOpen = menuSlot()
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

    const trashMonitor = Gio.File.new_for_path(TRASH_FILES).monitor_directory(Gio.FileMonitorFlags.NONE, null)
    trashMonitor.connect("changed", () => setTrashEmpty(isTrashEmpty()))
    trashMonitors.add(trashMonitor)
    onCleanup(() => {
        trashMonitor.cancel()
        trashMonitors.delete(trashMonitor)
    })

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
                // gone for good, so asked first, as a Mac asks
                onClick: () => openChoicePrompt("Empty Trash",
                    "Are you sure you want to permanently erase the items in the Trash? You can't undo this action.",
                    [{ label: "Empty Trash", primary: true, run: () => {
                        playSound("trash.wav")
                        emptyTrash()
                        setTrashEmpty(true)
                    } }]),
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
                    letGoOnClose(menu, self)

                    // files as files: GTK's plain-text form of a drag is paths,
                    // not URIs, and a name with a % in it didn't survive
                    // being decoded as one
                    const dropTarget = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.MOVE | Gdk.DragAction.COPY)
                    dropTarget.connect("drop", (_target, value) => {
                        if (!(value instanceof Gdk.FileList)) return false
                        let trashed = false
                        for (const file of value.get_files()) {
                            try {
                                file.trash(null)
                                trashed = true
                            } catch (e) {
                                console.error(`could not move ${file.get_path()} to the trash:`, e)
                            }
                        }
                        if (trashed) setTrashEmpty(false)
                        return trashed
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