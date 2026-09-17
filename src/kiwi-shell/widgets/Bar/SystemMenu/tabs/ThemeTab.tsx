import { createState, type Accessor } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import Gio from "gi://Gio"
import Pango from "gi://Pango"

import { conf, setConf, writeConf } from "../../../config"
import { logger } from "../../../../log"
const log = logger("theme")
import { Icon } from "../../../iconNames";
import {
    wallpaperPath,
    refreshWallpaper,
    setWallpaper,
    pictureFolder,
    listWallpapers,
    wallpaperName,
    wallpaperDetail,
    loadThumbnail,
} from "../../../services/wallpaper"

// The system appearance is org.gnome.desktop.interface color-scheme: it is what
// xdg-desktop-portal serves, so GTK4/libadwaita, Qt, browsers and Electron apps
// follow it directly. Anything that can't (GTK3 themes, compositor colours)
// is up to the desktop config to sync from the same key.
const INTERFACE_SCHEMA = "org.gnome.desktop.interface"
const interfaceSettings = Gio.SettingsSchemaSource.get_default()?.lookup(INTERFACE_SCHEMA, true)
    ? new Gio.Settings({ schema_id: INTERFACE_SCHEMA })
    : null

const readDarkMode = () => interfaceSettings?.get_string("color-scheme") === "prefer-dark"
const [darkMode, storeDarkMode] = createState(readDarkMode())
interfaceSettings?.connect("changed::color-scheme", () => storeDarkMode(readDarkMode()))

function setDarkMode(dark: boolean) {
    if (dark === readDarkMode()) return
    interfaceSettings?.set_string("color-scheme", dark ? "prefer-dark" : "prefer-light")
}

const [wallpapers, setWallpapers] = createState<string[]>([])

const rgba = new Gdk.RGBA()
rgba.parse(conf().primary_color)

export default function ThemeTab({visible}) {
    return (
        <box
            visible={visible}
            orientation={Gtk.Orientation.VERTICAL}
            onMap={() => {
                // the menu may have been closed while something else changed it
                refreshWallpaper()
                const found = listWallpapers()
                if (found.join("\n") !== wallpapers.get().join("\n")) setWallpapers(found)
            }}
        >
            <box visible={interfaceSettings !== null} orientation={Gtk.Orientation.VERTICAL}>
                <box class="large-header">
                    Appearance
                </box>
                <box class="appearance-segmented" hexpand={true} homogeneous={true}>
                    <AppearanceSegment dark={false} label="Light" iconName="weather-clear-symbolic" />
                    <AppearanceSegment dark={true} label="Dark" iconName="weather-clear-night-symbolic" />
                </box>
            </box>
            <box class="large-header">
                Wallpaper
            </box>
            {/* wallpaper_picker: "card" (default) | "grid" | "row" */}
            <box visible={wallpaperPicker("card")}>
                <WallpaperCard />
            </box>
            <box visible={wallpaperPicker("grid")}>
                <WallpaperGrid />
            </box>
            <box visible={wallpaperPicker("row")}>
                <WallpaperRow />
            </box>
            {/* Theme section hidden — kept for future use */}
            <box visible={false} orientation={Gtk.Orientation.VERTICAL}>
                <box class="large-header">
                    Theme
                </box>
                <box
                    class="theme-settings"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={6}
                >
                    <box halign={Gtk.Align.CENTER}>
                        <ThemeSelector /> <ColorPicker />
                    </box>
                </box>
            </box>
        </box>
    )
}

const wallpaperPicker = (style: string) =>
    conf(c => (c.wallpaper_picker ?? "card") === style)

function AppearanceSegment({ dark, label, iconName }: { dark: boolean, label: string, iconName: string }) {
    return (
        <button
            class={darkMode(d => d === dark ? "active" : "")}
            onClicked={() => setDarkMode(dark)}
        >
            <box halign={Gtk.Align.CENTER} spacing={6}>
                <Icon iconName={iconName} pixelSize={14} />
                <label label={label} />
            </box>
        </button>
    )
}

