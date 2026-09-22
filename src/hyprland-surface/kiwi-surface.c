#include "kiwi-surface.h"

#include <math.h>
#include <string.h>
#include <gdk/wayland/gdkwayland.h>

#include "hyprland-surface-v1-protocol.h"

/* =========================================================================
 * Hyprland's surface manager, bound once on GTK's own Wayland connection
 * ========================================================================= */

static struct hyprland_surface_manager_v1 *manager;
static gboolean                            looked_up;

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface, uint32_t version)
{
    (void)data;
    /* the visible region came with version 2 */
    if (strcmp(interface, hyprland_surface_manager_v1_interface.name) == 0 && version >= 2)
        manager = wl_registry_bind(registry, name, &hyprland_surface_manager_v1_interface, 2);
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }

static const struct wl_registry_listener registry_listener = {
    .global        = registry_global,
    .global_remove = registry_global_remove,
};

static struct hyprland_surface_manager_v1 *get_manager(GdkDisplay *display)
{
    if (!looked_up) {
        looked_up = TRUE;
        struct wl_display  *wl_display = gdk_wayland_display_get_wl_display(display);
        struct wl_registry *registry   = wl_display_get_registry(wl_display);
        wl_registry_add_listener(registry, &registry_listener, NULL);
        wl_display_roundtrip(wl_display);
        wl_registry_destroy(registry);
    }
    return manager;
}

/* =========================================================================
 * One hyprland_surface per wl_surface, kept on the GdkSurface
 * ========================================================================= */

#define HYPRLAND_SURFACE_KEY "kiwi-hyprland-surface"

typedef struct {
    struct hyprland_surface_v1 *object;
    struct wl_surface          *wl_surface; /* the one it was made for */
} HyprlandSurface;

static void hyprland_surface_free(gpointer data)
{
    HyprlandSurface *hs = data;
    hyprland_surface_v1_destroy(hs->object);
    g_free(hs);
}

static struct hyprland_surface_v1 *hyprland_surface_for(GdkSurface *surface,
                                                        struct wl_surface *wl_surface)
{
    HyprlandSurface *hs = g_object_get_data(G_OBJECT(surface), HYPRLAND_SURFACE_KEY);
    if (hs && hs->wl_surface == wl_surface)
        return hs->object;

    hs             = g_new0(HyprlandSurface, 1);
    hs->wl_surface = wl_surface;
    hs->object     = hyprland_surface_manager_v1_get_hyprland_surface(manager, wl_surface);
    /* replaces (and destroys) one made for an earlier wl_surface */
    g_object_set_data_full(G_OBJECT(surface), HYPRLAND_SURFACE_KEY, hs, hyprland_surface_free);
    return hs->object;
}

/* =========================================================================
 * Public API
 * ========================================================================= */

gboolean kiwi_surface_set_visible_region(GdkSurface *surface, const cairo_region_t *region)
{
    g_return_val_if_fail(GDK_IS_SURFACE(surface), FALSE);

    if (!GDK_IS_WAYLAND_SURFACE(surface) || gdk_surface_is_destroyed(surface))
        return FALSE;

    GdkDisplay *display = gdk_surface_get_display(surface);
    if (!get_manager(display))
        return FALSE;

    struct wl_surface *wl_surface = gdk_wayland_surface_get_wl_surface(surface);
    if (!wl_surface)
        return FALSE;

    struct hyprland_surface_v1 *hs = hyprland_surface_for(surface, wl_surface);

    struct wl_region *wl_region = NULL;
    if (region) {
        wl_region = wl_compositor_create_region(gdk_wayland_display_get_wl_compositor(display));
        int n = cairo_region_num_rectangles(region);
        if (n == 0) {
            /* nothing visible: a region wholly outside the buffer, which
             * lets Hyprland skip the surface (an empty one means no hint) */
            wl_region_add(wl_region, -1, -1, 1, 1);
        } else {
            /* the protocol counts in buffer pixels; round outwards, so a
             * fractional scale can't shave a pixel off the content */
            double scale = gdk_surface_get_scale(surface);
            for (int i = 0; i < n; i++) {
                cairo_rectangle_int_t r;
                cairo_region_get_rectangle(region, i, &r);
                int x0 = (int)floor(r.x * scale), y0 = (int)floor(r.y * scale);
                int x1 = (int)ceil((r.x + r.width) * scale), y1 = (int)ceil((r.y + r.height) * scale);
                wl_region_add(wl_region, x0, y0, x1 - x0, y1 - y0);
            }
        }
    }

    hyprland_surface_v1_set_visible_region(hs, wl_region);
    if (wl_region)
        wl_region_destroy(wl_region);

    /* the region is double-buffered: it applies with the next commit */
    gdk_surface_queue_render(surface);
    return TRUE;
}
