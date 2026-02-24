# Hyprland Desktop Widgets
Desktop widgets for **Hyprland**. Based on AGS and Astal.

![Screenshot](./screenshots/screenshot1.png)

## System Requirements
This app requires a standard **Hyprland** setup and assumes the following services running.
- NetworkManager
- BlueZ (Bluetooth)
- Power Profiles Daemon
- WirePlumber
- SWWW (for wallpapers)
- UPower (optional but recommended)

## Installation
### NixOS & Home Manager
If you are on NixOS or have the Nix package manager installed with **Flakes enabled**, you do not need to manually install dependencies.
#### Step 1: Add the Input
In your system's flake.nix, add this repository to the inputs block.
```nix
{
  inputs = {
    desktop-widgets.url = "github:selimbucher/hyprland-widgets";
  };
}
```
#### Step 2: Append the Package List
In your Home Manager configuration file (usually home.nix), add the package to your home.packages list. You will need to pass the inputs argument to your module.
```nix
{ inputs, pkgs, ... }: 

{
  home.packages = [
    inputs.desktop-widgets.packages.${pkgs.system}.default
  ];
}
```
### Generic Linux (Arch, Fedora, etc.)
#### Step 1
Clone this repository to a convinient location.
#### Step 2
Install the following dependencies:
- zenity
- sox
- imagemagick
- psmisc

And install the following [Astal](https://github.com/aylur/astal) libraries.
- io
- astal4
- battery
- network
- hyprland
- wireplumber
- mpris
- powerprofiles
- bluetooth
- tray
- apps

For installing astal packages, refer to the [Wiki](https://aylur.github.io/astal/).

#### Step 3
Start the app by running
```bash
ags run /path/to/project/app.ts
```

Note: There is a script **install.sh** that builds everything into a binary, but it has not been tested.

## Usage
Run the following.
```bash
desktop
```
You might want to execute this automatically on login.

When changing the theme color using this app, the file `~/.conf/desktop/hypr.conf` is created.
```conf
$primaryColor = rgba(179,165,231,0.6)
```
You may want to include this in your hyprland config to match the border color of active windows.
### Commands
You can display volume and brightness indicators with
```bash
desktop-ctl show volume
```
```bash
desktop-ctl show brightness
```
This will display the volume and brightness for a few seconds in a small widget at the bottom.
These commands should be binded to the corresponding buttons on the keyboard.

For controling the Alt+Tab menu, you can use the following commands:
```bash
desktop-ctl apps open-next
```
```bash
desktop-ctl apps confirm
```
```bash
desktop-ctl apps close
```
## Icon Theme and Font
To recreate the clean look in the screenshots you need to install:
- **Quicksand** (Font)
- [WhiteSur GTK Theme](https://github.com/vinceliuice/WhiteSur-gtk-theme)
- [WhiteSur Icon Theme](https://github.com/vinceliuice/WhiteSur-icon-theme)
