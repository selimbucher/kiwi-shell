#include "kiwi-shortcuts.h"
#include "hyprland-global-shortcuts-v1-protocol.h"
#include <wayland-client.h>
#include <string.h>
#include <errno.h>

/* Per-shortcut context passed as the Wayland listener data pointer */
typedef struct {
    KiwiShortcutsManager              *manager;
    struct hyprland_global_shortcut_v1 *shortcut;
    char                               *id;
} ShortcutEntry;

struct _KiwiShortcutsManager {
    GObject parent_instance;

    struct wl_display                              *display;
    struct wl_registry                             *registry;
    struct hyprland_global_shortcuts_manager_v1    *shortcuts_manager;
    GList                                          *entries; /* ShortcutEntry* */
};

G_DEFINE_TYPE(KiwiShortcutsManager, kiwi_shortcuts_manager, G_TYPE_OBJECT)

enum { SIGNAL_ACTIVATED, N_SIGNALS };
static guint signals[N_SIGNALS];

/* ── Wayland registry callbacks ───────────────────────────────────────── */

static void
registry_global (void *data, struct wl_registry *registry,
                 uint32_t name, const char *interface, uint32_t version)
{
    KiwiShortcutsManager *self = data;
    if (strcmp(interface, hyprland_global_shortcuts_manager_v1_interface.name) == 0) {
        self->shortcuts_manager = wl_registry_bind(
            registry, name,
            &hyprland_global_shortcuts_manager_v1_interface, 1
        );
    }
}

static void
registry_global_remove (void *data, struct wl_registry *registry, uint32_t name) {}

static const struct wl_registry_listener registry_listener = {
    .global        = registry_global,
    .global_remove = registry_global_remove,
};

/* ── Shortcut event callbacks ─────────────────────────────────────────── */

static void
shortcut_pressed (void *data, struct hyprland_global_shortcut_v1 *shortcut,
                  uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec)
{
    ShortcutEntry *entry = data;
    g_signal_emit(entry->manager, signals[SIGNAL_ACTIVATED], 0, entry->id);
}

static void
shortcut_released (void *data, struct hyprland_global_shortcut_v1 *shortcut,
                   uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec) {}

static const struct hyprland_global_shortcut_v1_listener shortcut_listener = {
    .pressed  = shortcut_pressed,
    .released = shortcut_released,
};

/* ── GLib main loop integration ───────────────────────────────────────── */

