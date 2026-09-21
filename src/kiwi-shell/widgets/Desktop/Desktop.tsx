import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, onCleanup } from "ags"
import { destroyWindow } from "../monitors"
import { readFile, writeFileAsync } from "ags/file"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { subprocess } from "ags/process"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { openPath, openTerminal } from "../Dock/dock-utils"
import { setWallpaper, promptWallpaper } from "../services/wallpaper"
import { ContextMenu, type ContextMenuItem } from "../ContextMenu"
import { logger } from "../../log"
const log = logger("desktop")

// Desktop icons: the contents of the XDG desktop folder rendered on a
// BOTTOM-layer surface — above the wallpaper, below every window. Icons
// sit on a grid managed by hand on a Gtk.Fixed (a FlowBox's internal
// gestures fight icon drags): auto-arrange fills rows left-to-right;
// with desktop_free_placement icons keep whatever grid slot they are
// dragged to (persisted). Double-click (or Enter) opens, Delete trashes,
// right-click offers a context menu, drag on empty space rubber-bands.

type DesktopItem = {
    path: string
    name: string
    gicon: Gio.Icon | null
    isDir: boolean
    contentType: string | null
    appInfo: GioUnix.DesktopAppInfo | null
}

const DESKTOP_DIR =
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
    ?? `${GLib.get_home_dir()}/Desktop`

const CELL_W = 102
const CELL_H = 102
const GRID_MARGIN = 10

const [items, setItems] = createState<DesktopItem[]>([])

function readItems(): DesktopItem[] {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    if (!dir.query_exists(null)) return []

    const out: DesktopItem[] = []
    const children = dir.enumerate_children(
        "standard::name,standard::display-name,standard::icon,standard::type,standard::is-hidden,standard::content-type",
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    let info: Gio.FileInfo | null
    while ((info = children.next_file(null)) !== null) {
        const name = info.get_name()
        if (info.get_is_hidden() || name.startsWith(".")) continue

        const path = `${DESKTOP_DIR}/${name}`

        // .desktop launchers show as their application, not as a text file
        if (name.endsWith(".desktop")) {
            const appInfo = GioUnix.DesktopAppInfo.new_from_filename(path)
            if (appInfo) {
                out.push({
                    path,
                    name: appInfo.get_display_name() ?? name,
                    gicon: appInfo.get_icon(),
                    isDir: false,
                    contentType: "application/x-desktop",
                    appInfo,
                })
                continue
            }
        }

        out.push({
            path,
            name: info.get_display_name() ?? name,
            gicon: info.get_icon(),
            isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
            contentType: info.get_content_type(),
            appInfo: null,
        })
    }
    children.close(null)

    return out.sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
}

function refresh() {
    try {
        const next = readItems()
        log.debug(`[Desktop] refresh → ${next.length} item(s)`)
        setItems(next)
    } catch (e) {
        log.error(`Desktop: failed to list ${DESKTOP_DIR}:`, e)
        setItems([])
    }
}

let refreshTimeout: number | null = null

function watchDesktopDir() {
    const dir = Gio.File.new_for_path(DESKTOP_DIR)
    if (!dir.query_exists(null)) return

    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
    monitor.connect("changed", (_mon, file, _other, eventType) => {
        log.debug(`[Desktop] fs event ${eventType} on ${file?.get_basename() ?? "?"}`)
        if (refreshTimeout !== null) GLib.source_remove(refreshTimeout)
        refreshTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            refreshTimeout = null
            refresh()
            return GLib.SOURCE_REMOVE
        })
    })
    // keep the monitor from being garbage collected
    ;(globalThis as any).__desktopDirMonitor = monitor
}

watchDesktopDir()
refresh()

function openItem(item: DesktopItem) {
    if (item.appInfo) {
        item.appInfo.launch([], null)
        return
    }
    if (item.isDir) {
        openPath(item.path)
        return
    }
    try {
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(item.path, null), null)
    } catch (e) {
        log.error(`Desktop: failed to open ${item.path}:`, e)
    }
}

function trashItem(item: DesktopItem) {
    try {
        Gio.File.new_for_path(item.path).trash(null)
    } catch (e) {
        log.error(`Desktop: failed to trash ${item.path}:`, e)
    }
}

function getClipboard(): Gdk.Clipboard {
    return Gdk.Display.get_default()!.get_clipboard()
}

function fileContentProvider(uris: string[], cut = false): Gdk.ContentProvider {
    const enc = new TextEncoder()
    // x-gnome-copied-files carries the copy/cut verb for file managers,
    // text/uri-list is the fallback everything else understands
    return Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes("application/x-gnome-copied-files",
            GLib.Bytes.new(enc.encode(`${cut ? "cut" : "copy"}\n${uris.join("\n")}`))),
        Gdk.ContentProvider.new_for_bytes("text/uri-list",
            GLib.Bytes.new(enc.encode(uris.map((u) => `${u}\r\n`).join("")))),
    ])
}

