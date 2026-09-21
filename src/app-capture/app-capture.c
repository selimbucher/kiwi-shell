#define _GNU_SOURCE
#include "app-capture.h"

#include <wayland-client.h>
#include <gtk/gtk.h>
#include <gdk/wayland/gdkwayland.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <math.h>
#include <gbm.h>
#include <xf86drm.h>
#include <drm_fourcc.h>

#include "hyprland-toplevel-export-v1.h"
#include "wlr-foreign-toplevel-management-unstable-v1.h"
#include "hyprland-toplevel-mapping-v1.h"
#include "linux-dmabuf-v1.h"

/* =========================================================================
 * Signals
 * ========================================================================= */

enum {
    SIGNAL_FRAME_READY,
    SIGNAL_FRAME_FAILED,
    LAST_SIGNAL
};

static guint signals[LAST_SIGNAL] = { 0 };

/* How long capture_by_handle() will wait for an unknown address's wlr handle
 * to arrive before giving up and emitting frame-failed. */
#define PENDING_CAPTURE_TIMEOUT_MS 1500

/* GPU copies that may fail in a row, each rescued by shared memory, before
 * GPU buffers are given up: one can fail for a passing reason, like the
 * window being resized between the offer and the copy. */
#define GPU_FAILURES_TO_GIVE_UP 3

/* How long a capture may wait for the compositor. Hyprland copies on the
 * window's monitor's next frame, so this only runs out when that monitor
 * doesn't render (powered off) or the frame was never created. */
#define FRAME_TIMEOUT_MS 2000

/* =========================================================================
 * Toplevel entry — one per live wlr toplevel
 * =========================================================================
 * We build a table of these at init time by:
 *   1. Binding zwlr_foreign_toplevel_manager_v1 and receiving toplevel events
 *   2. For each handle, requesting a hyprland_toplevel_mapping to get the
 *      full 64-bit Hyprland address (split as hi + lo uint32s)
 * This lets capture_by_handle() look up the wlr object for any address.
 * ========================================================================= */

typedef struct {
    struct zwlr_foreign_toplevel_handle_v1 *wlr_handle;
    char address[32];   /* hex string, e.g. "564f60266bd0", no "0x" prefix */
    gboolean mapped;    /* false until window_address event arrives */
} ToplevelEntry;

/* =========================================================================
 * Pending capture — capture_by_handle() called before mapping arrived
 * ========================================================================= */

typedef struct {
    AppCapture *self;       /* unowned; pending queue is owned by self */
    char       *address;    /* owned, stripped of "0x" */
    guint       timeout_id; /* 0 once consumed */
} PendingCapture;

/* =========================================================================
 * Object struct
 * ========================================================================= */

/* a DRM format with one of its buffer layouts */
typedef struct {
    uint32_t fourcc;
    uint64_t modifier;
} DmabufPair;

struct _AppCapture {
    GObject parent_instance;

    /* Wayland globals */
    struct wl_display                          *display;
    struct wl_registry                         *registry;
    struct wl_shm                              *shm;
    struct hyprland_toplevel_export_manager_v1 *export_manager;
    struct zwlr_foreign_toplevel_manager_v1    *wlr_manager;
    struct hyprland_toplevel_mapping_manager_v1 *mapping_manager;
    struct zwp_linux_dmabuf_v1                 *dmabuf;
    struct zwp_linux_dmabuf_feedback_v1        *feedback;

    /* Address → wlr_handle table */
    GPtrArray *toplevels;        /* element-type: ToplevelEntry* */

    /* Captures waiting on a not-yet-mapped address */
    GPtrArray *pending_captures; /* element-type: PendingCapture* */

    /* Frames are downscaled to no less than this; 0 leaves a dimension free */
    gint min_width;
    gint min_height;

    /* GPU buffers (see "GPU buffers" below). The feedback is read into the
     * table and tranche fields, then settled into gpu_pairs on done. */
    const uint8_t *format_table;
    size_t         format_table_size;
    GArray        *tranche_pairs;  /* element-type: DmabufPair, tranche being read */
    gboolean       tranche_scanout;
    GArray        *feedback_pairs; /* element-type: DmabufPair, feedback being read */
    GArray        *gpu_pairs;      /* element-type: DmabufPair, what Hyprland renders into */
    dev_t          main_device;
    int            drm_fd;
    struct gbm_device *gbm;
    GskRenderer   *renderer;
    /* GPU copies that failed in a row where shared memory then worked */
    guint          gpu_failures;
    /* too many of those, or an import Hyprland refused: shared memory only */
    gboolean       gpu_broken;
};

/* =========================================================================
 * Frame — one capture in flight
 *
 * Each capture owns its buffer, so a frame that answers late can't clobber
 * the next one.
 * ========================================================================= */

typedef struct {
    AppCapture *self;
    struct hyprland_toplevel_export_frame_v1 *frame;
    struct zwlr_foreign_toplevel_handle_v1   *wlr_handle;
    guint          timeout_id;
    uint32_t       format;
    uint32_t       width;
    uint32_t       height;
    uint32_t       stride;
    int            shm_fd;
    unsigned char *pixels;
    size_t         size;
    /* the GPU buffer, when Hyprland copies into one */
    uint32_t       dmabuf_format;  /* 0: Hyprland offered none */
    struct gbm_bo *bo;
    struct zwp_linux_buffer_params_v1 *params;
    struct wl_buffer *buffer;
    gboolean       on_gpu;
    /* only shared memory for this one: it retries a failed GPU copy */
    gboolean       shm_only;
} Frame;

G_DEFINE_TYPE(AppCapture, app_capture, G_TYPE_OBJECT)

/* =========================================================================
 * Forward declarations
 * ========================================================================= */

static void     request_mapping(AppCapture *self, ToplevelEntry *entry);
static void     emit_frame_failed(AppCapture *self, const char *reason);
static void     do_capture(AppCapture *self,
                           struct zwlr_foreign_toplevel_handle_v1 *wlr_handle,
                           gboolean shm_only);
static struct zwlr_foreign_toplevel_handle_v1 *find_wlr_handle(AppCapture *self,
                                                               const char *addr);
static void     flush_pending_for_address(AppCapture *self, const char *address);
static gboolean pending_capture_timeout_cb(gpointer data);
static void     pending_capture_free(gpointer data);