static gboolean
on_wayland_data (GIOChannel *channel, GIOCondition condition, gpointer data)
{
    struct wl_display *display = data;
    /* A protocol error (e.g. another client already holds a kiwi-shell:*
       shortcut) kills the connection; without this check that death is
       silent and shortcuts just stop arriving */
    if ((condition & (G_IO_ERR | G_IO_HUP)) || wl_display_dispatch(display) < 0) {
        int err = wl_display_get_error(display);
        if (err == EPROTO) {
            const struct wl_interface *iface = NULL;
            uint32_t code = wl_display_get_protocol_error(display, &iface, NULL);
            g_warning("[kiwi-shortcuts] wayland protocol error %u on %s — "
                      "shortcuts dead (another client holding kiwi-shell shortcuts?)",
                      code, iface ? iface->name : "unknown interface");
        } else {
            g_warning("[kiwi-shortcuts] wayland connection lost (%s) — shortcuts dead",
                      err ? g_strerror(err) : "hangup");
        }
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

/* ── GObject lifecycle ────────────────────────────────────────────────── */

static void
kiwi_shortcuts_manager_init (KiwiShortcutsManager *self)
{
    self->display = wl_display_connect(NULL);
    if (!self->display) {
        g_warning("[kiwi-shortcuts] wl_display_connect failed");
        return;
    }

    self->registry = wl_display_get_registry(self->display);
    wl_registry_add_listener(self->registry, &registry_listener, self);
    /* Synchronous roundtrip: blocks until all current globals are announced */
    wl_display_roundtrip(self->display);

    if (!self->shortcuts_manager) {
        g_warning("[kiwi-shortcuts] hyprland_global_shortcuts_manager_v1 not available — "
                  "is the compositor Hyprland?");
        wl_display_disconnect(self->display);
        self->display = NULL;
        return;
    }

    /* Integrate the Wayland fd with the GLib main loop so pressed events
       are dispatched automatically without polling */
    int        fd      = wl_display_get_fd(self->display);
    GIOChannel *channel = g_io_channel_unix_new(fd);
    g_io_add_watch(channel, G_IO_IN | G_IO_ERR | G_IO_HUP, on_wayland_data, self->display);
    g_io_channel_unref(channel);

    g_message("[kiwi-shortcuts] global shortcuts manager bound");
}

static void
kiwi_shortcuts_manager_finalize (GObject *object)
{
    KiwiShortcutsManager *self = KIWI_SHORTCUTS_MANAGER(object);

    for (GList *l = self->entries; l; l = l->next) {
        ShortcutEntry *entry = l->data;
        hyprland_global_shortcut_v1_destroy(entry->shortcut);
        g_free(entry->id);
        g_free(entry);
    }
    g_list_free(self->entries);

    if (self->shortcuts_manager)
        hyprland_global_shortcuts_manager_v1_destroy(self->shortcuts_manager);
    if (self->registry)
        wl_registry_destroy(self->registry);
    if (self->display)
        wl_display_disconnect(self->display);

    G_OBJECT_CLASS(kiwi_shortcuts_manager_parent_class)->finalize(object);
}

static void
kiwi_shortcuts_manager_class_init (KiwiShortcutsManagerClass *klass)
{
    GObjectClass *object_class = G_OBJECT_CLASS(klass);
    object_class->finalize = kiwi_shortcuts_manager_finalize;

    /**
     * KiwiShortcutsManager::activated:
     * @id: the shortcut id passed to kiwi_shortcuts_manager_register()
     *
     * Emitted when a registered shortcut key is pressed.
     */
    signals[SIGNAL_ACTIVATED] = g_signal_new(
        "activated",
        G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_FIRST,
        0, NULL, NULL,
        g_cclosure_marshal_VOID__STRING,
        G_TYPE_NONE, 1,
        G_TYPE_STRING
    );
}

/* ── Public API ───────────────────────────────────────────────────────── */

KiwiShortcutsManager *
kiwi_shortcuts_manager_new (void)
{
    return g_object_new(KIWI_TYPE_SHORTCUTS_MANAGER, NULL);
}

/**
 * kiwi_shortcuts_manager_register:
 * @id: shortcut identifier, must match the part after "kiwi-shell:" in hypr.conf
 * @description: human-readable description shown in Hyprland shortcut UIs
 *
 * Registers a global shortcut. Call this for each key you want to monitor,
 * then add a matching bind in hypr.conf:
 *   bind = , XF86AudioRaiseVolume, global, kiwi-shell:volume-up
 */
void
kiwi_shortcuts_manager_register (KiwiShortcutsManager *self,
                                   const char            *id,
                                   const char            *description)
{
    g_return_if_fail(KIWI_IS_SHORTCUTS_MANAGER(self));
    if (!self->shortcuts_manager) return;

    struct hyprland_global_shortcut_v1 *shortcut =
        hyprland_global_shortcuts_manager_v1_register_shortcut(
            self->shortcuts_manager, id, "kiwi-shell", description, ""
        );

    ShortcutEntry *entry = g_new(ShortcutEntry, 1);
    entry->manager  = self;
    entry->shortcut = shortcut;
    entry->id       = g_strdup(id);

    hyprland_global_shortcut_v1_add_listener(shortcut, &shortcut_listener, entry);
    self->entries = g_list_append(self->entries, entry);

    /* Flush so the compositor receives the registration immediately */
    wl_display_flush(self->display);
}
