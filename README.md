# Wayland Desktop Dotfiles
Visually appealing desktop widgets for hyprland. Made with AGS and Astal.
![Screenshot](./screenshots/screenshot1.png)
## Dependencies
Currently, this app assumes that the following packages are installed on the system.
- [ags](https://github.com/Aylur/ags)
- zenity
- wireplumber
- hyprland
- sww
- networkmanager
- power-profiles-daemon
- bluetoothd  

It also depends on the following [Astal](https://github.com/aylur/astal) libraries.
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

For installing astal packages, refer to the [Wiki](https://aylur.github.io/astal/). If you are on NixOS, you may find `flake.nix` useful.
The app might crash if you're not using a laptop with keyboard backlights.
## Installation

Make sure that you have the required dependencies installed.
#### Step 1
Clone this repository to a convinient location.
#### Step 2
Create these two files:  
`~/.config/desktop/colors.json`
```json
{
  "primary": "rgb(179,165,231)"
}
```
.    
`~/.config/desktop/hypr.conf`
```conf
$primaryColor = rgba(179,165,231,0.6)
```
#### Step 3 (optional)
Include `hypr.conf` in your main configuration for hyprland and set the active window border color to `$primaryColor`.
#### Step 3
Start the app by running
```bash
ags run /path/to/project/app.ts
```
## Commands
You can display volume and brightness with
```bash
ags request show volume
```
```bash
ags request show brightness
```
These commands should be binded to the corresponding buttons on the keyboard.