/* =========================================================================
 * Hyprland toplevel mapping listener
 * Fires once per ToplevelEntry with the full 64-bit address.
 * ========================================================================= */

typedef struct {
    AppCapture    *self;
    ToplevelEntry *entry;
} MappingContext;

static void mapping_handle_window_address(void *data,
    struct hyprland_toplevel_window_mapping_handle_v1 *handle,
    uint32_t address_hi, uint32_t address)
{
    MappingContext *ctx = data;
    ToplevelEntry  *entry = ctx->entry;
    AppCapture     *self  = ctx->self;

    uint64_t full = ((uint64_t)address_hi << 32) | (uint64_t)address;
    snprintf(entry->address, sizeof(entry->address), "%" PRIx64, full);
    entry->mapped = TRUE;

    /* Dispatch any capture that was waiting for this address */
    flush_pending_for_address(self, entry->address);

    hyprland_toplevel_window_mapping_handle_v1_destroy(handle);
    g_free(ctx);
}

static void mapping_handle_failed(void *data,
    struct hyprland_toplevel_window_mapping_handle_v1 *handle)
{
    MappingContext *ctx = data;
    /* Address stays empty — this entry won't be matchable, which is fine.
     * Any pending capture for that address will time out via its own timer. */
    hyprland_toplevel_window_mapping_handle_v1_destroy(handle);
    g_free(ctx);
}

static const struct hyprland_toplevel_window_mapping_handle_v1_listener mapping_listener = {
    .window_address = mapping_handle_window_address,
    .failed         = mapping_handle_failed,
};

/* =========================================================================
 * wlr foreign toplevel listeners
 * We only need enough to know when a window appears or disappears.
 * ========================================================================= */

static void wlr_handle_title(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle, const char *title)
{ (void)data; (void)handle; (void)title; }

static void wlr_handle_app_id(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle, const char *app_id)
{ (void)data; (void)handle; (void)app_id; }

static void wlr_handle_output_enter(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_output *output)
{ (void)data; (void)handle; (void)output; }

static void wlr_handle_output_leave(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_output *output)
{ (void)data; (void)handle; (void)output; }

static void wlr_handle_state(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle, struct wl_array *state)
{ (void)data; (void)handle; (void)state; }

static void wlr_handle_done(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle)
{ (void)data; (void)handle; }

static void wlr_handle_closed(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    ToplevelEntry *entry = data;
    /* Mark as unmapped so capture_by_handle skips it */
    entry->mapped = FALSE;
    zwlr_foreign_toplevel_handle_v1_destroy(handle);
    entry->wlr_handle = NULL;
}

static void wlr_handle_parent(void *data,
    struct zwlr_foreign_toplevel_handle_v1 *handle,
    struct zwlr_foreign_toplevel_handle_v1 *parent)
{ (void)data; (void)handle; (void)parent; }

static const struct zwlr_foreign_toplevel_handle_v1_listener wlr_handle_listener = {
    .title        = wlr_handle_title,
    .app_id       = wlr_handle_app_id,
    .output_enter = wlr_handle_output_enter,
    .output_leave = wlr_handle_output_leave,
    .state        = wlr_handle_state,
    .done         = wlr_handle_done,
    .closed       = wlr_handle_closed,
    .parent       = wlr_handle_parent,
};

/* =========================================================================
 * wlr foreign toplevel manager listener
 * ========================================================================= */

static void wlr_manager_handle_toplevel(void *data,
    struct zwlr_foreign_toplevel_manager_v1 *manager,
    struct zwlr_foreign_toplevel_handle_v1 *handle)
{
    (void)manager;
    AppCapture    *self  = APP_CAPTURE(data);
    ToplevelEntry *entry = g_new0(ToplevelEntry, 1);
    entry->wlr_handle = handle;
    entry->mapped     = FALSE;

    zwlr_foreign_toplevel_handle_v1_add_listener(handle,
        &wlr_handle_listener, entry);

    g_ptr_array_add(self->toplevels, entry);

    /* Immediately request the Hyprland address mapping for this handle */
    if (self->mapping_manager)
        request_mapping(self, entry);
}

static void wlr_manager_handle_finished(void *data,
    struct zwlr_foreign_toplevel_manager_v1 *manager)
{ (void)data; (void)manager; }

static const struct zwlr_foreign_toplevel_manager_v1_listener wlr_manager_listener = {
    .toplevel = wlr_manager_handle_toplevel,
    .finished = wlr_manager_handle_finished,
};

/* =========================================================================
 * Mapping helper — ask Hyprland for the address of a wlr handle
 * ========================================================================= */

static void request_mapping(AppCapture *self, ToplevelEntry *entry)
{
    MappingContext *ctx = g_new0(MappingContext, 1);
    ctx->self  = self;
    ctx->entry = entry;

    struct hyprland_toplevel_window_mapping_handle_v1 *mh =
        hyprland_toplevel_mapping_manager_v1_get_window_for_toplevel_wlr(
            self->mapping_manager, entry->wlr_handle);

    hyprland_toplevel_window_mapping_handle_v1_add_listener(mh,
        &mapping_listener, ctx);
}

/* =========================================================================
 * GPU buffers
 *
 * A copy into shared memory makes Hyprland render the window into a texture
 * of its own and read that back to the CPU, on its render thread, where it
 * holds up the compositor (~8 ms for a 1400x850 window); here the frame was
 * then averaged down pixel by pixel and uploaded to the GPU again. Given a
 * GPU buffer (a dmabuf), Hyprland renders the window straight into it and
 * says when the GPU is done: no readback anywhere. GTK takes the buffer as a
 * texture without a copy, draws it scaled down to the preview size on the
 * GPU, and the full frame is let go at once, so the cache only ever holds
 * previews.
 *
 * The buffer must be one Hyprland can render into and GTK can read:
 *   - allocated with GBM on the GPU Hyprland names as its main device in its
 *     dmabuf feedback,
 *   - in a format and layout (modifier) from the feedback's renderer tranches
 *     (the scanout ones are for displays). Hyprland treats any other pair as
 *     a protocol error, which would end the whole connection,
 *   - and one GTK reports it can import.
 * The buffer is handed over with create, not create_immed: a buffer Hyprland
 * can't import is then a failed event instead of a dead wl_buffer.
 *
 * Shared memory stays for everything else: no GPU, no pair in common, a
 * failed import, and a copy Hyprland couldn't render into. That last one is
 * retried in shared memory; when that keeps working where the GPU copy
 * doesn't, GPU buffers are given up (GPU_FAILURES_TO_GIVE_UP).
 * ========================================================================= */

