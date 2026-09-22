# App Switcher Keybinds

**You normally don't need to do anything.** On startup (and after every config
reload) kiwi-shell registers natural Alt+Tab keybinds automatically, using
Hyprland's [submap](https://wiki.hypr.land/Configuring/Binds/#submaps) feature —
press `Alt`+`Tab` and hold `Alt`, press `Tab` again to cycle through the
applications, release `Alt` to switch, or press `Escape` to abort.

If `ALT+TAB` (or `ALT+ALT_L`) is bound to something unrelated to the app
switcher in your Hyprland config, kiwi-shell leaves your keyboard alone and
registers nothing — custom alt-tab workflows keep working unchanged. Binds
whose description starts with `kiwi:` are considered kiwi-shell's own and are
refreshed to the current scheme on startup.

> **Hyprland ≥0.56 with a lua config required.** kiwi-shell speaks the lua
> IPC dialect exclusively — on a legacy hyprlang config the dynamic bind
> registration (and window dispatching) does not work, and hyprlang is on its
> way out upstream anyway.

## Manual setup (custom keys)

For different keys, bind kiwi-shell's global shortcuts yourself: `apps-next` on
a press, `apps-confirm` and `apps-close` on a release. This is the equivalent
of what kiwi-shell sets up automatically:

```lua
-- Open the switcher and enter the submap
hl.bind("ALT + TAB", hl.dsp.global("kiwi-shell:apps-next"))
hl.bind("ALT + TAB", hl.dsp.submap("app_switcher"))

-- Capture the release of the Left Alt key.
-- IMPORTANT: these two must live OUTSIDE the submap. Hyprland matches a bind
-- against the submap that was active when the key was *pressed* — and Alt goes
-- down before the submap is entered, so release binds inside the submap never
-- fire for it. Firing on every ordinary Alt release is fine: kiwi-shell
-- ignores the confirm while the switcher is closed, and the reset is a no-op.
hl.bind("ALT + ALT_L", hl.dsp.global("kiwi-shell:apps-confirm"), { release = true, transparent = true })
hl.bind("ALT + ALT_L", hl.dsp.submap("reset"), { release = true, transparent = true })

hl.define_submap("app_switcher", function()
    -- Allow repeating TAB while holding ALT to cycle the menu
    hl.bind("ALT + TAB", hl.dsp.global("kiwi-shell:apps-next"), { repeating = true })

    -- Provide a failsafe to abort if you change your mind
    hl.bind("escape", hl.dsp.global("kiwi-shell:apps-close"), { release = true })
    hl.bind("escape", hl.dsp.submap("reset"), { release = true })

    hl.bind("ALT + escape", hl.dsp.global("kiwi-shell:apps-close"), { release = true })
    hl.bind("ALT + escape", hl.dsp.submap("reset"), { release = true })
end)
```
If you use NixOS and configure Hyprland through home-manager's
`wayland.windowManager.hyprland` with `configType = "lua"`, these calls can go
into the `extraConfig` string.

To open the menu, press `Alt`+`Tab` and hold on to `Alt`. Press `Tab` again while holding `Alt` to cycle trough the applications.