function copyItems(list: DesktopItem[], cut = false) {
    if (list.length === 0) return
    const uris = list.map((i) => GLib.filename_to_uri(i.path, null))
    getClipboard().set_content(fileContentProvider(uris, cut))
    log.debug(`[Desktop] ${cut ? "cut" : "copied"} ${list.length} item(s)`)
}

function clipboardHasFiles(): boolean {
    const formats = getClipboard().get_formats()
    return formats.contain_mime_type("application/x-gnome-copied-files")
        || formats.contain_mime_type("text/uri-list")
}

// first free variant of `name` in `dirPath`: name, name (2), name (3)…
function uniqueDest(name: string, dirPath = DESKTOP_DIR): Gio.File {
    const dir = Gio.File.new_for_path(dirPath)
    let dest = dir.get_child(name)
    if (!dest.query_exists(null)) return dest
    const dot = name.startsWith(".") ? -1 : name.lastIndexOf(".")
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ""
    for (let n = 2; ; n++) {
        dest = dir.get_child(`${stem} (${n})${ext}`)
        if (!dest.query_exists(null)) return dest
    }
}

function newFolder() {
    const dest = uniqueDest("New Folder")
    try {
        dest.make_directory(null)
    } catch (e) {
        log.error(`Desktop: failed to create ${dest.get_path()}:`, e)
    }
}

function renameItem(item: DesktopItem, name: string) {
    const clean = name.trim()
    // a slash would move the file somewhere else entirely
    if (!clean || clean === item.name || clean.includes("/")) return
    try {
        const renamed = Gio.File.new_for_path(item.path).set_display_name(clean, null)
        // the free-placement map is keyed by path, so without this the file
        // would come back as a new icon and jump to the first free slot
        const slot = layout.get(item.path)
        const dest = renamed.get_path()
        if (slot && dest) {
            layout.delete(item.path)
            layout.set(dest, slot)
            saveLayout()
        }
    } catch (e) {
        log.error(`Desktop: failed to rename ${item.path}:`, e)
    }
}

// returns the paths the files will land on
function pasteUris(uris: string[], cut: boolean, destDir = DESKTOP_DIR): string[] {
    const created: string[] = []
    for (const uri of uris) {
        const src = Gio.File.new_for_uri(uri)
        const srcPath = src.get_path()
        const name = src.get_basename()
        if (!srcPath || !name) continue
        // a folder can't be transferred into itself
        if (srcPath === destDir) continue
        // cutting a file onto its own directory would just rename it
        if (cut && src.get_parent()?.get_path() === destDir) continue
        const dest = uniqueDest(name, destDir)
        // argv spawn (no shell quoting pitfalls); cp/mv recurse into
        // folders and keep the shell responsive on big files
        const argv = cut
            ? ["mv", "--", srcPath, dest.get_path()!]
            : ["cp", "-r", "--", srcPath, dest.get_path()!]
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
            created.push(dest.get_path()!)
        } catch (e) {
            log.error(`Desktop: failed to paste ${srcPath}:`, e)
        }
    }
    return created
}

function pasteFromClipboard() {
    const cb = getClipboard()
    cb.read_async(
        ["application/x-gnome-copied-files", "text/uri-list"],
        GLib.PRIORITY_DEFAULT, null,
        (_src, res) => {
            let stream: Gio.InputStream
            let mime: string | null
            try {
                ;[stream, mime] = cb.read_finish(res)
            } catch (e) {
                log.debug("[Desktop] paste: clipboard holds no files")
                return
            }
            const out = Gio.MemoryOutputStream.new_resizable()
            out.splice_async(stream,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE
                | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                GLib.PRIORITY_DEFAULT, null,
                (_out, spliceRes) => {
                    try {
                        out.splice_finish(spliceRes)
                    } catch (e) {
                        log.error("paste read failed:", e)
                        return
                    }
                    const text = new TextDecoder()
                        .decode(out.steal_as_bytes().toArray())
                    const lines = text.split(/\r?\n/)
                        .filter(l => l && !l.startsWith("#"))
                    let cut = false
                    if (mime === "application/x-gnome-copied-files")
                        cut = lines.shift() === "cut"
                    log.debug(`[Desktop] paste ${lines.length} uri(s)`
                        + ` (${cut ? "cut" : "copy"})`)
                    pasteUris(lines, cut)
                })
        })
}

// ---------------------------------------------------------------- selection

const [selected, setSelected] = createState<Set<string>>(new Set())

const selectOnly = (paths: string[]) => setSelected(new Set(paths))
const clearSelection = () => setSelected(new Set())
const selectAll = () => selectOnly(items.get().map((i) => i.path))

function toggleSelected(path: string) {
    const next = new Set(selected.get())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
}

function selectedItems(): DesktopItem[] {
    const sel = selected.get()
    return items.get().filter((i) => sel.has(i.path))
}

// --------------------------------------------------------------------- grid

type Slot = { col: number; row: number }

let fixedRef: Gtk.Fixed | null = null
const iconWidgets = new Map<string, Gtk.Widget>()
// what the widget was built from — rebuild when the look changes
const iconVersion = new Map<string, string>()
let monW = 1920
let monH = 1080

const freePlacement = () => !!conf.get().desktop_free_placement

let monitorRef: Gdk.Monitor | null = null

