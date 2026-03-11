import Gtk from "gi://Gtk"
import { createState, createComputed } from "ags"

const gtkSettings = Gtk.Settings.get_default()

// @ts-ignore
const [iconTheme, setIconTheme] = createState(gtkSettings?.gtk_icon_theme_name ?? "hicolor")
export { iconTheme }

gtkSettings?.connect("notify::gtk-icon-theme-name", () => {
    setIconTheme(gtkSettings.gtk_icon_theme_name)
})

export function Icon({ iconName, pixelSize = 64, class: className = "" }) {
    const resolvedName = typeof iconName === "function"
        ? createComputed(get => filterIconName(get(iconName), get(iconTheme)))
        : iconTheme.as(theme => filterIconName(iconName, theme))

    return (
        <Gtk.Image
            visible={resolvedName.as(name => name != "hide")}
            class={className}
            iconName={resolvedName}
            pixelSize={pixelSize}
        />
    )
}

const ICON_OVERRIDES: Record<string, Record<string, string>> = {
    "WhiteSur": {
        "audio-headphones-symbolic": "headphones-symbolic",
        "power-profile-power-saver-symbolic": "mintupdate-type-kernel-symbolic",
        //"power-profile-performance-symbolic": "gamepad-symbolic",
        "preferences-desktop-wallpaper-symbolic": "image-round-symbolic",
        "preferences-system-power-symbolic": "mintupdate-type-kernel-symbolic",
        "system-settings-symbolic": "prefs-tweaks-symbolic",
        "media-playlist-shuffle-symbolic": "randomize-symbolic",
        "display-brightness-symbolic": "display-brightness-off-symbolic"
    },
    "Adwaita": {
        "tweaks-app-symbolic": "bluetooth-symbolic",
        "preferences-desktop-wallpaper-symbolic": "folder-pictures-symbolic",
        // "audio-input-microphone-muted-symbolic": "microphone-disabled-symbolic",
        "pin-symbolic": "view-pin-symbolic",
        "unpin-symbolic": "list-remove-symbolic",
        "-": "battery-empty-charging-symbolic"
    },
    "Tela": {
      "tweaks-app-symbolic": "bluetooth-symbolic",
      "preferences-desktop-wallpaper-symbolic": "cs-backgrounds-symbolic",
      "utilities-tweak-tool-symbolic": "preferences-system-symbolic"
    },
    "Fluent": {
      "audio-input-microphone-symbolic": "audio-input-microphone-high-symbolic",
      "preferences-system-power-symbolic": "mintupdate-type-kernel-symbolic"
    },
    "Papirus": {
      "unpin-symbolic": "window-unpin-symbolic",
      "system-settings-symbolic": "org.gnome.Settings-symbolic"
    },
    "Reversal": {
      "preferences-system-power-symbolic": "mintupdate-type-kernel-symbolic",
      "night-light-symbolic": "weather-clear-night-symbolic",
      "display-brightness-symbolic": "weather-clear-symbolic",
      "audio-headphones-symbolic": "media-audio-symbolic"
    }
}

export function filterIconName(icon: string, iconTheme: string): string {
    for (const [theme, overrides] of Object.entries(ICON_OVERRIDES)) {
        if (iconTheme.includes(theme)) {
            return overrides[icon] ?? icon
        }
    }
    return icon
}

export function BluetoothDeviceIcon(device: string) {
  return device + '-symbolic'
}

export function powerProfileIcon(profile: string) {
    if (profile == "performance") {
    return "power-profile-performance-symbolic"
  }
  if (profile == "balanced") {
    return "power-profile-balanced-symbolic"
  }
  if (profile == "power-saver") {
    return "power-profile-power-saver-symbolic"
  }
  return "power-profile-balanced-symbolic"
}

export function volumeIcon(percentage: number, is_muted: boolean) {
  if (is_muted) {
    return "audio-volume-muted-symbolic"
  }
  if (percentage >= 0.68) {
    return "audio-volume-high-symbolic"
  } else if ( percentage >= 0.33) {
    return "audio-volume-medium-symbolic"
  }
  else if ( percentage > 0) {
    return "audio-volume-low-symbolic"
  } else {
return "audio-volume-muted-symbolic"
  }
}

export function brightnessIcon(value: number) {
  return "display-brightness-symbolic";

  /*
  if (value >= 2/3) {
    return "display-brightness-high-symbolic"
  } else if ( value >= 1/3) {
    return "display-brightness-medium-symbolic"
  }
  else if ( value > 0) {
    return "display-brightness-low-symbolic"
  } else {
return "display-brightness-off-symbolic"
  }
*/
}

export function keyboardBrightnessIcon(percentage: number) {
  if (percentage >= 1) {
    return 'keyboard-brightness-high-symbolic'
  } else if (percentage >= 0.66) {
    return 'keyboard-brightness-symbolic'
  } else if (percentage >= 0.33) {
    return 'keyboard-brightness-medium-symbolic'
  }
  return 'keyboard-brightness-off-symbolic'
}