/* a format table entry as the compositor lays it out */
typedef struct {
    uint32_t fourcc;
    uint32_t pad;
    uint64_t modifier;
} FormatTableEntry;

static void feedback_handle_done(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    g_array_set_size(self->gpu_pairs, 0);
    g_array_append_vals(self->gpu_pairs, self->feedback_pairs->data, self->feedback_pairs->len);
    g_array_set_size(self->feedback_pairs, 0);
}

static void feedback_handle_format_table(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback, int32_t fd, uint32_t size)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    if (self->format_table)
        munmap((void *)self->format_table, self->format_table_size);
    void *table = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    self->format_table      = table == MAP_FAILED ? NULL : table;
    self->format_table_size = table == MAP_FAILED ? 0 : size;
}

static void feedback_handle_main_device(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback, struct wl_array *device)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    if (device->size == sizeof(dev_t))
        memcpy(&self->main_device, device->data, sizeof(dev_t));
}

static void feedback_handle_tranche_done(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    if (!self->tranche_scanout)
        g_array_append_vals(self->feedback_pairs, self->tranche_pairs->data, self->tranche_pairs->len);
    g_array_set_size(self->tranche_pairs, 0);
    self->tranche_scanout = FALSE;
}

static void feedback_handle_tranche_target_device(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback, struct wl_array *device)
{ (void)data; (void)feedback; (void)device; }

static void feedback_handle_tranche_formats(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback, struct wl_array *indices)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    if (!self->format_table)
        return;
    size_t entries = self->format_table_size / sizeof(FormatTableEntry);
    const FormatTableEntry *table = (const FormatTableEntry *)self->format_table;
    uint16_t *index;
    wl_array_for_each(index, indices) {
        if (*index >= entries)
            continue;
        DmabufPair pair = { .fourcc = table[*index].fourcc, .modifier = table[*index].modifier };
        g_array_append_val(self->tranche_pairs, pair);
    }
}

static void feedback_handle_tranche_flags(void *data,
    struct zwp_linux_dmabuf_feedback_v1 *feedback, uint32_t flags)
{
    (void)feedback;
    AppCapture *self = APP_CAPTURE(data);
    self->tranche_scanout = (flags & ZWP_LINUX_DMABUF_FEEDBACK_V1_TRANCHE_FLAGS_SCANOUT) != 0;
}

static const struct zwp_linux_dmabuf_feedback_v1_listener feedback_listener = {
    .done                  = feedback_handle_done,
    .format_table          = feedback_handle_format_table,
    .main_device           = feedback_handle_main_device,
    .tranche_done          = feedback_handle_tranche_done,
    .tranche_target_device = feedback_handle_tranche_target_device,
    .tranche_formats       = feedback_handle_tranche_formats,
    .tranche_flags         = feedback_handle_tranche_flags,
};

/* Opens Hyprland's GPU for allocating and a renderer for scaling. Without
 * either, every capture goes through shared memory. */
static void gpu_init(AppCapture *self)
{
    if (!self->dmabuf || self->gpu_pairs->len == 0 || self->main_device == 0)
        return;

    drmDevice *device = NULL;
    if (drmGetDeviceFromDevId(self->main_device, 0, &device) != 0) {
        g_warning("AppCapture: can't find Hyprland's GPU; using shared memory");
        return;
    }
    if (device->available_nodes & (1 << DRM_NODE_RENDER))
        self->drm_fd = open(device->nodes[DRM_NODE_RENDER], O_RDWR | O_CLOEXEC);
    drmFreeDevice(&device);
    if (self->drm_fd < 0) {
        g_warning("AppCapture: can't open Hyprland's GPU; using shared memory");
        return;
    }

    self->gbm = gbm_create_device(self->drm_fd);
    if (!self->gbm) {
        g_warning("AppCapture: GBM refused Hyprland's GPU; using shared memory");
        return;
    }

    GError *error = NULL;
    self->renderer = gsk_gl_renderer_new();
    if (!gsk_renderer_realize_for_display(self->renderer, gdk_display_get_default(), &error)) {
        g_warning("AppCapture: no GL renderer (%s); using shared memory", error->message);
        g_error_free(error);
        g_clear_object(&self->renderer);
    }
}

/* Asks Hyprland to copy into a GPU buffer. FALSE when this frame can't have
 * one; the copy then goes through shared memory. */
static gboolean frame_copy_to_gpu(Frame *f);

/* =========================================================================
 * Registry listener
 * ========================================================================= */

static void registry_handle_global(void *data, struct wl_registry *registry,
    uint32_t name, const char *interface, uint32_t version)
{
    AppCapture *self = APP_CAPTURE(data);

    if (g_strcmp0(interface,
            hyprland_toplevel_export_manager_v1_interface.name) == 0) {
        self->export_manager = wl_registry_bind(registry, name,
            &hyprland_toplevel_export_manager_v1_interface, 2);
    }
    else if (g_strcmp0(interface, wl_shm_interface.name) == 0) {
        self->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    }
    else if (g_strcmp0(interface,
            zwlr_foreign_toplevel_manager_v1_interface.name) == 0) {
        self->wlr_manager = wl_registry_bind(registry, name,
            &zwlr_foreign_toplevel_manager_v1_interface, 3);
        zwlr_foreign_toplevel_manager_v1_add_listener(self->wlr_manager,
            &wlr_manager_listener, self);
    }
    else if (g_strcmp0(interface,
            hyprland_toplevel_mapping_manager_v1_interface.name) == 0) {
        self->mapping_manager = wl_registry_bind(registry, name,
            &hyprland_toplevel_mapping_manager_v1_interface, 1);
    }
    /* version 4 brings the feedback: the GPU and the pairs to use */
    else if (g_strcmp0(interface, zwp_linux_dmabuf_v1_interface.name) == 0 && version >= 4) {
        self->dmabuf = wl_registry_bind(registry, name, &zwp_linux_dmabuf_v1_interface, 4);
        self->feedback = zwp_linux_dmabuf_v1_get_default_feedback(self->dmabuf);
        zwp_linux_dmabuf_feedback_v1_add_listener(self->feedback, &feedback_listener, self);
    }
}

