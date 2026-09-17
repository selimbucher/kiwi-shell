#pragma once
#include <glib-object.h>

G_BEGIN_DECLS

#define APP_TYPE_CAPTURE (app_capture_get_type())
G_DECLARE_FINAL_TYPE(AppCapture, app_capture, APP, CAPTURE, GObject)

/**
 * app_capture_new:
 *
 * Returns: (transfer full): a new #AppCapture.
 * Binds hyprland_toplevel_export_manager_v1, zwlr_foreign_toplevel_manager_v1,
 * and hyprland_toplevel_mapping_manager_v1, then does three roundtrips to
 * enumerate all live windows and map their addresses.
 */
AppCapture *app_capture_new(void);

/**
 * app_capture_set_min_size:
 * @self: an #AppCapture
 * @width: minimum frame width in pixels, 0 for any
 * @height: minimum frame height in pixels, 0 for any
 *
 * Later frames are downscaled by the largest whole factor that keeps them at
 * least @width x @height. Both 0 (the default) keeps them at full size.
 */
void app_capture_set_min_size(AppCapture *self, gint width, gint height);

/**
 * app_capture_capture_by_handle:
 * @self: an #AppCapture
 * @address: (transfer none): the Hyprland window address as a string.
 *   Accepts both "0x564f60266bd0" and "564f60266bd0" (with or without 0x).
 *
 * Captures one frame of the window. Every call eventually emits exactly one of:
 *   - #AppCapture::frame-ready  (GBytes, gint, gint, gint) on success
 *   - #AppCapture::frame-failed (gchararray reason) on failure
 *
 * If the wlr handle for @address has not yet been announced/mapped (race
 * between Hyprland IPC and the wlr foreign-toplevel protocol), the request
 * is queued internally for up to ~1.5 s waiting for the mapping to arrive.
 *
 * Frames arrive as premultiplied BGRA (stride = width * 4), downscaled per
 * app_capture_set_min_size().
 *
 * Failure reasons emitted via frame-failed:
 *   "no_export_manager"  — wayland init never bound the export protocol
 *   "no_handle_timeout"  — wlr handle never appeared for this address
 *   "frame_failed"       — compositor refused the export (unmapped, hidden, …)
 *   "timeout"            — the compositor never answered (~2 s)
 *   "buffer_invalid"     — buffer event reported invalid dimensions
 *   "unsupported_format" — the buffer format isn't one we can convert
 *   "shifted"            — Hyprland rendered the window offset (see app-capture.c)
 *   "alloc_failed"       — memfd_create / ftruncate / mmap failed
 *   "internal"           — defensive fallback (should never fire)
 */
void app_capture_capture_by_handle(AppCapture *self, const gchar *address);

G_END_DECLS