// A picture that never asks for more than its CSS size: the scrolled window
// keeps Gtk.Picture from requesting the image's natural size. Its corners
// only clip the picture with overflow hidden; border-radius alone doesn't.
function Thumbnail({ path, width, height, class: className }: {
    path: Accessor<string | null> | string,
    width: number,
    height: number,
    class: string,
}) {
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)
    const load = (p: string | null) => {
        if (!p) return setTexture(null)
        loadThumbnail(p, width, height).then(t => {
            const current = typeof path === "string" ? path : path.get()
            if (current === p) setTexture(t)
        })
    }
    if (typeof path === "string") load(path)
    else {
        load(path.get())
        path.subscribe(() => load(path.get()))
    }

    return (
        <Gtk.ScrolledWindow
            class={className}
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.NEVER}
            overflow={Gtk.Overflow.HIDDEN}
            css={`min-width: ${width}px; min-height: ${height}px;`}
        >
            <Gtk.Picture paintable={texture} contentFit={Gtk.ContentFit.COVER} />
        </Gtk.ScrolledWindow>
    )
}

const currentName = wallpaperPath(p => p ? wallpaperName(p) : "No wallpaper")
const currentDetail = wallpaperPath(p => p ? wallpaperDetail(p) : "")

// Card: the current wallpaper large, its name on a scrim, actions on top
function WallpaperCard() {
    return (
        <overlay class="wallpaper-card" hexpand={true}>
            <Thumbnail class="wallpaper-card-image" path={wallpaperPath} width={268} height={151} />
            <box $type="overlay" class="wallpaper-card-scrim" valign={Gtk.Align.END} spacing={6}>
                <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.END} hexpand={true}>
                    <label class="wallpaper-name" label={currentName} xalign={0} maxWidthChars={1} ellipsize={Pango.EllipsizeMode.END} />
                    <label class="wallpaper-folder" label={currentDetail} xalign={0} maxWidthChars={1} ellipsize={Pango.EllipsizeMode.MIDDLE} />
                </box>
                <button class="wallpaper-choose" valign={Gtk.Align.END} onClicked={promptWallpaper}>
                    <label label="Change…" />
                </button>
            </box>
        </overlay>
    )
}

// Grid: the included wallpapers, the current one ringed
function WallpaperGrid() {
    return (
        <Gtk.FlowBox
            class="wallpaper-grid"
            hexpand={true}
            homogeneous={true}
            minChildrenPerLine={3}
            maxChildrenPerLine={3}
            rowSpacing={8}
            columnSpacing={8}
            selectionMode={Gtk.SelectionMode.NONE}
            $={self => {
                const tiles = new Map<string, Gtk.Widget>()
                const markCurrent = () => {
                    const current = wallpaperPath.get()
                    for (const [path, tile] of tiles) {
                        if (path === current) tile.add_css_class("current")
                        else tile.remove_css_class("current")
                    }
                }
                // built with plain Gtk: these come and go outside any JSX scope
                const rebuild = () => {
                    self.remove_all()
                    tiles.clear()
                    for (const path of wallpapers.get()) {
                        const tile = gridTile(path)
                        tiles.set(path, tile)
                        self.append(tile)
                    }
                    const add = new Gtk.Button({
                        cssClasses: ["wallpaper-thumb", "add"],
                        tooltipText: "Choose a picture…",
                        child: new Gtk.Image({ iconName: "list-add-symbolic", pixelSize: 16 }),
                    })
                    add.connect("clicked", promptWallpaper)
                    self.append(add)
                    markCurrent()
                }
                rebuild()
                wallpapers.subscribe(rebuild)
                wallpaperPath.subscribe(markCurrent)
            }}
        />
    )
}