static void registry_handle_global_remove(void *data,
    struct wl_registry *registry, uint32_t name)
{ (void)data; (void)registry; (void)name; }

static const struct wl_registry_listener registry_listener = {
    .global        = registry_handle_global,
    .global_remove = registry_handle_global_remove,
};

/* =========================================================================
 * Pixel conversion
 *
 * Captures come in the monitor's read format: 8-bit BGRA/RGBA normally, a
 * 10-bit one on 10-bit monitors with misc:screencopy_force_8b off. The
 * texture is always built from premultiplied BGRA, and a preview never needs
 * the full HiDPI frame (~20 MB for a large window), so blocks of
 * factor x factor pixels are averaged on the way.
 * ========================================================================= */

static gboolean format_supported(uint32_t format)
{
    switch (format) {
        case WL_SHM_FORMAT_ARGB8888:
        case WL_SHM_FORMAT_XRGB8888:
        case WL_SHM_FORMAT_ABGR8888:
        case WL_SHM_FORMAT_XBGR8888:
        case WL_SHM_FORMAT_ARGB2101010:
        case WL_SHM_FORMAT_XRGB2101010:
        case WL_SHM_FORMAT_ABGR2101010:
        case WL_SHM_FORMAT_XBGR2101010:
            return TRUE;
        default:
            return FALSE;
    }
}

/* one pixel as B, G, R, A */
static inline void read_bgra(const uint8_t *p, uint32_t format, uint8_t out[4])
{
    switch (format) {
        case WL_SHM_FORMAT_ARGB8888:
        case WL_SHM_FORMAT_XRGB8888:
            out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
            out[3] = format == WL_SHM_FORMAT_ARGB8888 ? p[3] : 255;
            return;
        case WL_SHM_FORMAT_ABGR8888:
        case WL_SHM_FORMAT_XBGR8888:
            out[0] = p[2]; out[1] = p[1]; out[2] = p[0];
            out[3] = format == WL_SHM_FORMAT_ABGR8888 ? p[3] : 255;
            return;
        default: {
            /* 2101010: channels at bits 0, 10, 20, alpha at 30 */
            uint32_t v = (uint32_t)p[0] | (uint32_t)p[1] << 8 |
                         (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
            uint8_t low  = (v >> 2)  & 0xff;
            uint8_t mid  = (v >> 12) & 0xff;
            uint8_t high = (v >> 22) & 0xff;
            gboolean rgb_order = format == WL_SHM_FORMAT_ARGB2101010 ||
                                 format == WL_SHM_FORMAT_XRGB2101010;
            out[0] = rgb_order ? low : high;
            out[1] = mid;
            out[2] = rgb_order ? high : low;
            out[3] = format == WL_SHM_FORMAT_ARGB2101010 ||
                     format == WL_SHM_FORMAT_ABGR2101010 ? (uint8_t)((v >> 30) * 85) : 255;
            return;
        }
    }
}

static GBytes *to_bgra(const uint8_t *src, uint32_t format,
                       uint32_t width, uint32_t height, uint32_t stride,
                       uint32_t factor, uint32_t *out_width, uint32_t *out_height)
{
    uint32_t w = width / factor, h = height / factor;
    uint32_t area = factor * factor;
    uint8_t *dst = g_malloc((size_t)w * h * 4);

    if (factor == 1 && format == WL_SHM_FORMAT_ARGB8888 && stride == width * 4) {
        memcpy(dst, src, (size_t)w * h * 4);
    } else {
        for (uint32_t y = 0; y < h; y++) {
            for (uint32_t x = 0; x < w; x++) {
                uint32_t sum[4] = { 0, 0, 0, 0 };
                for (uint32_t by = 0; by < factor; by++) {
                    const uint8_t *row = src + (size_t)stride * (y * factor + by);
                    for (uint32_t bx = 0; bx < factor; bx++) {
                        uint8_t px[4];
                        read_bgra(row + (size_t)(x * factor + bx) * 4, format, px);
                        sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; sum[3] += px[3];
                    }
                }
                uint8_t *out = dst + ((size_t)y * w + x) * 4;
                for (int c = 0; c < 4; c++)
                    out[c] = (uint8_t)((sum[c] + area / 2) / area);
            }
        }
    }

    *out_width  = w;
    *out_height = h;
    return g_bytes_new_take(dst, (size_t)w * h * 4);
}

/* =========================================================================
 * Shifted frames
 *
 * Hyprland (0.56, still on main) adds a floating window's workspace-slide
 * offset when it renders the window for export, and that offset is left
 * behind once the workspace has slid out of view. A window whose bounding
 * box (shadow included) crosses a monitor edge then comes back shifted: a
 * fully transparent strip along one edge, the opposite edge cut off. The
 * export clears to transparent first, so the strip is exactly alpha 0.
 * ========================================================================= */

static gboolean line_transparent(const uint8_t *src, uint32_t format, uint32_t stride,
                                 uint32_t x, uint32_t y, uint32_t dx, uint32_t dy, uint32_t length)
{
    for (uint32_t i = 0; i < length; i++, x += dx, y += dy) {
        uint8_t px[4];
        read_bgra(src + (size_t)stride * y + (size_t)x * 4, format, px);
        if (px[3] != 0)
            return FALSE;
    }
    return TRUE;
}

/* a transparent strip of at least 1% of the frame along any edge */
static gboolean frame_shifted(const uint8_t *src, uint32_t format,
                              uint32_t width, uint32_t height, uint32_t stride)
{
    uint32_t columns = MAX(width / 100, 1), rows = MAX(height / 100, 1);
    gboolean left = TRUE, right = TRUE, top = TRUE, bottom = TRUE;

    for (uint32_t i = 0; i < columns && (left || right); i++) {
        left  = left  && line_transparent(src, format, stride, i, 0, 0, 1, height);
        right = right && line_transparent(src, format, stride, width - 1 - i, 0, 0, 1, height);
    }
    for (uint32_t i = 0; i < rows && (top || bottom); i++) {
        top    = top    && line_transparent(src, format, stride, 0, i, 1, 0, width);
        bottom = bottom && line_transparent(src, format, stride, 0, height - 1 - i, 1, 0, width);
    }
    return left || right || top || bottom;
}

/* the largest whole factor that keeps the frame at least min_width x min_height */
static uint32_t downscale_factor(AppCapture *self, uint32_t width, uint32_t height)
{
    if (self->min_width <= 0 && self->min_height <= 0)
        return 1;
    uint32_t factor = UINT32_MAX;
    if (self->min_width > 0)
        factor = MIN(factor, width / (uint32_t)self->min_width);
    if (self->min_height > 0)
        factor = MIN(factor, height / (uint32_t)self->min_height);
    return MAX(factor, 1);
}

/* the size a frame is scaled to: at least min_width x min_height, never up */
static void preview_size(AppCapture *self, uint32_t width, uint32_t height,
                         uint32_t *out_width, uint32_t *out_height)
{
    double scale = 0;
    if (self->min_width > 0)
        scale = MAX(scale, (double)self->min_width / width);
    if (self->min_height > 0)
        scale = MAX(scale, (double)self->min_height / height);
    if (scale <= 0 || scale > 1)
        scale = 1;
    *out_width  = MAX(1, (uint32_t)ceil(width * scale));
    *out_height = MAX(1, (uint32_t)ceil(height * scale));
}

/* =========================================================================
 * Frame listener
 *
 * Event order: buffer → linux_dmabuf → buffer_done → [copy()] → flags → ready|failed
 *
 * A frame is freed before its signal is emitted: handlers may start the
 * next capture right away.
 * ========================================================================= */

static void frame_free(Frame *f, gboolean tell_compositor)
{
    if (f->timeout_id)
        g_source_remove(f->timeout_id);
    if (f->pixels)
        munmap(f->pixels, f->size);
    if (f->shm_fd >= 0)
        close(f->shm_fd);
    if (f->params)
        zwp_linux_buffer_params_v1_destroy(f->params);
    if (f->buffer)
        wl_buffer_destroy(f->buffer);
    if (f->bo)
        gbm_bo_destroy(f->bo);
    if (tell_compositor)
        hyprland_toplevel_export_frame_v1_destroy(f->frame);
    else
        /* no destroy request: Hyprland ignores a capture of a window that
         * closed a moment ago without creating the frame, and a request on
         * an object it doesn't know is a fatal protocol error. Dropping the
         * proxy locally also discards any late events. */
        wl_proxy_destroy((struct wl_proxy *)f->frame);
    g_free(f);
}

static void frame_fail(Frame *f, const char *reason)
{
    AppCapture *self = f->self;
    frame_free(f, TRUE);
    emit_frame_failed(self, reason);
}

static void emit_texture(AppCapture *self, GdkTexture *texture)
{
    g_signal_emit(self, signals[SIGNAL_FRAME_READY], 0, texture);
    g_object_unref(texture);
}

static gboolean frame_timeout_cb(gpointer data)
{
    Frame      *f    = data;
    AppCapture *self = f->self;

    g_warning("AppCapture: no frame from the compositor within %d ms", FRAME_TIMEOUT_MS);
    f->timeout_id = 0;
    frame_free(f, FALSE);
    emit_frame_failed(self, "timeout");
    return G_SOURCE_REMOVE;
}

static void frame_handle_buffer(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame,
    uint32_t format, uint32_t width, uint32_t height, uint32_t stride)
{
    (void)frame;
    Frame *f  = data;
    f->format = format;
    f->width  = width;
    f->height = height;
    f->stride = stride;
}

static void frame_handle_linux_dmabuf(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame,
    uint32_t format, uint32_t width, uint32_t height)
{
    (void)frame;
    Frame *f = data;
    /* the same size as the shared-memory buffer; anything else is odd enough
     * to leave alone */
    if (width == f->width && height == f->height)
        f->dmabuf_format = format;
}

static void frame_copy_to_shm(Frame *f)
{
    AppCapture *self = f->self;

    if (!format_supported(f->format)) {
        g_warning("AppCapture: unsupported buffer format 0x%08x", f->format);
        frame_fail(f, "unsupported_format");
        return;
    }

    f->size   = (size_t)f->stride * f->height;
    f->shm_fd = memfd_create("app-capture-buffer", MFD_CLOEXEC);
    if (f->shm_fd < 0 || ftruncate(f->shm_fd, (off_t)f->size) < 0) {
        g_warning("AppCapture: allocating the shm buffer failed");
        frame_fail(f, "alloc_failed");
        return;
    }

    f->pixels = mmap(NULL, f->size, PROT_READ | PROT_WRITE, MAP_SHARED, f->shm_fd, 0);
    if (f->pixels == MAP_FAILED) {
        g_warning("AppCapture: mmap failed");
        f->pixels = NULL;
        frame_fail(f, "alloc_failed");
        return;
    }

    struct wl_shm_pool *pool = wl_shm_create_pool(self->shm, f->shm_fd, (int32_t)f->size);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool,
        0, (int32_t)f->width, (int32_t)f->height, (int32_t)f->stride, f->format);
    wl_shm_pool_destroy(pool);

    hyprland_toplevel_export_frame_v1_copy(f->frame, buffer, 1);
    wl_buffer_destroy(buffer);
}