// the desktop surface ignores exclusive zones (so the rubber band reaches
// the screen edges), so the grid itself must dodge the bar and the dock:
// sum the heights of visible EXCLUSIVE top-/bottom-anchored shell windows
function reservedInsets(): { top: number; bottom: number } {
    let top = 0
    let bottom = 0
    for (const win of app.get_windows()) {
        if (!(win instanceof Astal.Window)) continue
        if (!win.visible || win.exclusivity !== Astal.Exclusivity.EXCLUSIVE)
            continue
        if (monitorRef && win.gdkmonitor && win.gdkmonitor !== monitorRef)
            continue
        const h = win.get_height()
        if (h <= 1) continue
        const atTop = !!(win.anchor & Astal.WindowAnchor.TOP)
        const atBottom = !!(win.anchor & Astal.WindowAnchor.BOTTOM)
        if (atTop && !atBottom) top = Math.max(top, h)
        else if (atBottom && !atTop) bottom = Math.max(bottom, h)
    }
    return { top, bottom }
}

const gridCols = () => Math.max(1, Math.floor((monW - GRID_MARGIN * 2) / CELL_W))
const gridRows = () => {
    const { top, bottom } = reservedInsets()
    return Math.max(1,
        Math.floor((monH - top - bottom - GRID_MARGIN * 2) / CELL_H))
}

const slotKey = (s: Slot) => `${s.col},${s.row}`

function slotAt(x: number, y: number): Slot {
    return {
        col: Math.min(gridCols() - 1,
            Math.max(0, Math.floor((x - GRID_MARGIN) / CELL_W))),
        row: Math.min(gridRows() - 1,
            Math.max(0, Math.floor(
                (y - GRID_MARGIN - reservedInsets().top) / CELL_H))),
    }
}

function slotPixels(s: Slot): [number, number] {
    return [
        GRID_MARGIN + s.col * CELL_W,
        GRID_MARGIN + reservedInsets().top + s.row * CELL_H,
    ]
}

// row-major scan for the first slot not in `occupied` (runs past the
// bottom edge when the grid is full, same overflow as auto-arrange)
function firstFreeSlot(occupied: Set<string>): Slot {
    const cols = gridCols()
    for (let i = 0; ; i++) {
        const s = { col: i % cols, row: Math.floor(i / cols) }
        if (!occupied.has(slotKey(s))) return s
    }
}

// persisted free-placement slots, path → [col, row]
const LAYOUT_FILE = `${GLib.get_user_config_dir()}/kiwi-shell/desktop-layout.json`
const layout = new Map<string, Slot>()
try {
    const parsed = JSON.parse(readFile(LAYOUT_FILE))
    for (const [path, s] of Object.entries(parsed))
        if (Array.isArray(s)) layout.set(path, { col: s[0], row: s[1] })
} catch {} // first run: no layout yet

let saveTimeout: number | null = null
function saveLayout() {
    if (saveTimeout !== null) GLib.source_remove(saveTimeout)
    saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        saveTimeout = null
        const obj: Record<string, [number, number]> = {}
        for (const [p, s] of layout) obj[p] = [s.col, s.row]
        writeFileAsync(LAYOUT_FILE, JSON.stringify(obj, null, 2))
            .catch((e) => log.error("failed to save layout:", e))
        return GLib.SOURCE_REMOVE
    })
}

// slots promised to files that are still being copied in: relayout must
// not prune them before the file shows up (15s grace)
const seededAt = new Map<string, number>()

function nextSlot(s: Slot): Slot {
    return s.col + 1 < gridCols()
        ? { col: s.col + 1, row: s.row }
        : { col: 0, row: s.row + 1 }
}

// external drops land where they were dropped: pre-assign grid slots to
// the incoming paths; relayout honors them once the files appear
function seedSlots(paths: string[], x: number, y: number) {
    const occupied = new Set([...layout.values()].map(slotKey))
    let slot = slotAt(x, y)
    for (const p of paths) {
        while (occupied.has(slotKey(slot))) slot = nextSlot(slot)
        layout.set(p, slot)
        seededAt.set(p, GLib.get_monotonic_time())
        occupied.add(slotKey(slot))
    }
    saveLayout()
}

