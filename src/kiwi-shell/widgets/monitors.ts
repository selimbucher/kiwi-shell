import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import { Accessor, createBinding, createComputed } from "ags"
import Hyprland from "gi://AstalHyprland"
import { conf } from "./config"

const hyprland = Hyprland.get_default()

// The monitor that popups — switchers, launcher, OSD, notifications,
// prompts — appear on. macOS-inspired: the currently active monitor by
// default, pinned to the main (first) monitor via popup_monitor="primary".
// Undefined only while no monitor exists; callers fall back to their
// mount monitor.
export const popupGdkMonitor: Accessor<Gdk.Monitor | undefined> = createComputed(get => {
    const monitors = get(createBinding(app, "monitors"))
    const primary = monitors[0]
    if (get(conf).popup_monitor === "primary") return primary
    const focused = get(createBinding(hyprland, "focusedMonitor"))
    return monitors.find(m => m.get_connector() === focused?.name) ?? primary
})

// Tear down a shell window when its monitor goes away. GTK 4.22's Wayland
// session-management hook (gtk_application_impl_wayland_window_forget)
// hands the window's GdkSurface to gdk_wayland_toplevel_remove_from_session
// without a NULL check, so destroying a window that was never presented —
// the notification center, its backdrop, the dock's edge sensor — segfaults
// the whole shell on every monitor hotplug. Realizing first gives the window
// a surface to forget. Gtk.Native shadows Gtk.Widget's realize() on window
// objects, so call the widget one explicitly. Fixed upstream in GTK 4.23.0
// (#8098); keep this until 4.22 is history.
export function destroyWindow(win: Gtk.Window) {
    if (!win.get_realized()) Gtk.Widget.prototype.realize.call(win)
    win.destroy()
}
