# Kiwi Shell

A macOS-inspired feature rich desktop shell for **Hyprland**.

![Screenshot](./docs/screenshots/screenshot3.png)

---

## Requirements

**Hyprland** 0.56+ with lua config.

Make sure the following services are installed and running on your system:

| Service | Purpose |
|---|---|
| NetworkManager | Wi-Fi & network management |
| BlueZ | Bluetooth |
| Power Profiles Daemon | Power mode switching |
| WirePlumber | Audio control |
| UPower | Battery info *(optional, recommended for laptops)* |

---

## Installation

### Arch Linux

**1.** Install the required system services:

```bash
sudo pacman -S networkmanager bluez power-profiles-daemon wireplumber upower
```

**2.** Install Kiwi Shell from the AUR:

```bash
yay -S kiwi-shell
```

**3.** Optional: kiwi's Hyprland plugin (the dock follows dragged windows,
live switcher previews, the minimize animation), rebuilt with `hyprpm update`
after every Hyprland or Kiwi Shell update:

```bash
hyprpm add https://github.com/selimbucher/kiwi-shell
hyprpm enable kiwi
hyprpm reload
```

```lua
-- hyprland.lua: load it at login
hl.on("hyprland.start", function()
  hl.exec_cmd("hyprpm reload -n")
end)
```

kiwi-settings shows the same under Desktop → Compositor.

### NixOS & Home Manager

**1.** Add Kiwi Shell to your `flake.nix` inputs:

```nix
{
  inputs = {
    kiwi-shell.url = "github:selimbucher/kiwi-shell";
    kiwi-shell.inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

**2.** Enable it in your Home Manager config (usually `home.nix`):

```nix
{ inputs, ... }:
{
  imports = [ inputs.kiwi-shell.homeManagerModules.default ];

  # its Hyprland plugin is built against programs.hyprland.package (NixOS),
  # else wayland.windowManager.hyprland.package, else pkgs.hyprland, and the
  # shell loads it itself — nothing else to do
  services.kiwi-shell.enable = true;
}
```

Without Home Manager, apply `inputs.kiwi-shell.overlays.default` and install
`pkgs.kiwi-shell`.

### Updating

```bash
# Arch
yay -Syu
hyprpm update

# NixOS & Home Manager
nix flake update kiwi-shell
sudo nixos-rebuild switch --flake .   # or: home-manager switch --flake .

# then log out and back in: a running Hyprland keeps the plugin it loaded
```

---

## Usage

Start Kiwi Shell by running:

```bash
kiwi
```

## Features
- Application dock
- Ability to minimize applications
- App Switcher (Alt+Tab)
- Workspace Switcher (Super+Tab)
- Launcher (Super)
- Tray, System Menu and Power Menu
- Accent Color automatically matching the wallpaper

### Shortcuts

Shortcuts are assigned to hyprland when kiwi-shell launches. You can change them in the kiwi settings.

---

## Icon Theme & Font

To match the look in the screenshots, install the following:

- **Font:** [Quicksand](https://aur.archlinux.org/packages/ttf-quicksand-variable) (`ttf-quicksand-variable` on AUR)
- **Icons:** [WhiteSur Icon Theme](https://github.com/vinceliuice/WhiteSur-icon-theme) with *Alternative Icons* and *Bold Panel Icons* enabled