function relayout() {
    const fixed = fixedRef
    if (!fixed) return
    const list = items.get()
    const byPath = new Map(list.map((i) => [i.path, i]))

    // drop widgets for removed files, rebuild ones whose look changed
    for (const [path, w] of [...iconWidgets]) {
        const item = byPath.get(path)
        const version = item && `${item.name}\0${item.isDir}\0${item.contentType}`
        if (item && version === iconVersion.get(path)) continue
        fixed.remove(w)
        iconWidgets.delete(path)
        iconVersion.delete(path)
    }
    for (const item of list) {
        if (iconWidgets.has(item.path)) continue
        const w = DesktopIcon({ item }) as Gtk.Widget
        if (selected.get().has(item.path)) w.add_css_class("selected")
        iconWidgets.set(item.path, w)
        iconVersion.set(item.path, `${item.name}\0${item.isDir}\0${item.contentType}`)
        fixed.put(w, 0, 0)
    }

    if (!freePlacement()) {
        // auto-arrange: sorted items fill rows left-to-right
        const cols = gridCols()
        list.forEach((item, i) => {
            const [x, y] = slotPixels({ col: i % cols, row: Math.floor(i / cols) })
            fixed.move(iconWidgets.get(item.path)!, x, y)
        })
        return
    }

    // free placement: persisted slots; new files take the first free one
    let changed = false
    for (const path of [...layout.keys()]) {
        if (byPath.has(path)) { seededAt.delete(path); continue }
        const seeded = seededAt.get(path)
        if (seeded !== undefined
            && GLib.get_monotonic_time() - seeded < 15_000_000) continue
        layout.delete(path)
        seededAt.delete(path)
        changed = true
    }
    const occupied = new Set<string>()
    // slots promised to in-flight drops count as taken
    for (const [path, s] of layout)
        if (!byPath.has(path)) occupied.add(slotKey(s))
    for (const item of list) {
        let slot = layout.get(item.path)
        if (slot && (slot.col >= gridCols() || occupied.has(slotKey(slot))))
            slot = undefined
        if (!slot) {
            slot = firstFreeSlot(occupied)
            layout.set(item.path, slot)
            changed = true
        }
        occupied.add(slotKey(slot))
        const [x, y] = slotPixels(slot)
        fixed.move(iconWidgets.get(item.path)!, x, y)
    }
    if (changed) saveLayout()
}

// auto-arrange in one shot: forget every remembered slot and let relayout
// refill the grid from the top-left in sort order. Only free placement can
// be untidy — auto-arrange never leaves a gap to clean up.
function cleanUp() {
    layout.clear()
    seededAt.clear()
    saveLayout()
    relayout()
}

items.subscribe(relayout)
// placement mode, dock mode (exclusive zone!) etc. all live in the config
conf.subscribe(relayout)

// reservedInsets() depends on the other shell windows' sizes, which are 0
// until the compositor allocates them — re-layout exactly when they change
// instead of guessing with timers
const watchedSurfaces = new WeakSet<Gdk.Surface>()

function watchWindow(win: Gtk.Window) {
    if (!(win instanceof Astal.Window) || win.name === "ags-desktop") return
    const attach = () => {
        const surface = win.get_surface()
        if (!surface || watchedSurfaces.has(surface)) return
        watchedSurfaces.add(surface)
        surface.connect("notify::height", relayout)
        surface.connect("notify::width", relayout)
    }
    if (win.get_realized()) attach()
    win.connect("realize", attach)
    // dock flips exclusivity/visibility with its autohide mode
    win.connect("notify::exclusivity", relayout)
    win.connect("notify::visible", relayout)
}

app.get_windows().forEach(watchWindow)
app.connect("window-added", (_app: unknown, win: Gtk.Window) => {
    watchWindow(win)
    relayout()
})
app.connect("window-removed", relayout)

selected.subscribe(() => {
    const sel = selected.get()
    for (const [path, w] of iconWidgets) {
        if (sel.has(path)) w.add_css_class("selected")
        else w.remove_css_class("selected")
    }
})

// ---------------------------------------------------------------------- dnd

// GNOME semantics: file managers offer MOVE (dragging within the session
// moves), sources that only offer COPY (browsers etc.) copy; holding Ctrl
// already strips MOVE from the offer upstream, forcing a copy
function preferredDropAction(target: Gtk.DropTarget): Gdk.DragAction {
    const actions = target.get_current_drop()?.get_actions() ?? Gdk.DragAction.COPY
    return actions & Gdk.DragAction.MOVE ? Gdk.DragAction.MOVE : Gdk.DragAction.COPY
}

function handleFileDrop(
    value: Gdk.FileList,
    move: boolean,
    destDir = DESKTOP_DIR,
    dropAt?: { x: number; y: number },
): boolean {
    const uris = value.get_files().map((f: Gio.File) => f.get_uri())
    if (uris.length === 0) return false
    log.debug(`[Desktop] drop ${uris.length} uri(s) (${move ? "move" : "copy"}) → ${destDir}`)
    const created = pasteUris(uris, move, destDir)
    if (dropAt && destDir === DESKTOP_DIR && freePlacement())
        seedSlots(created, dropAt.x, dropAt.y)
    return created.length > 0
}

// the icon the current internal drag was grabbed by — anchors the offset
// every other dragged icon moves by
let dragOriginPath: string | null = null

