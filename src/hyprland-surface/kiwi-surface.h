#pragma once

#include <gdk/gdk.h>
#include <cairo.h>

G_BEGIN_DECLS

/**
 * kiwi_surface_set_visible_region:
 * @surface: a #GdkSurface on Hyprland
 * @region: (nullable): the part of @surface with visible content, in the
 *   surface's own coordinates. %NULL for all of it, an empty region for none.
 *
 * Tells Hyprland which part of @surface it has to draw, and for a blurred
 * layer, which part it has to blur (hyprland_surface_v1.set_visible_region).
 * Hyprland otherwise blurs a layer across its whole rectangle wherever the
 * screen changes, transparent parts included. With none of it visible,
 * Hyprland skips the surface altogether. Takes effect with the surface's
 * next frame, which is requested here.
 *
 * Returns: %TRUE if Hyprland took the hint, %FALSE if it can't: another
 *   compositor, or a Hyprland without the protocol's second version.
 */
gboolean kiwi_surface_set_visible_region (GdkSurface           *surface,
                                          const cairo_region_t *region);

G_END_DECLS
