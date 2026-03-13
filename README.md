# Kiwi Shell for Hyprland
Desktop UI for **Hyprland**. Based on AGS and Astal.

![Screenshot](./docs/screenshots/screenshot1.png)

You can view more screenshots [here](./docs/screenshots/screenshots.md).

## System Requirements
This app requires a standard **Hyprland** setup and assumes the following services running.
- NetworkManager
- BlueZ (Bluetooth)
- Power Profiles Daemon
- WirePlumber
- UPower (optional but recommended for laptops)

## Installation
### NixOS & Home Manager
In your system's flake.nix, add this repository to the inputs block.
```nix
{
  inputs = {
    kiwi-shell.url = "github:selimbucher/hyprland-widgets";
  };
}
```
In your Home Manager configuration file (usually home.nix), add the package to your home.packages list. You will need to pass the inputs argument to your module.
```nix
{ inputs, pkgs, ... }: 

{
  home.packages = [
    inputs.kiwi-shell.packages.${pkgs.system}.default
  ];
}
```
### Arch Linux
Make sure that the required system services are installed.
```
sudo pacman -S networkmanager bluez power-profiles-daemon wireplumber upower
```
You can install kiwi-shell from AUR.
```
yay -S kiwi-shell
```
## Usage
Run the following.
```bash
kiwi
```
You might want to execute this automatically on login.

When changing the theme color using this app, the file `~/.conf/kiwi-shell/hypr.conf` is created.
```conf
$kiwiColorLight = rgba(179,165,231,0.7)
```
You may want to include this in your hyprland config to match the border color of active windows.
### Commands

To controll the Alt+Tab menu, you can use the following commands:
```bash
kiwictl apps open-next
```
```bash
kiwictl apps confirm
```
```bash
kiwictl apps close
```

Recreating the usual keybinds for an app switcher can be a bit tricky. Check out this short [guide](./docs/AppSwitcherKeybinds.md).

## Icon Theme and Font
To recreate the clean look in the screenshots you need to install:
- **Quicksand** (Font)
- [WhiteSur Icon Theme](https://github.com/vinceliuice/WhiteSur-icon-theme) with these settings:
  - Alternative Icons
  - Bold Panel Icons