function repositionDragged(uris: string[], x: number, y: number): boolean {
    const paths = uris
        .map((u) => Gio.File.new_for_uri(u).get_path())
        .filter((p): p is string => !!p && layout.has(p))
    if (paths.length === 0) return false

    const origin = layout.get(
        dragOriginPath && layout.has(dragOriginPath) ? dragOriginPath : paths[0])!
    const target = slotAt(x, y)
    const dc = target.col - origin.col
    const dr = target.row - origin.row

    const dragged = new Set(paths)
    const occupied = new Set<string>()
    for (const [p, s] of layout)
        if (!dragged.has(p)) occupied.add(slotKey(s))

    // keep the relative arrangement; bump to the next free slot on collision
    const ordered = paths.slice().sort((a, b) => {
        const sa = layout.get(a)!, sb = layout.get(b)!
        return sa.row - sb.row || sa.col - sb.col
    })
    for (const p of ordered) {
        const s = layout.get(p)!
        let dest = {
            col: Math.min(gridCols() - 1, Math.max(0, s.col + dc)),
            row: Math.max(0, s.row + dr),
        }
        while (occupied.has(slotKey(dest))) {
            dest = dest.col + 1 < gridCols()
                ? { col: dest.col + 1, row: dest.row }
                : { col: 0, row: dest.row + 1 }
        }
        layout.set(p, dest)
        occupied.add(slotKey(dest))
    }
    saveLayout()
    relayout()
    return true
}

// ------------------------------------------------------------------ widgets

// the desktop icon (if any) under (x, y)
function iconWidgetAt(root: Gtk.Widget, x: number, y: number): Gtk.Widget | null {
    for (let w = root.pick(x, y, Gtk.PickFlags.DEFAULT); w && w !== root; w = w.get_parent())
        if (w.has_css_class("desktop-item")) return w
    return null
}

function openWithDialog(item: DesktopItem) {
    const file = Gio.File.new_for_path(item.path)
    const dialog = new Gtk.AppChooserDialog({ gfile: file })
    dialog.connect("response", (d: Gtk.AppChooserDialog, response: number) => {
        if (response === Gtk.ResponseType.OK) {
            const appInfo = d.get_app_info()
            try {
                appInfo?.launch([file], null)
            } catch (e) {
                log.error(`Desktop: failed to open ${item.path} with ${appInfo?.get_name()}:`, e)
            }
        }
        d.destroy()
    })
    dialog.present()
}

