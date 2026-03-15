import { createState, createEffect } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { exec, execAsync } from "ags/process"
import Gio from "gi://Gio"

import { conf, setConf, writeConf } from "../../../config"
import { Icon } from "../../../iconNames";

function getCurrentWallpaper(connector?: string): string | null {
    try {
        const output = exec("swww query")
        const lines = output.split("\n").filter(l => l.includes("image: "))
        
        const line = connector 
            ? lines.find(l => l.includes(connector)) ?? lines[0]
            : lines[0]
            
        const match = line?.match(/image:\s*(.+)$/)
        return match ? match[1].trim() : null
    } catch (error) {
        execAsync("swww-daemon").catch(() => {})
        console.log("swww daemon not running, starting...")
    }
    return null
}

const [wallpaperPath, storeWallpaperPath] = createState<string | null>(null)

let retryInterval: number | null = null

function setupWallpaperPolling() {
    const path = getCurrentWallpaper()
    if (path) {
        storeWallpaperPath(path)
        if (retryInterval) {
            clearInterval(retryInterval)
            retryInterval = null
        }
        return
    }
    
    if (!retryInterval) {
        console.log("Starting wallpaper polling...")
        retryInterval = setInterval(() => {
            const path = getCurrentWallpaper()
            if (path) {
                console.log("Successfully connected to swww daemon")
                storeWallpaperPath(path)
                clearInterval(retryInterval!)
                retryInterval = null
            }
        }, 2000) as unknown as number
    }
}

setupWallpaperPolling()

const rgba = new Gdk.RGBA()
rgba.parse(conf().primary_color)

export default function ThemeTab({visible}) {
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    createEffect(() => {
        const path = wallpaperPath()
        if (!path) {
            setTexture(null)
            return
        }
        try {
            const file = Gio.File.new_for_path(path)
            const t = Gdk.Texture.new_from_file(file)
            setTexture(t)
        } catch (e) {
            console.error("Failed to load texture:", e)
            setTexture(null)
        }
    })

    return (
        <box visible={visible} orientation={Gtk.Orientation.VERTICAL}>
            <box class="large-header">
                Wallpaper
            </box>
            <box class="wallpaper-section" halign={Gtk.Align.CENTER} spacing={36}>
                <box
                    class="wallpaper-buttons"
                    spacing={6}
                    valign={Gtk.Align.CENTER}
                    hexpand={true}
                >
                    <button onClicked={() => promptWallpaper()}>
                        <box halign={Gtk.Align.CENTER}>
                            <label label="Select File" />
                        </box>
                    </button>
                    <button valign={Gtk.Align.CENTER} vexpand={false} visible={false}>
                        <Icon
                            halign={Gtk.Align.CENTER}
                            iconName="media-playlist-shuffle-symbolic"
                            pixelSize={14}
                        />
                    </button>
                </box>


                <Gtk.ScrolledWindow
                    valign={Gtk.Align.CENTER}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.NEVER}
                    css="min-width: 108px; min-height: 54px; border-radius: 4px;"
                    halign={Gtk.Align.END}
                >
                    <Gtk.Picture
                        class="wallpaper-preview"
                        paintable={texture}
                        contentFit={Gtk.ContentFit.COVER}
                        halign={Gtk.Align.CENTER}
                    />
                </Gtk.ScrolledWindow>
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
    execAsync(["bash", "-c", `zenity --file-selection \
        --title="Select a Wallpaper" \
        --file-filter="Image files | *.jpg *.jpeg *.png *.gif *.pnm *.tga *.tiff *.tif *.webp *.bmp *.farbfeld *.ff *.svg" \
        --file-filter="All files | *" \
        2>/dev/null`])
        .then((path) => {
            const cleanPath = path.trim()
            if (!cleanPath) return

            if (conf().auto_color) {
                execAsync(`kiwi-settings auto-color "${cleanPath}"`)
            }

            execAsync(`swww img "${cleanPath}" --transition-type wipe --transition-fps 120`)
                .then(() => {
                    storeWallpaperPath(cleanPath)
                })
                .catch((error) => {
                    console.error("Failed to set wallpaper:", error)
                })
        })
        .catch(() => {
            console.log("Wallpaper selection cancelled or failed.")
        })
}

export function cleanup() {
    if (retryInterval) {
        clearInterval(retryInterval)
        retryInterval = null
    }
}