static void frame_handle_buffer_done(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame)
{
    (void)frame;
    Frame *f = data;

    if (f->width == 0 || f->height == 0 || f->stride < f->width * 4) {
        g_warning("AppCapture: buffer_done with invalid dimensions");
        frame_fail(f, "buffer_invalid");
        return;
    }

    if (!f->shm_only && frame_copy_to_gpu(f))
        return;
    frame_copy_to_shm(f);
}

static void params_handle_created(void *data,
    struct zwp_linux_buffer_params_v1 *params, struct wl_buffer *buffer)
{
    Frame *f = data;
    zwp_linux_buffer_params_v1_destroy(params);
    f->params = NULL;
    f->buffer = buffer;
    f->on_gpu = TRUE;
    hyprland_toplevel_export_frame_v1_copy(f->frame, buffer, 1);
    wl_display_flush(f->self->display);
}

static void params_handle_failed(void *data,
    struct zwp_linux_buffer_params_v1 *params)
{
    Frame *f = data;
    g_warning("AppCapture: Hyprland can't import our GPU buffers; using shared memory");
    f->self->gpu_broken = TRUE;
    zwp_linux_buffer_params_v1_destroy(params);
    f->params = NULL;
    gbm_bo_destroy(f->bo);
    f->bo = NULL;
    frame_copy_to_shm(f);
    wl_display_flush(f->self->display);
}

