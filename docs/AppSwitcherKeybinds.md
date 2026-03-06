# How to Create Proper Alt+Tab Keybinds for the App Switcher
To create natural keybinds like in Windows, MacOS and Ubuntu, we use Hyprland's [submap](https://wiki.hypr.land/Configuring/Binds/#submaps) feature.

In your hyprland config, add the following:
```bash
submap = app_switcher

# Allow repeating TAB while holding ALT to cycle the menu
binde = ALT, TAB, exec, desktop-ctl apps open-next

# Capture the exact release of the Left Alt key using the 'rt' flags
bindrt = ALT, ALT_L, exec, desktop-ctl apps confirm
bindrt = ALT, ALT_L, submap, reset

# Provide a failsafe to abort if you change your mind
bindr = , escape, exec, desktop-ctl apps close
bindr = , escape, submap, reset

bindr = ALT, escape, exec, desktop-ctl apps close
bindr = ALT, escape, submap, reset

# Terminate the submap declaration
submap = reset
```
If you use NixOS and you configure hyprland in a .nix file, you will likely to put this into the extraConfig string and not the settings section.

Add the keybind to enter open the app switcher and enter the submap:
```hyprland
bind = ALT, TAB, exec, desktop-ctl apps open-next
bind = ALT, TAB, submap, app_switcher
```
To open the menu, press `Alt`+`Tab` and hold on to `Alt`. Press `Tab` again while holding `Alt` to cycle trough the applications.
