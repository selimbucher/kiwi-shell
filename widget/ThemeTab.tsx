import { createState } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { exec } from "ags/process"

import { primaryColor, storePrimaryColor } from "./colors"

// Helper function to safely get the current wallpaper
function getCurrentWallpaper(): string | null {
    try {
        const output = exec("swww query")
        if (output && output.includes("image: ")) {
            return output.split("image: ")[1].trim()
        }
    } catch (error) {
        console.log("swww daemon not running or query failed")
    }
    return null
}

const [wallpaperPath, storeWallpaperPath] = createState<string | null>(null)

// Set up retry mechanism
let retryInterval: number | null = null

function setupWallpaperPolling() {
    // Try to get wallpaper immediately
    const path = getCurrentWallpaper()
    if (path) {
        storeWallpaperPath(path)
        // Success, no need to retry
        if (retryInterval) {
            clearInterval(retryInterval)
            retryInterval = null
        }
        return
    }
    
    // Failed, set up retry every 2 seconds if not already polling
    if (!retryInterval) {
        console.log("Starting wallpapersw polling...")
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

// Start polling on module load
setupWallpaperPolling()

const rgba = new Gdk.RGBA()
rgba.parse(primaryColor.get())

export default function ThemeTab({visible}) {
    return (
        <box visible={visible} orientation={Gtk.Orientation.VERTICAL}>
            <box class="large-header">
                Wallpaper
            </box>
            <box class="wallpaper-section" halign={Gtk.Align.CENTER}>
                <box
                class="wallpaper-buttons"
                spacing={6}
                valign={Gtk.Align.CENTER} hexpand={true}>
                    <button
                     onClicked={() => {
                        promptWallpaper()
                    }}    
                    >
                        <box halign={Gtk.Align.CENTER}>
                            <label label="Select File" />
                        </box>
                    </button>
                    <button valign={Gtk.Align.CENTER} vexpand={false}>
                            <Gtk.Image
                            halign={Gtk.Align.CENTER}
                                iconName="randomize-symbolic"
                                pixelSize={14}
                            />
                    </button>
                </box>
                
                {wallpaperPath ? (
                    <image
                        valign={Gtk.Align.CENTER}
                        class="wallpaper-preview"
                        file={wallpaperPath}
                        pixelSize={96}
                    />
                ) : (
                    <box 
                        class="wallpaper-preview-placeholder"
                        valign={Gtk.Align.CENTER}
                        css="min-width: 96px; min-height: 96px; background-color: rgba(255,255,255,0.1); border-radius: 8px;"
                    >
                        <label label="Waiting for swww..." />
                    </box>
                )}
            </box>
            <ColorPicker />
        </box>
    )
}

function ColorPicker() {
  return (
    <Gtk.ColorButton
    class="color-picker"
    rgba={primaryColor(hex => {
        rgba.parse(primaryColor.get())
        return rgba
    })}
    onColorSet={self =>
        storePrimaryColor(self.rgba)
    }
      show_editor={true}  // Opens directly to custom picker!
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
    const path = exec(`zenity --file-selection \
        --title="Select a Wallpaper" \
        --file-filter="Image files | *.jpg *.jpeg *.png *.gif *.pnm *.tga *.tiff *.tif *.webp *.bmp *.farbfeld *.ff *.svg" \
        --file-filter="All files | *" \
        2>/dev/null`).trim()
    
    if (path) {
        // Try to set wallpaper, but handle if swww isn't running
        try {
            exec(`swww img "${path}" --transition-type wipe --transition-fps 120`)
            storeWallpaperPath(path)
            // If this succeeds and we were polling, stop it
            if (retryInterval) {
                clearInterval(retryInterval)
                retryInterval = null
            }
        } catch (error) {
            console.error("Failed to set wallpaper with swww:", error)
            // Try to initialize swww
            try {
                console.log("Attempting to start swww daemon...")
                exec("swww init")
                // Wait a bit for daemon to start, then try setting wallpaper again
                setTimeout(() => {
                    try {
                        exec(`swww img "${path}" --transition-type wipe --transition-fps 120`)
                        storeWallpaperPath(path)
                    } catch (e) {
                        console.error("Still failed after starting daemon:", e)
                        // Store the path anyway for when daemon becomes available
                        storeWallpaperPath(path)
                    }
                }, 500)
            } catch (initError) {
                console.error("Failed to start swww daemon:", initError)
                // Store the path anyway
                storeWallpaperPath(path)
            }
        }
    }
}

function getAverageColor(imagePath: string): Gdk.RGBA {
    const result = exec(`magick ${imagePath} -resize 1x1 -format "%[pixel:u]" info:`)
    
    const match = result.match(/srgba?\(([\d.]+)%,([\d.]+)%,([\d.]+)%/)
    
    if (match) {
        rgba.red = parseFloat(match[1]) / 100
        rgba.green = parseFloat(match[2]) / 100
        rgba.blue = parseFloat(match[3]) / 100
        rgba.alpha = 1.0
    }
    
    return rgba
}

// Optional: Clean up interval if this module gets unloaded
export function cleanup() {
    if (retryInterval) {
        clearInterval(retryInterval)
        retryInterval = null
    }
}