static const struct zwp_linux_buffer_params_v1_listener params_listener = {
    .created = params_handle_created,
    .failed  = params_handle_failed,
};

static gboolean frame_copy_to_gpu(Frame *f)
{
    AppCapture *self = f->self;
    if (!self->gbm || !self->renderer || self->gpu_broken || !f->dmabuf_format)
        return FALSE;

    /* the layouts Hyprland renders into and GTK reads, for this format */
    GdkDmabufFormats *readable = gdk_display_get_dmabuf_formats(gdk_display_get_default());
    GArray *modifiers = g_array_new(FALSE, FALSE, sizeof(uint64_t));
    for (guint i = 0; i < self->gpu_pairs->len; i++) {
        DmabufPair *pair = &g_array_index(self->gpu_pairs, DmabufPair, i);
        if (pair->fourcc == f->dmabuf_format &&
            gdk_dmabuf_formats_contains(readable, pair->fourcc, pair->modifier))
            g_array_append_val(modifiers, pair->modifier);
    }
    if (modifiers->len > 0)
        f->bo = gbm_bo_create_with_modifiers2(self->gbm, f->width, f->height, f->dmabuf_format,
            (const uint64_t *)modifiers->data, modifiers->len, GBM_BO_USE_RENDERING);
    g_array_unref(modifiers);
    if (!f->bo)
        return FALSE;

    uint64_t modifier = gbm_bo_get_modifier(f->bo);
    f->params = zwp_linux_dmabuf_v1_create_params(self->dmabuf);
    for (int plane = 0; plane < gbm_bo_get_plane_count(f->bo); plane++) {
        int fd = gbm_bo_get_fd_for_plane(f->bo, plane);
        /* the request takes its own copy of the fd */
        zwp_linux_buffer_params_v1_add(f->params, fd, (uint32_t)plane,
            gbm_bo_get_offset(f->bo, plane), gbm_bo_get_stride_for_plane(f->bo, plane),
            (uint32_t)(modifier >> 32), (uint32_t)(modifier & 0xffffffff));
        close(fd);
    }
    zwp_linux_buffer_params_v1_add_listener(f->params, &params_listener, f);
    zwp_linux_buffer_params_v1_create(f->params, (int32_t)f->width, (int32_t)f->height,
                                      f->dmabuf_format, 0);
    return TRUE;
}

static void frame_handle_flags(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame, uint32_t flags)
{ (void)data; (void)frame; (void)flags; }

/* what GTK needs to let go of a GPU buffer once its texture is gone */
typedef struct {
    struct gbm_bo *bo;
    int            fds[4];
    int            planes;
} GpuTextureData;

static void gpu_texture_release(gpointer data)
{
    GpuTextureData *d = data;
    for (int i = 0; i < d->planes; i++)
        close(d->fds[i]);
    gbm_bo_destroy(d->bo);
    g_free(d);
}

/* The GPU buffer as a texture (no copy), drawn at the preview size on the GPU.
 * The buffer is released as soon as that draw has been read back. */
static GdkTexture *gpu_preview(Frame *f)
{
    AppCapture *self = f->self;
    GpuTextureData *d = g_new0(GpuTextureData, 1);
    d->bo     = f->bo;
    d->planes = gbm_bo_get_plane_count(f->bo);
    f->bo     = NULL;

    GdkDmabufTextureBuilder *builder = gdk_dmabuf_texture_builder_new();
    gdk_dmabuf_texture_builder_set_display(builder, gdk_display_get_default());
    gdk_dmabuf_texture_builder_set_width(builder, f->width);
    gdk_dmabuf_texture_builder_set_height(builder, f->height);
    gdk_dmabuf_texture_builder_set_fourcc(builder, f->dmabuf_format);
    gdk_dmabuf_texture_builder_set_modifier(builder, gbm_bo_get_modifier(d->bo));
    gdk_dmabuf_texture_builder_set_premultiplied(builder, TRUE);
    gdk_dmabuf_texture_builder_set_n_planes(builder, (unsigned)d->planes);
    for (int plane = 0; plane < d->planes; plane++) {
        d->fds[plane] = gbm_bo_get_fd_for_plane(d->bo, plane);
        gdk_dmabuf_texture_builder_set_fd(builder, (unsigned)plane, d->fds[plane]);
        gdk_dmabuf_texture_builder_set_stride(builder, (unsigned)plane, gbm_bo_get_stride_for_plane(d->bo, plane));
        gdk_dmabuf_texture_builder_set_offset(builder, (unsigned)plane, gbm_bo_get_offset(d->bo, plane));
    }

    GError *error = NULL;
    GdkTexture *frame = gdk_dmabuf_texture_builder_build(builder, gpu_texture_release, d, &error);
    g_object_unref(builder);
    if (!frame) {
        g_warning("AppCapture: GTK can't read the GPU buffer (%s)", error->message);
        g_error_free(error);
        gpu_texture_release(d);
        return NULL;
    }

    uint32_t width, height;
    preview_size(self, f->width, f->height, &width, &height);
    graphene_rect_t bounds = GRAPHENE_RECT_INIT(0, 0, width, height);
    GskRenderNode *node = gsk_texture_scale_node_new(frame, &bounds, GSK_SCALING_FILTER_TRILINEAR);
    GdkTexture *preview = gsk_renderer_render_texture(self->renderer, node, &bounds);
    gsk_render_node_unref(node);
    g_object_unref(frame);
    return preview;
}

static gboolean texture_shifted(GdkTexture *texture)
{
    GdkTextureDownloader *downloader = gdk_texture_downloader_new(texture);
    gdk_texture_downloader_set_format(downloader, GDK_MEMORY_B8G8R8A8_PREMULTIPLIED);
    gsize stride;
    GBytes *bytes = gdk_texture_downloader_download_bytes(downloader, &stride);
    gdk_texture_downloader_free(downloader);
    gboolean shifted = frame_shifted(g_bytes_get_data(bytes, NULL), WL_SHM_FORMAT_ARGB8888,
        (uint32_t)gdk_texture_get_width(texture), (uint32_t)gdk_texture_get_height(texture),
        (uint32_t)stride);
    g_bytes_unref(bytes);
    return shifted;
}