function DesktopIcon({ item }: { item: DesktopItem }) {
    // context-menu / drag actions target the whole selection when the
    // clicked icon is part of it, just the clicked icon otherwise
    const targets = () => {
        const sel = selectedItems()
        return sel.some((s) => s.path === item.path) ? sel : [item]
    }

    let wasSelectedOnPress = false

    // ---- inline rename: the entry takes the label's place in the cell ----
    const [renaming, setRenaming] = createState(false)
    let renameEntry: Gtk.Entry

    const startRename = () => {
        renameEntry.text = item.name
        setRenaming(true)
    }

    const finishRename = (commit: boolean) => {
        if (!renaming.get()) return
        setRenaming(false)
        if (commit) renameItem(item, renameEntry.text)
    }

    // one target, and never a launcher: its name is the application's, so
    // committing it would write the app name over the .desktop file
    const renameable = item.appInfo
        ? false
        : selected.as((sel) => !sel.has(item.path) || sel.size === 1)

    const menuItems: ContextMenuItem[] = [
        {
            label: "Open",
            icon: "document-open-symbolic",
            onClick: () => targets().forEach(openItem),
        },
        {
            label: "Open With…",
            icon: "system-run-symbolic",
            onClick: () => openWithDialog(item),
        },
        { separator: true },
        {
            label: "Set as Wallpaper",
            icon: "preferences-desktop-wallpaper-symbolic",
            visible: !!item.contentType?.startsWith("image/"),
            onClick: () => setWallpaper(item.path),
        },
        {
            label: "Show in Files",
            icon: "folder-symbolic",
            onClick: () => openPath(DESKTOP_DIR),
        },
        { separator: true },
        {
            label: "Copy",
            icon: "edit-copy-symbolic",
            onClick: () => copyItems(targets()),
        },
        {
            label: "Cut",
            icon: "edit-cut-symbolic",
            onClick: () => copyItems(targets(), true),
        },
        {
            label: "Rename",
            icon: "document-edit-symbolic",
            visible: renameable,
            onClick: startRename,
        },
        { separator: true },
        {
            label: "Move to Trash",
            icon: "user-trash-symbolic",
            onClick: () => targets().forEach(trashItem),
        },
    ]

    const menu = ContextMenu({ items: menuItems, class: "desktop-menu" })

    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            class="desktop-item"
            widthRequest={90}
            $={(self) => {
                const ctrlHeld = (gesture: Gtk.Gesture) =>
                    !!(gesture.get_current_event_state()
                        & Gdk.ModifierType.CONTROL_MASK)

                const click = new Gtk.GestureClick()
                click.set_button(Gdk.BUTTON_PRIMARY)
                click.connect("pressed", (gesture, nPress) => {
                    // while the entry is up the cell belongs to it: a
                    // double-click in the text must not open the file
                    if (renaming.get()) return
                    if (nPress === 2) {
                        openItem(item)
                        return
                    }
                    wasSelectedOnPress = selected.get().has(item.path)
                    // select on PRESS so a drag can start immediately
                    if (ctrlHeld(gesture)) toggleSelected(item.path)
                    else if (!wasSelectedOnPress) selectOnly([item.path])
                })
                // a plain click on an already-selected icon collapses the
                // selection to just it — on RELEASE, so dragging keeps the
                // group (a started drag claims the sequence and this never
                // fires)
                click.connect("released", (gesture) => {
                    if (!ctrlHeld(gesture) && wasSelectedOnPress)
                        selectOnly([item.path])
                })
                self.add_controller(click)

                const rightClick = new Gtk.GestureClick()
                rightClick.set_button(Gdk.BUTTON_SECONDARY)
                rightClick.connect("released", () => {
                    if (!selected.get().has(item.path)) selectOnly([item.path])
                    menu.popup()
                })
                self.add_controller(rightClick)

                // drag source: uri-list of the selection, so files can be
                // dragged into nautilus, editors, browsers, upload dialogs…
                const drag = new Gtk.DragSource()
                drag.set_actions(Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
                drag.connect("prepare", () => {
                    // selecting text in the rename entry is not a file drag
                    if (renaming.get()) return null
                    if (!selected.get().has(item.path)) selectOnly([item.path])
                    dragOriginPath = item.path
                    const uris = targets().map((i) =>
                        GLib.filename_to_uri(i.path, null))
                    log.debug(`[Desktop] drag ${uris.length} item(s)`)
                    return fileContentProvider(uris)
                })
                drag.connect("drag-begin", (source) => {
                    const theme = Gtk.IconTheme.get_for_display(self.get_display())
                    const paintable = item.gicon
                        ? theme.lookup_by_gicon(item.gicon, 48,
                            self.get_scale_factor(), Gtk.TextDirection.NONE, 0)
                        : theme.lookup_icon("text-x-generic", null, 48,
                            self.get_scale_factor(), Gtk.TextDirection.NONE, 0)
                    source.set_icon(paintable, 24, 24)
                })
                self.add_controller(drag)

                // folders accept file drops (from apps AND from other
                // desktop icons) and receive them like nautilus would
                if (item.isDir) {
                    const drop = Gtk.DropTarget.new(Gdk.FileList.$gtype,
                        Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
                    drop.connect("enter", () => {
                        self.add_css_class("drop-hover")
                        return preferredDropAction(drop)
                    })
                    drop.connect("motion", () => preferredDropAction(drop))
                    drop.connect("leave", () =>
                        self.remove_css_class("drop-hover"))
                    drop.connect("drop", (_target, value: Gdk.FileList) => {
                        self.remove_css_class("drop-hover")
                        const move = preferredDropAction(drop) === Gdk.DragAction.MOVE
                        return handleFileDrop(value, move, item.path)
                    })
                    self.add_controller(drop)
                }
            }}
        >
            {menu}

            {item.gicon
                ? <Gtk.Image gicon={item.gicon} pixelSize={48} class="desktop-item-icon" halign={Gtk.Align.CENTER} />
                : <Gtk.Image iconName="text-x-generic" pixelSize={48} class="desktop-item-icon" halign={Gtk.Align.CENTER} />}
            <label
                class="desktop-item-label"
                visible={renaming((r) => !r)}
                label={item.name}
                justify={Gtk.Justification.CENTER}
                ellipsize={Pango.EllipsizeMode.END}
                lines={2}
                wrap={true}
                wrapMode={Pango.WrapMode.WORD_CHAR}
                maxWidthChars={12}
                halign={Gtk.Align.CENTER}
            />
            <entry
                class="desktop-item-rename"
                visible={renaming}
                // narrower than the label it replaces: the icons sit on a
                // Gtk.Fixed, so an entry that asked for its text's width
                // would grow the cell over its neighbours
                widthChars={6}
                maxWidthChars={10}
                xalign={0.5}
                halign={Gtk.Align.CENTER}
                onActivate={() => finishRename(true)}
                $={(self) => {
                    renameEntry = self

                    // focus can only be taken once GTK has mapped the entry,
                    // and the menu that asked for the rename is still handing
                    // its keyboard grab back at that moment — an idle lands
                    // after both
                    self.connect("map", () => {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            // unfocused, the entry can be neither typed in
                            // nor escaped out of — don't strand the cell
                            if (!self.grab_focus()) {
                                finishRename(false)
                                return GLib.SOURCE_REMOVE
                            }
                            // preselect the stem: the extension is almost
                            // never the part being changed
                            const name = self.text
                            const dot = name.startsWith(".")
                                ? -1 : name.lastIndexOf(".")
                            self.select_region(0, dot > 0 ? dot : -1)
                            return GLib.SOURCE_REMOVE
                        })
                    })

                    const keys = new Gtk.EventControllerKey()
                    keys.connect("key-pressed", (_controller, keyval) => {
                        if (keyval !== Gdk.KEY_Escape) return Gdk.EVENT_PROPAGATE
                        finishRename(false)
                        return Gdk.EVENT_STOP
                    })
                    self.add_controller(keys)

                    // clicking away abandons the edit rather than committing
                    // a half-typed name
                    const focus = new Gtk.EventControllerFocus()
                    focus.connect("leave", () => finishRename(false))
                    self.add_controller(focus)
                }}
            />
        </box>
    )
}

