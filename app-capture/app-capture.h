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
 * app_capture_capture_by_handle:
 * @self: an #AppCapture
 * @address: (transfer none): the Hyprland window address as a string.
 *   Accepts both "0x564f60266bd0" and "564f60266bd0" (with or without 0x).
 *
 * Captures one frame of the window.  The #AppCapture::frame-ready signal
 * fires asynchronously with (GBytes *bytes, gint width, gint height, gint stride).
 */
void app_capture_capture_by_handle(AppCapture *self, const gchar *address);

G_END_DECLS