static void frame_handle_ready(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame,
    uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec)
{
    (void)frame; (void)tv_sec_hi; (void)tv_sec_lo; (void)tv_nsec;
    Frame      *f    = data;
    AppCapture *self = f->self;

    if (f->on_gpu) {
        GdkTexture *preview = gpu_preview(f);
        if (!preview) {
            frame_fail(f, "internal");
            return;
        }
        if (texture_shifted(preview)) {
            g_debug("AppCapture: dropping a shifted frame");
            g_object_unref(preview);
            frame_fail(f, "shifted");
            return;
        }
        self->gpu_failures = 0;
        frame_free(f, TRUE);
        emit_texture(self, preview);
        return;
    }

    if (!f->pixels) {
        g_warning("AppCapture: ready fired without a buffer");
        frame_fail(f, "internal");
        return;
    }

    if (frame_shifted(f->pixels, f->format, f->width, f->height, f->stride)) {
        g_debug("AppCapture: dropping a shifted frame");
        frame_fail(f, "shifted");
        return;
    }

    /* a GPU copy of this window failed where this one worked */
    if (f->shm_only && !self->gpu_broken && ++self->gpu_failures >= GPU_FAILURES_TO_GIVE_UP) {
        g_warning("AppCapture: Hyprland can't render into our GPU buffers; using shared memory");
        self->gpu_broken = TRUE;
    }

    uint32_t width, height;
    GBytes *bytes = to_bgra(f->pixels, f->format, f->width, f->height, f->stride,
                            downscale_factor(self, f->width, f->height), &width, &height);
    frame_free(f, TRUE);

    GdkTexture *texture = gdk_memory_texture_new((int)width, (int)height,
        GDK_MEMORY_B8G8R8A8_PREMULTIPLIED, bytes, width * 4);
    g_bytes_unref(bytes);
    emit_texture(self, texture);
}

static void frame_handle_failed(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame)
{
    (void)frame;
    Frame *f = data;

    /* once more through shared memory, to tell a window that can't be
     * captured from a GPU buffer Hyprland can't render into */
    if (f->on_gpu) {
        AppCapture *self = f->self;
        struct zwlr_foreign_toplevel_handle_v1 *wlr_handle = f->wlr_handle;
        frame_free(f, TRUE);
        do_capture(self, wlr_handle, TRUE);
        return;
    }

    g_warning("AppCapture: frame capture failed");
    frame_fail(f, "frame_failed");
}

static void frame_handle_damage(void *data,
    struct hyprland_toplevel_export_frame_v1 *frame,
    uint32_t x, uint32_t y, uint32_t width, uint32_t height)
{ (void)data; (void)frame; (void)x; (void)y; (void)width; (void)height; }

static const struct hyprland_toplevel_export_frame_v1_listener frame_listener = {
    .buffer       = frame_handle_buffer,
    .linux_dmabuf = frame_handle_linux_dmabuf,
    .buffer_done  = frame_handle_buffer_done,
    .flags        = frame_handle_flags,
    .ready        = frame_handle_ready,
    .failed       = frame_handle_failed,
    .damage       = frame_handle_damage,
};

/* =========================================================================
 * Capture helpers
 * ========================================================================= */

static void emit_frame_failed(AppCapture *self, const char *reason)
{
    g_signal_emit(self, signals[SIGNAL_FRAME_FAILED], 0, reason);
}

static struct zwlr_foreign_toplevel_handle_v1 *find_wlr_handle(AppCapture *self,
                                                               const char *addr)
{
    for (guint i = 0; i < self->toplevels->len; i++) {
        ToplevelEntry *entry = g_ptr_array_index(self->toplevels, i);
        if (entry->mapped && entry->wlr_handle &&
            g_strcmp0(entry->address, addr) == 0)
            return entry->wlr_handle;
    }
    return NULL;
}

static void do_capture(AppCapture *self,
                       struct zwlr_foreign_toplevel_handle_v1 *wlr_handle,
                       gboolean shm_only)
{
    Frame *f      = g_new0(Frame, 1);
    f->self       = self;
    f->shm_fd     = -1;
    f->wlr_handle = wlr_handle;
    f->shm_only   = shm_only;
    f->frame  = hyprland_toplevel_export_manager_v1_capture_toplevel_with_wlr_toplevel_handle(
        self->export_manager,
        0,           /* overlay_cursor */
        wlr_handle
    );

    hyprland_toplevel_export_frame_v1_add_listener(f->frame, &frame_listener, f);
    f->timeout_id = g_timeout_add(FRAME_TIMEOUT_MS, frame_timeout_cb, f);
    wl_display_flush(self->display);
}

/* =========================================================================
 * Pending capture queue
 *
 * When capture_by_handle() is called for an address whose wlr handle hasn't
 * been mapped yet (race between Hyprland IPC and wlr foreign-toplevel), we
 * park a PendingCapture and wait for either:
 *   - mapping_handle_window_address → flush_pending_for_address → do_capture
 *   - PENDING_CAPTURE_TIMEOUT_MS elapses → emit frame-failed
 *
 * In practice the JS layer is single-flight so this queue holds ≤ 1 entry.
 * ========================================================================= */

static void pending_capture_free(gpointer data)
{
    PendingCapture *pc = data;
    if (pc->timeout_id != 0) {
        g_source_remove(pc->timeout_id);
        pc->timeout_id = 0;
    }
    g_free(pc->address);
    g_free(pc);
}

static gboolean pending_capture_timeout_cb(gpointer data)
{
    PendingCapture *pc   = data;
    AppCapture     *self = pc->self;

    g_warning("AppCapture: timeout waiting for wlr handle '%s' "
              "(toplevel table has %u entries)",
              pc->address, self->toplevels->len);

    /* Mark consumed so pending_capture_free doesn't double-remove */
    pc->timeout_id = 0;

    /* Remove first (frees pc), THEN emit — emit may re-enter capture_by_handle */
    g_ptr_array_remove(self->pending_captures, pc);
    emit_frame_failed(self, "no_handle_timeout");
    return G_SOURCE_REMOVE;
}

static void flush_pending_for_address(AppCapture *self, const char *address)
{
    if (self->pending_captures->len == 0) return;

    struct zwlr_foreign_toplevel_handle_v1 *wlr_handle =
        find_wlr_handle(self, address);
    if (!wlr_handle) return;

    /* Iterate backwards so removals don't shift indices we're about to visit */
    for (guint i = self->pending_captures->len; i > 0; i--) {
        PendingCapture *pc = g_ptr_array_index(self->pending_captures, i - 1);
        if (g_strcmp0(pc->address, address) != 0) continue;

        do_capture(self, wlr_handle, FALSE);
        g_ptr_array_remove_index(self->pending_captures, i - 1);
        /* JS side is single-flight — at most one match expected.
         * Break to avoid issuing two captures against the same shm state. */
        break;
    }
}