export default function Desktop({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const geometry = gdkmonitor.get_geometry()
    monW = geometry.width
    monH = geometry.height
    monitorRef = gdkmonitor

    // re-read on every popup: the clipboard can change while the menu is shut
    const [canPaste, setCanPaste] = createState(false)

    // context menu for empty desktop space; parented onto the overlay below
    const desktopMenu = ContextMenu({
        class: "desktop-menu",
        items: [
            {
                label: "New Folder",
                icon: "folder-new-symbolic",
                onClick: newFolder,
            },
            {
                label: "Paste",
                icon: "edit-paste-symbolic",
                sensitive: canPaste,
                onClick: pasteFromClipboard,
            },
            { separator: true },
            {
                label: "Change Wallpaper…",
                icon: "preferences-desktop-wallpaper-symbolic",
                onClick: promptWallpaper,
            },
            {
                label: "Open Terminal Here",
                icon: "utilities-terminal-symbolic",
                onClick: () => openTerminal(DESKTOP_DIR),
            },
            {
                label: "Open in Files",
                icon: "folder-symbolic",
                onClick: () => openPath(DESKTOP_DIR),
            },
            {
                label: "Desktop Settings…",
                icon: "preferences-system-symbolic",
                onClick: () => subprocess(["kiwi-settings"]),
            },
            { separator: true },
            {
                label: "Clean Up",
                icon: "view-grid-symbolic",
                // auto-arrange has no loose icons to collect
                visible: conf.as((c: any) => !!c.desktop_free_placement),
                onClick: cleanUp,
            },
            {
                label: "Select All",
                icon: "edit-select-all-symbolic",
                onClick: selectAll,
            },
        ],
    })

    return (
        <window
            namespace={LAYER.plain}
            name="ags-desktop"
            class={themeClasses(t => `Desktop ${t}`)}
            css={conf(c => `--primary: ${c.primary_color};`)}
            gdkmonitor={gdkmonitor}
            // IGNORE: cover the full monitor (under bar and dock) so the
            // rubber band isn't clipped at the exclusive zones; the icon
            // grid dodges those areas itself via reservedInsets()
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.BOTTOM}
            // on-demand: clicking the desktop focuses it (like any desktop),
            // enabling Delete-to-trash and Enter-to-open on the selection
            keymode={Astal.Keymode.ON_DEMAND}
            $={(self) => {
                // visibility is applied AFTER construction, never as a
                // constructor prop: gnim hands all props to the constructor
                // in written order, so a window that is visible at construct
                // time maps before layer/anchor are set and stays on the
                // default TOP layer — fullscreen, above the dock, eating its
                // input. Verified live: identical window lands on bottom vs
                // top purely by prop order.
                const visible = conf.as((c: any) => !!c.desktop_icons)
                self.visible = visible()
                const dispose = visible.subscribe(() => { self.visible = visible() })
                onCleanup(dispose)
                onCleanup(() => destroyWindow(self))

                // a window taking focus (click into an app) clears the
                // desktop selection, like every OS desktop
                self.connect("notify::is-active", () => {
                    if (!self.isActive) clearSelection()
                })

                const keys = new Gtk.EventControllerKey()
                keys.connect("key-pressed", (_controller, keyval, _code, state) => {
                    const ctrl = !!(state & Gdk.ModifierType.CONTROL_MASK)
                    if (ctrl && (keyval === Gdk.KEY_v || keyval === Gdk.KEY_V)) {
                        pasteFromClipboard()
                        return Gdk.EVENT_STOP
                    }
                    if (ctrl && (keyval === Gdk.KEY_c || keyval === Gdk.KEY_C)) {
                        const list = selectedItems()
                        if (list.length) { copyItems(list); return Gdk.EVENT_STOP }
                        return Gdk.EVENT_PROPAGATE
                    }
                    if (ctrl && (keyval === Gdk.KEY_x || keyval === Gdk.KEY_X)) {
                        const list = selectedItems()
                        if (list.length) { copyItems(list, true); return Gdk.EVENT_STOP }
                        return Gdk.EVENT_PROPAGATE
                    }
                    if (ctrl && (keyval === Gdk.KEY_a || keyval === Gdk.KEY_A)) {
                        selectAll()
                        return Gdk.EVENT_STOP
                    }
                    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
                        const list = selectedItems()
                        if (list.length) {
                            list.forEach(openItem)
                            return Gdk.EVENT_STOP
                        }
                    }
                    // Delete moves the selection to trash
                    if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) {
                        const list = selectedItems()
                        if (list.length) {
                            list.forEach(trashItem)
                            return Gdk.EVENT_STOP
                        }
                    }
                    return Gdk.EVENT_PROPAGATE
                })
                self.add_controller(keys)
            }}
        >
            <overlay
                $={(self) => {
                    desktopMenu.set_parent(self)
                    onCleanup(() => desktopMenu.unparent())

                    // clicking empty desktop space clears the selection;
                    // Ctrl-clicks are spared for additive rubber-banding
                    const click = new Gtk.GestureClick()
                    click.set_button(Gdk.BUTTON_PRIMARY)
                    click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                    click.connect("pressed", (gesture, _n, x, y) => {
                        const ctrl = !!(gesture.get_current_event_state()
                            & Gdk.ModifierType.CONTROL_MASK)
                        if (!ctrl && !iconWidgetAt(self, x, y)) clearSelection()
                    })
                    self.add_controller(click)

                    // right-click on empty space: desktop menu at the pointer
                    const rightClick = new Gtk.GestureClick()
                    rightClick.set_button(Gdk.BUTTON_SECONDARY)
                    rightClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                    rightClick.connect("pressed", (_gesture, _n, x, y) => {
                        if (iconWidgetAt(self, x, y)) return // icon menu handles it
                        setCanPaste(clipboardHasFiles())
                        desktopMenu.set_pointing_to(new Gdk.Rectangle({
                            x: Math.round(x), y: Math.round(y), width: 1, height: 1,
                        }))
                        desktopMenu.popup()
                    })
                    self.add_controller(rightClick)

                    // rubber-band selection: drag on empty space draws a
                    // marquee and selects every icon it touches (Ctrl adds
                    // to the existing selection, GNOME-style)
                    const bandLayer = new Gtk.Fixed({
                        canTarget: false, hexpand: true, vexpand: true,
                    })
                    const band = new Gtk.Box({ visible: false, canTarget: false })
                    band.add_css_class("rubberband")
                    bandLayer.put(band, 0, 0)
                    self.add_overlay(bandLayer)

                    const rubber = new Gtk.GestureDrag()
                    rubber.set_button(Gdk.BUTTON_PRIMARY)
                    rubber.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                    let bandActive = false
                    let startX = 0
                    let startY = 0
                    // Ctrl-drag adds to whatever was selected at drag start
                    let keepSelected = new Set<string>()
                    rubber.connect("drag-begin", (gesture, x, y) => {
                        // drags starting on an icon are file drags, not bands
                        if (iconWidgetAt(self, x, y)) {
                            gesture.set_state(Gtk.EventSequenceState.DENIED)
                            return
                        }
                        startX = x
                        startY = y
                        bandActive = false
                        const ctrl = !!(gesture.get_current_event_state()
                            & Gdk.ModifierType.CONTROL_MASK)
                        keepSelected = new Set(ctrl ? selected.get() : [])
                    })
                    rubber.connect("drag-update", (gesture, dx, dy) => {
                        if (!bandActive && Math.abs(dx) < 6 && Math.abs(dy) < 6)
                            return
                        if (!bandActive) {
                            bandActive = true
                            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
                            band.visible = true
                        }
                        const rx = Math.min(startX, startX + dx)
                        const ry = Math.min(startY, startY + dy)
                        const rw = Math.abs(dx)
                        const rh = Math.abs(dy)
                        bandLayer.move(band, rx, ry)
                        band.set_size_request(
                            Math.max(1, Math.round(rw)),
                            Math.max(1, Math.round(rh)))
                        const hits = new Set(keepSelected)
                        for (const [path, w] of iconWidgets) {
                            const [ok, b] = w.compute_bounds(self)
                            if (ok
                                && b.get_x() < rx + rw
                                && b.get_x() + b.get_width() > rx
                                && b.get_y() < ry + rh
                                && b.get_y() + b.get_height() > ry)
                                hits.add(path)
                        }
                        setSelected(hits)
                    })
                    rubber.connect("drag-end", () => {
                        bandActive = false
                        band.visible = false
                        band.set_size_request(1, 1)
                    })
                    self.add_controller(rubber)

                    // file drops: external drags land files on the desktop;
                    // internal drags reposition icons (free placement only —
                    // auto-arranged icons have nowhere to go)
                    const drop = Gtk.DropTarget.new(Gdk.FileList.$gtype,
                        Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
                    const isInternal = () => !!drop.get_current_drop()?.get_drag()
                    const acceptAction = () => {
                        if (!isInternal()) return preferredDropAction(drop)
                        return freePlacement() ? Gdk.DragAction.MOVE : 0
                    }
                    drop.connect("enter", acceptAction)
                    drop.connect("motion", acceptAction)
                    drop.connect("drop", (_target, value: Gdk.FileList, x, y) => {
                        if (isInternal()) {
                            if (!freePlacement()) return false
                            const uris = value.get_files()
                                .map((f: Gio.File) => f.get_uri())
                            return repositionDragged(uris, x, y)
                        }
                        const move = preferredDropAction(drop) === Gdk.DragAction.MOVE
                        return handleFileDrop(value, move, DESKTOP_DIR, { x, y })
                    })
                    self.add_controller(drop)
                }}
            >
            {/* 1×1 near-invisible node: with the last icon removed the window's
                render tree would be empty and GTK never commits the final
                cleared frame — the compositor keeps showing the stale icon
                (verified: 0 flowbox children while the icon stayed on screen) */}
            <box
                $type="overlay"
                class="desktop-damage-anchor"
                halign={Gtk.Align.START}
                valign={Gtk.Align.END}
                widthRequest={1}
                heightRequest={1}
                canTarget={false}
            />
            <Gtk.Fixed
                class="desktop-icons"
                hexpand={true}
                vexpand={true}
                $={(self) => {
                    fixedRef = self
                    relayout()
                }}
            />
            </overlay>
        </window>
    )
}