function gridTile(path: string): Gtk.Widget {
    const picture = new Gtk.Picture({ contentFit: Gtk.ContentFit.COVER })
    const frame = new Gtk.ScrolledWindow({
        cssClasses: ["wallpaper-thumb-image"],
        hscrollbarPolicy: Gtk.PolicyType.NEVER,
        vscrollbarPolicy: Gtk.PolicyType.NEVER,
        overflow: Gtk.Overflow.HIDDEN,
        child: picture,
    })
    frame.set_size_request(76, 48)
    loadThumbnail(path, 76, 48).then(texture => picture.set_paintable(texture))

    const tile = new Gtk.Button({ cssClasses: ["wallpaper-thumb"], tooltipText: wallpaperName(path), child: frame })
    tile.connect("clicked", () => setWallpaper(path))
    return tile
}

// Row: a compact list row, the way a settings list shows a file
function WallpaperRow() {
    return (
        <box class="wallpaper-row" hexpand={true} spacing={8}>
            <Thumbnail class="wallpaper-row-image" path={wallpaperPath} width={64} height={40} />
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand={true}>
                <label class="wallpaper-name" label={currentName} xalign={0} maxWidthChars={1} ellipsize={Pango.EllipsizeMode.END} />
                <label class="wallpaper-folder" label={currentDetail} xalign={0} maxWidthChars={1} ellipsize={Pango.EllipsizeMode.MIDDLE} />
            </box>
            <button class="wallpaper-icon-button" valign={Gtk.Align.CENTER} tooltipText="Choose a picture…" onClicked={promptWallpaper}>
                <Icon iconName="document-open-symbolic" pixelSize={14} />
            </button>
        </box>
    )
}

function ThemeSelector() {
    const options = ["Dark", "Glass"];
    const myOptions = Gtk.StringList.new(options);

    const currentTheme = conf().theme || "default";
    const foundIndex = options.findIndex(opt => opt.toLowerCase() === currentTheme);
    const defaultIndex = foundIndex !== -1 ? foundIndex : 0;

    return (
        <Gtk.DropDown
            model={myOptions}
            selected={defaultIndex}
            enableSearch={false}
            onNotifySelected={(self) => {
                const selectedItem = self.get_selected_item();
                if (!selectedItem) return;
                const textValue = selectedItem.get_string();
                setConf({ ...conf(), theme: textValue.toLowerCase() });
                writeConf();

                let parent = self.get_parent();
                while (parent && !(parent instanceof Gtk.Popover)) {
                    parent = parent.get_parent();
                }
                if (parent) {
                    parent.popdown();
                    parent.popup();
                }
            }}
        />
    )
}

function ColorPicker() {
    return (
        <Gtk.ColorButton
            class="color-picker"
            rgba={(() => {
                rgba.parse(conf().primary_color)
                return rgba
            })()}
            onColorSet={self => {
                const r = self.rgba
                const hex = rgbaToHex(r)
                setConf({ ...conf(), primary_color: `#${hex}` })
                writeConf()
            }}
            show_editor={true}
        />
    )
}

function rgbaToHex(rgba: any): string {
    const r = Math.round(rgba.red * 255).toString(16).padStart(2, '0')
    const g = Math.round(rgba.green * 255).toString(16).padStart(2, '0')
    const b = Math.round(rgba.blue * 255).toString(16).padStart(2, '0')
    return `${r}${g}${b}`
}

function promptWallpaper() {
    execAsync([
        "zenity", "--file-selection",
        "--title=Choose a Wallpaper",
        `--filename=${pictureFolder()}/`,
        "--file-filter=Image files | *.jpg *.jpeg *.png *.gif *.pnm *.tga *.tiff *.tif *.webp *.bmp *.farbfeld *.ff *.svg",
        "--file-filter=All files | *",
    ])
        .then((path) => {
            const cleanPath = path.trim()
            if (cleanPath) setWallpaper(cleanPath)
        })
        .catch(() => {
            log.info("Wallpaper selection cancelled or failed.")
        })
}