static void toplevel_entry_free(gpointer data)
{
    ToplevelEntry *entry = data;
    if (entry->wlr_handle)
        zwlr_foreign_toplevel_handle_v1_destroy(entry->wlr_handle);
    g_free(entry);
}

/* =========================================================================
 * GObject lifecycle
 * ========================================================================= */

static void app_capture_finalize(GObject *object)
{
    AppCapture *self = APP_CAPTURE(object);
    g_ptr_array_unref(self->pending_captures);
    g_ptr_array_unref(self->toplevels);
    if (self->export_manager)
        hyprland_toplevel_export_manager_v1_destroy(self->export_manager);
    if (self->mapping_manager)
        hyprland_toplevel_mapping_manager_v1_destroy(self->mapping_manager);
    if (self->wlr_manager)
        zwlr_foreign_toplevel_manager_v1_destroy(self->wlr_manager);
    if (self->shm)
        wl_shm_destroy(self->shm);
    if (self->feedback)
        zwp_linux_dmabuf_feedback_v1_destroy(self->feedback);
    if (self->dmabuf)
        zwp_linux_dmabuf_v1_destroy(self->dmabuf);
    if (self->registry)
        wl_registry_destroy(self->registry);
    if (self->renderer) {
        gsk_renderer_unrealize(self->renderer);
        g_object_unref(self->renderer);
    }
    if (self->gbm)
        gbm_device_destroy(self->gbm);
    if (self->drm_fd >= 0)
        close(self->drm_fd);
    if (self->format_table)
        munmap((void *)self->format_table, self->format_table_size);
    g_array_unref(self->tranche_pairs);
    g_array_unref(self->feedback_pairs);
    g_array_unref(self->gpu_pairs);
    G_OBJECT_CLASS(app_capture_parent_class)->finalize(object);
}

static void app_capture_class_init(AppCaptureClass *klass)
{
    GObjectClass *object_class = G_OBJECT_CLASS(klass);
    object_class->finalize = app_capture_finalize;

    signals[SIGNAL_FRAME_READY] = g_signal_new(
        "frame-ready",
        G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST,
        0, NULL, NULL, NULL,
        G_TYPE_NONE, 1,
        GDK_TYPE_TEXTURE
    );

    signals[SIGNAL_FRAME_FAILED] = g_signal_new(
        "frame-failed",
        G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST,
        0, NULL, NULL, NULL,
        G_TYPE_NONE, 1,
        G_TYPE_STRING
    );
}

static void app_capture_init(AppCapture *self)
{
    self->toplevels        = g_ptr_array_new_with_free_func(toplevel_entry_free);
    self->pending_captures = g_ptr_array_new_with_free_func(pending_capture_free);
    self->tranche_pairs    = g_array_new(FALSE, FALSE, sizeof(DmabufPair));
    self->feedback_pairs   = g_array_new(FALSE, FALSE, sizeof(DmabufPair));
    self->gpu_pairs        = g_array_new(FALSE, FALSE, sizeof(DmabufPair));
    self->drm_fd           = -1;

    GdkDisplay *gdk_display = gdk_display_get_default();
    self->display = gdk_wayland_display_get_wl_display(gdk_display);

    self->registry = wl_display_get_registry(self->display);
    wl_registry_add_listener(self->registry, &registry_listener, self);

    /* First roundtrip: compositor advertises globals, we bind them all */
    wl_display_roundtrip(self->display);

    /* Second roundtrip: wlr_manager emits toplevel events for existing
     * windows, and mapping requests are sent for each one */
    wl_display_roundtrip(self->display);

    /* Third roundtrip: mapping responses (window_address events) arrive;
     * the dmabuf feedback has arrived by now too */
    wl_display_roundtrip(self->display);

    gpu_init(self);

    if (!self->export_manager)
        g_warning("AppCapture: hyprland_toplevel_export_manager_v1 not found");
    if (!self->wlr_manager)
        g_warning("AppCapture: zwlr_foreign_toplevel_manager_v1 not found");
    if (!self->mapping_manager)
        g_warning("AppCapture: hyprland_toplevel_mapping_manager_v1 not found");
    if (!self->shm)
        g_warning("AppCapture: wl_shm not found");
}

/* =========================================================================
 * Public API
 * ========================================================================= */

AppCapture *app_capture_new(void)
{
    return g_object_new(APP_TYPE_CAPTURE, NULL);
}

void app_capture_set_min_size(AppCapture *self, gint width, gint height)
{
    g_return_if_fail(APP_IS_CAPTURE(self));
    self->min_width  = width;
    self->min_height = height;
}

void app_capture_capture_by_handle(AppCapture *self, const gchar *address)
{
    g_return_if_fail(APP_IS_CAPTURE(self));
    g_return_if_fail(address != NULL);

    if (!self->export_manager) {
        g_warning("AppCapture: export_manager not available");
        emit_frame_failed(self, "no_export_manager");
        return;
    }

    /* Strip optional "0x" prefix so matching works regardless of input */
    const gchar *addr = address;
    if (g_str_has_prefix(addr, "0x") || g_str_has_prefix(addr, "0X"))
        addr += 2;

    /* Fast path: handle already known and mapped */
    struct zwlr_foreign_toplevel_handle_v1 *wlr_handle =
        find_wlr_handle(self, addr);
    if (wlr_handle) {
        do_capture(self, wlr_handle, FALSE);
        return;
    }

    /* Slow path: park and wait up to PENDING_CAPTURE_TIMEOUT_MS for the
     * wlr_manager toplevel/mapping events to arrive. Race window is
     * typically <100 ms in practice but can spike under load. */
    PendingCapture *pc = g_new0(PendingCapture, 1);
    pc->self       = self;
    pc->address    = g_strdup(addr);
    pc->timeout_id = g_timeout_add(PENDING_CAPTURE_TIMEOUT_MS,
                                   pending_capture_timeout_cb, pc);
    g_ptr_array_add(self->pending_captures, pc);
}
