// Previews: the compositor draws the shell's window previews itself.
//
// The switchers and the dock's flyouts show what each window looks like.
// Getting those pictures the usual way means asking the compositor to export
// every window to the shell (hyprland-toplevel-export, the protocol screen
// recorders use): the shell needs the permission that grants it every
// window's pixels, the pictures are copies, and a copy is a still — a video
// in a preview does not move.
//
// Here the shell sends where its tiles are and the compositor draws the
// windows' own textures there, once per frame: the pictures are live and
// never leave the compositor, so the shell needs no capture permission at
// all. What arrives from the shell is a list of rectangles; nothing is sent
// back, and a client that talked to this plugin could only make windows
// appear on the screen, which it can already see.
//
//     hyprctl kiwi-previews <set> <namespace> <rounding> [live|still] [popup] [square-top] [fly] <address>,<x>,<y>,<w>,<h>[,<cx>,<cy>,<cw>,<ch>[,<badge>]] ...
//     hyprctl kiwi-previews clear [<set>]
//     hyprctl kiwi-previews raise <set> <address>
//     hyprctl kiwi-previews gesture <set> <fingers>
//     hyprctl kiwi-previews swipe begin up|down | update <travel> <ms> | end [cancel]
//
// Each part of the shell that shows previews names its own set, and sets
// come and go independently: the dock's flyout closing does not clear a
// switcher's tiles.
//
// live wakes a window nobody can see so its tile keeps up; still leaves it
// asleep, showing the last frame it drew, which is all a tile the size of a
// thumbnail is worth.
//
// x and y are logical pixels from the top-left of the layer surface called
// <namespace> — or, with popup, of the popup that surface has open, where
// the dock keeps its flyouts. The plugin looks up where that surface
// currently is on each monitor. The window is fitted into x, y, w, h with
// its corners rounded by <rounding>, and cut off at cx, cy, cw, ch when the
// shell names such a rectangle — a workspace's miniature window at the edge
// of its card, a picture whose top corners go under the title bar above it.
// square-top leaves the top corners square, for a picture that hangs from a
// title bar: the rounding is drawn above the picture, where the clip cuts it
// off. (The shell used to get that by sending a tile reaching up behind the
// title bar, but a window fitted into that taller tile came out wider than
// the picture and lost its sides.)
// fly is Mission Control's: the tiles leave their windows as the set appears,
// from where each window is on screen to its tile, and go back into them when
// the set is cleared, after which a `kiwipreviews>>flown,<set>` event says
// the shell can take its surface down. Meanwhile the windows themselves fade
// out early in the flight, and back in late on the way home, under their
// pictures — the title bars and shadows the pictures lack go with them — and
// the layer the tiles are on fades in and out with the flight, its other
// sets with it. Should the layer go away first, the flight ends there.
// raise puts a window's tile on top of the others: the window clicked in
// Mission Control flies home over the rest, as it is about to be.
//
// gesture has that many fingers up the trackpad fly a set's tiles out of
// their windows, and down fly them home, following the fingers the whole way
// as macOS's Mission Control does; let go past half way (or flicked) the
// flight goes on by itself, short of it it goes back. Out of nothing, the
// plugin asks the shell for the set with `kiwigesture>>open,<set>` and holds
// the tiles where the fingers are once they come. `kiwigesture>>held,<set>`
// says the fingers have the set, `kiwigesture>>let,<set>,out|home` where it
// goes once they let go. Down with the set up but nothing in it (Mission
// Control on an empty desktop), `kiwigesture>>close,<set>` asks the shell to
// close it, there being nothing to follow the fingers. While the fingers hold the flight the windows stay
// hidden, wherever the pictures are: shown under pictures that are still on
// their way, they were two of each. Hyprland clears gestures
// on every config reload; this one is added again after each.
// <badge> is an image file (percent-encoded: a path has spaces and commas),
// the app's icon, drawn in the picture's bottom-right corner with a drop
// shadow: thumbnails of same-app windows look alike, the badge says which
// app at a glance. The shell cannot put it there itself, since the picture is
// drawn over the shell's surface; it resolves the icon and the plugin draws
// it. Loaded once per file and size.
//
// The tiles are drawn over the shell's surface, right after it (its popups
// after those): the shell keeps nothing on top of a picture, only around it.
// They used to be drawn under it, through holes the shell cut in its own
// surface, but GTK 4.22 does not reliably redraw what lies inside the mask
// such holes are cut with, and the desktop showed through in patches. A
// popup's tiles fade in and out with it.
//
// New tiles wait for the shell's surface to commit its next frame before they
// are drawn: the shell shows its pane in that frame, so the pane and the
// windows in it appear at once. Drawn any earlier, a tile shows for a frame
// without the pane around it.
//
// A tile is redrawn when the window in it commits a frame, not on a timer.
// A window nobody can see is the exception: Hyprland tells such a window it
// is suspended and stops drawing it, and a client that is told that stops
// painting, so while it is in a live tile the plugin takes that back and
// sends it the frame callbacks it would otherwise never get. It is suspended
// again as soon as its tile is gone.

#include "kiwi.hpp"
#include "requests.hpp"

#include <plugins/PluginAPI.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <desktop/view/Popup.hpp>
#include <desktop/view/Window.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <managers/EventManager.hpp>
#include <managers/eventLoop/EventLoopManager.hpp>
#include <managers/input/trackpad/TrackpadGestures.hpp>
#include <managers/input/trackpad/gestures/ITrackpadGesture.hpp>
#include <output/Monitor.hpp>
#include <state/MonitorState.hpp>
#include <protocols/core/Compositor.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/pass/PassElement.hpp>
#include <hyprgraphics/image/Image.hpp>
#include <cairo/cairo.h>

#include <algorithm>
#include <functional>
#include <optional>
#include <chrono>
#include <cmath>
#include <format>
#include <map>
#include <ranges>
#include <string>
#include <string_view>
#include <vector>

namespace {
    using Kiwi::parse;
    using Kiwi::split;
    using Kiwi::windowFrom;
    using Render::GL::g_pHyprOpenGL;
    using Desktop::View::CPopup;
    using Desktop::View::CWindow;
    using Desktop::View::IGeometric;

    // one tile: a window, and where the shell put it in its surface
    struct STile {
        PHLWINDOWREF        window;
        CBox                rect; // logical, from the surface's top-left
        CBox                clip; // where the picture is cut off; the rect if the shell named none
        std::string         badge; // the app icon's file, or empty
        CHyprSignalListener commit;
    };

    // The tiles of one monitor, in its own scaled pixels, as handed to the
    // render pass.
    struct SDrawTile {
        PHLWINDOWREF window;
        CBox         box, clip;
        std::string  badge;
    };

    // ─── Flying ─────────────────────────────────────────────────────────────
    // macOS's Mission Control, measured off screen recordings (a window
    // tracked frame by frame, four openings and closings): out and home alike
    // on cubic-bezier(0.35, 0, 0.65, 1) over 240 ms, within 1%. Slow off the
    // mark, steady through the middle, settling at the end.
    constexpr auto  FLY_DURATION = std::chrono::milliseconds{240};
    constexpr float FLY_X1 = 0.35F, FLY_Y1 = 0.F, FLY_X2 = 0.65F, FLY_Y2 = 1.F;
    // the windows are gone by this share of the way out, and back from this
    // share of the way home
    constexpr float FLY_HIDDEN_BY = 0.35F;

    float bezier(float a, float b, float u) {
        return 3.F * (1.F - u) * (1.F - u) * u * a + 3.F * (1.F - u) * u * u * b + u * u * u;
    }

    // the curve's u where `along(u)` reaches `value`, both rising from 0 to 1
    template <typename F>
    float solve(F along, float value) {
        float lo = 0.F, hi = 1.F;
        for (int i = 0; i < 24; ++i) {
            const float MID = (lo + hi) / 2.F;
            (along(MID) < value ? lo : hi) = MID;
        }
        return (lo + hi) / 2.F;
    }

    // how far along at time `t` (both 0..1)
    float flyCurve(float t) {
        const float U = solve([](float u) { return bezier(FLY_X1, FLY_X2, u); }, std::clamp(t, 0.F, 1.F));
        return bezier(FLY_Y1, FLY_Y2, U);
    }

    // the time at which it is `y` of the way
    float flyCurveInverse(float y) {
        const float U = solve([](float u) { return bezier(FLY_Y1, FLY_Y2, u); }, std::clamp(y, 0.F, 1.F));
        return bezier(FLY_X1, FLY_X2, U);
    }

    // a full swipe, from the windows to the tiles, in the trackpad's units
    constexpr float GESTURE_DISTANCE = 240.F;
    // Let go faster than this (units per ms) and the flight goes that way;
    // slower, it goes on past this share of the way, and back short of it.
    // A Mac takes a short quick swipe as readily as a long one, and lets a
    // slow one go a little way.
    constexpr float GESTURE_FLICK   = 0.3F;
    constexpr float GESTURE_PAST    = 0.35F;
    // and held still this long, it was no flick
    constexpr auto GESTURE_REST = std::chrono::milliseconds{80};

    CBox between(const CBox& from, const CBox& to, float t) {
        return CBox{from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.w + (to.w - from.w) * t, from.h + (to.h - from.h) * t};
    }

    // ─── The badge ──────────────────────────────────────────────────────────
    // logical pixels, as the shell's CSS had them when it drew the badge itself
    constexpr int BADGE_SIZE   = 40;
    constexpr int BADGE_MARGIN = 8;
    // the shadow is baked into the texture: cairo paints black through the
    // icon's own alpha at a few offsets below it (0 1px 3px, roughly), so it
    // follows the icon's shape as a CSS drop-shadow would. Padding around the
    // icon holds it.
    constexpr int BADGE_PAD = 4;

    // textures by "<file>@<pixels>"; a file that failed to load stays null so
    // it is not tried every frame
    using BadgeTextures = std::map<std::string, SP<Render::ITexture>>;

    SP<Render::ITexture> loadBadge(BadgeTextures& cache, const std::string& file, int px, double scale) {
        const auto KEY = std::format("{}@{}", file, px);
        if (const auto IT = cache.find(KEY); IT != cache.end())
            return IT->second;

        auto& slot = cache[KEY];
        Hyprgraphics::CImage image(file, {(double)px, (double)px}); // the size only matters for an svg
        // a file that will not load leaves the tile without a badge, as the
        // rest of the plugin leaves the unexpected alone
        if (!image.success() || !image.cairoSurface() || !image.cairoSurface()->cairo())
            return nullptr;
        const auto ICON = image.cairoSurface()->cairo();
        const int  W = cairo_image_surface_get_width(ICON), H = cairo_image_surface_get_height(ICON);
        if (W < 1 || H < 1)
            return nullptr;

        // a raster icon comes at its own size; the shadow scales with it
        const int    PAD  = std::max(1, (int)std::round(BADGE_PAD * (double)W / (BADGE_SIZE * scale)));
        const double STEP = PAD / 4.0;
        const auto   OUT  = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, W + 2 * PAD, H + 2 * PAD);
        const auto   CR   = cairo_create(OUT);
        cairo_set_source_rgba(CR, 0, 0, 0, 0.11);
        for (const auto& [dx, dy] : std::initializer_list<std::pair<double, double>>{{-1, 1}, {0, 1}, {1, 1}, {-1, 2}, {0, 2}, {1, 2}, {0, 3}})
            cairo_mask_surface(CR, ICON, PAD + dx * STEP, PAD + dy * STEP);
        cairo_set_source_surface(CR, ICON, PAD, PAD);
        cairo_paint(CR);
        cairo_destroy(CR);
        cairo_surface_flush(OUT);

        slot = g_pHyprRenderer->createTexture(OUT);
        cairo_surface_destroy(OUT);
        return slot;
    }

    // the surface a set's tiles are placed on, where it is right now
    struct SAnchor {
        Vector2D                   origin; // global, logical
        float                      alpha = 1.F;
        SP<CWLSurfaceResource>     surface;
    };

    class CPreviewPassElement : public IPassElement {
      public:
        CPreviewPassElement(std::vector<SDrawTile>&& tiles, int rounding, bool squareTop, float alpha, BadgeTextures& badges) :
            m_tiles(std::move(tiles)), m_rounding(rounding), m_squareTop(squareTop), m_alpha(alpha), m_badges(badges) {}

        std::vector<UP<IPassElement>> draw() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (!MONITOR || m_alpha <= 0.F)
                return {};

            for (const auto& tile : m_tiles) {
                const auto WINDOW = tile.window.lock();
                if (!WINDOW || !WINDOW->m_isMapped)
                    continue;

                const auto SURFACE = WINDOW->wlSurface();
                if (!SURFACE || !SURFACE->resource())
                    continue;

                const auto SIZE = WINDOW->size(IGeometric::GEOMETRIC_CURRENT);
                if (SIZE.x <= 0 || SIZE.y <= 0)
                    continue;

                // the shell sizes a tile to the window's aspect, but a window
                // it had to clamp (very wide, very narrow) doesn't match:
                // fill the tile and let the clip take the rest, as the shell
                // does with its own captures
                const double FACTOR = std::max(tile.box.w / SIZE.x, tile.box.h / SIZE.y);
                const Vector2D OFFSET{tile.box.x + (tile.box.w - SIZE.x * FACTOR) / 2, tile.box.y + (tile.box.h - SIZE.y * FACTOR) / 2};

                g_pHyprRenderer->m_renderData.clipBox = tile.clip;

                SURFACE->resource()->breadthfirst(
                    [&](SP<CWLSurfaceResource> surface, const Vector2D& offset, void*) {
                        if (!surface->m_current.texture || surface->m_current.size.x < 1 || surface->m_current.size.y < 1)
                            return;

                        CBox box{OFFSET + offset * FACTOR, surface->m_current.size * FACTOR};
                        box.round();

                        // The window itself carries the tile's rounded
                        // corners, and so does a surface inside it that
                        // reaches one of them: Firefox and Thunderbird draw
                        // all they show in one that covers the window, as
                        // Hyprland rounds every surface of a window. Anything
                        // else inside is drawn square, and cut off by the clip.
                        CBox SHOWN = box.intersection(tile.box);
                        if (SHOWN.empty())
                            return;
                        if (surface != SURFACE->resource() && !reachesCorner(SHOWN, tile.box)) {
                            g_pHyprOpenGL->renderTexture(surface->m_current.texture, box, {.surface = surface, .a = m_alpha});
                            return;
                        }

                        // Drawn at the tile's size, the part outside the tile
                        // left out by its texture coordinates: rounding
                        // applies to the box drawn. Square top corners are
                        // rounded out of sight, above the clip.
                        if (m_squareTop) {
                            SHOWN.y -= m_rounding;
                            SHOWN.h += m_rounding;
                        }
                        g_pHyprOpenGL->renderTexture(surface->m_current.texture, SHOWN,
                                                     {
                                                         .surface                     = surface,
                                                         .a                           = m_alpha,
                                                         .round                       = m_rounding,
                                                         .roundingPower               = 2.F,
                                                         .allowCustomUV               = true,
                                                         .primarySurfaceUVTopLeft     = (SHOWN.pos() - box.pos()) / box.size(),
                                                         .primarySurfaceUVBottomRight = (SHOWN.pos() + SHOWN.size() - box.pos()) / box.size(),
                                                     });
                    },
                    nullptr);

                if (!tile.badge.empty())
                    drawBadge(tile, MONITOR->m_scale);

                g_pHyprRenderer->m_renderData.clipBox = {};
            }

            return {};
        }

        // whether a box shown in a tile takes up one of the tile's corners
        static bool reachesCorner(const CBox& shown, const CBox& tile) {
            constexpr double SLACK = 1.0; // pixels, for rounding
            const bool       LEFT   = shown.x <= tile.x + SLACK;
            const bool       TOP    = shown.y <= tile.y + SLACK;
            const bool       RIGHT  = shown.x + shown.w >= tile.x + tile.w - SLACK;
            const bool       BOTTOM = shown.y + shown.h >= tile.y + tile.h - SLACK;
            return (LEFT || RIGHT) && (TOP || BOTTOM);
        }

        // in the picture's bottom-right corner, still cut off by the clip
        void drawBadge(const SDrawTile& tile, double scale) {
            const int  PX      = std::round(BADGE_SIZE * scale);
            const auto TEXTURE = loadBadge(m_badges, tile.badge, PX, scale);
            if (!TEXTURE)
                return;
            const double PAD  = BADGE_PAD * scale;
            const double EDGE = (BADGE_SIZE + BADGE_MARGIN) * scale;
            CBox         box{tile.clip.x + tile.clip.w - EDGE - PAD, tile.clip.y + tile.clip.h - EDGE - PAD, PX + 2 * PAD, PX + 2 * PAD};
            box.round();
            g_pHyprOpenGL->renderTexture(TEXTURE, box, {.a = m_alpha, .allowDim = false});
        }

        bool needsLiveBlur() override {
            return false;
        }

        bool needsPrecomputeBlur() override {
            return false;
        }

        const char* passName() override {
            return "CKiwiPreviewPassElement";
        }

        ePassElementType type() override {
            return EK_CUSTOM;
        }

        std::optional<CBox> boundingBox() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (!MONITOR || m_tiles.empty())
                return {};

            double left = m_tiles[0].clip.x, top = m_tiles[0].clip.y;
            double right = left + m_tiles[0].clip.w, bottom = top + m_tiles[0].clip.h;
            for (const auto& tile : m_tiles) {
                left   = std::min(left, tile.clip.x);
                top    = std::min(top, tile.clip.y);
                right  = std::max(right, tile.clip.x + tile.clip.w);
                bottom = std::max(bottom, tile.clip.y + tile.clip.h);
            }
            // the pass wants it unscaled
            return CBox{left, top, right - left, bottom - top}.scale(1.0 / MONITOR->m_scale).round();
        }

      private:
        std::vector<SDrawTile> m_tiles;
        int                    m_rounding  = 0;
        bool                   m_squareTop = false;
        float                  m_alpha     = 1.F;
        BadgeTextures&         m_badges;
    };

    struct SCounters {
        size_t commits = 0, damages = 0, keepAlives = 0;
    };

    // %XX as the shell's encodeURIComponent writes it
    std::string unescape(std::string_view text) {
        std::string out;
        out.reserve(text.size());
        for (size_t i = 0; i < text.size(); ++i) {
            int byte = 0;
            if (text[i] == '%' && i + 2 < text.size() && parse(text.substr(i + 1, 2), byte, 16)) {
                out.push_back(static_cast<char>(byte));
                i += 2;
            } else
                out.push_back(text[i]);
        }
        return out;
    }

    // One part of the shell's previews: its tiles, and the surface they are on.
    class CTileSet {
      public:
        CTileSet(SCounters& counters, BadgeTextures& badges) : m_counters(counters), m_badges(badges) {}

        ~CTileSet() {
            clear();
        }

        std::string name, namespace_;
        bool        popup     = false;
        int         rounding  = 0;
        bool        live      = false;
        bool        squareTop = false;
        bool        fly       = false;

        void apply(std::vector<STile>&& tiles) {
            m_done = false;
            suspendWoken();
            m_armListeners.clear();
            m_armSurfaces.clear();
            m_armed = !tiles.empty();
            if (m_armed) {
                m_pending = std::move(tiles);
                listenForCommit();
            } else if (!m_tiles.empty()) {
                damageAll();
                m_tiles.clear();
                // A flying set left with no tiles (its last window gone to
                // another desktop) has nothing to fly home: its windows are
                // just given back. Only a clear sends tiles home.
                if (fly)
                    hideWindows();
            } else if (fly && !m_flying) {
                // Shown with nothing to fly (Mission Control on an empty
                // desktop): it is out already. Tiles that come later (a
                // desktop zoomed into, one slid to) are where they're put,
                // rather than flying out of their windows as on opening.
                m_flying  = true;
                m_closing = false;
                m_since   = Time::steadyNow() - std::chrono::duration_cast<Time::steady_dur>(std::chrono::duration<float>(FLY_DURATION));
            }
        }

        void clear() {
            m_armed = false;
            m_pending.clear();
            m_armListeners.clear();
            m_armSurfaces.clear();
            suspendWoken();
            showWindows();
            m_flying = false;
            if (m_tiles.empty())
                return;
            damageAll();
            m_tiles.clear();
        }

        size_t size() const {
            return m_tiles.size();
        }

        // Cleared: a flying set flies home first, and is done once there.
        void close() {
            if (!fly || m_tiles.empty() || !m_flying) {
                m_held = false;
                clear();
                m_done = true;
                return;
            }
            m_armed = false;
            m_pending.clear();
            if (m_closing)
                return;
            const float SHOWN = shown();
            m_closing         = true;
            m_since           = Time::steadyNow() - std::chrono::duration_cast<Time::steady_dur>(std::chrono::duration<float>(FLY_DURATION) * flyCurveInverse(1.F - SHOWN));
            m_held            = false;
            m_showBelow       = std::min(FLY_HIDDEN_BY, SHOWN);
            m_hiddenChanged   = true;
            // nothing else may be drawing: the way home starts with a frame
            damageMonitors();
        }

        void damageMonitors() {
            for (const auto& monitor : State::monitorState()->monitors())
                if (monitor && anchorOn(monitor))
                    g_pHyprRenderer->damageMonitor(monitor);
        }

        // out of their windows and staying out: open
        bool isOut() const {
            return m_flying && !m_closing && !m_tiles.empty();
        }

        bool hasTiles() const {
            return !m_tiles.empty();
        }

        // Mission Control up with no windows to show: on an empty desktop
        bool isOutEmpty() const {
            return fly && m_tiles.empty() && !m_closing && !m_done;
        }

        bool isClosing() const {
            return m_closing;
        }

        bool isHeld() const {
            return m_held;
        }

        // A gesture's hand on the flight: held at `progress` until let go.
        void hold(float progress) {
            if (m_tiles.empty())
                return;
            if (!m_flying) {
                m_flying = true;
                hideWindows();
            }
            m_held          = true;
            m_closing       = false;
            m_heldAt        = std::clamp(progress, 0.F, 1.F);
            m_showBelow     = 0.F;
            m_hiddenChanged = true;
            damageMonitors();
        }

        // let go: on out, or home
        void letGo(bool out) {
            if (!m_held)
                return;
            m_held          = false;
            m_hiddenChanged = true;
            if (out) {
                m_closing = false;
                m_since   = Time::steadyNow() - std::chrono::duration_cast<Time::steady_dur>(std::chrono::duration<float>(FLY_DURATION) * flyCurveInverse(m_heldAt));
            } else {
                m_closing   = true;
                m_since     = Time::steadyNow() - std::chrono::duration_cast<Time::steady_dur>(std::chrono::duration<float>(FLY_DURATION) * flyCurveInverse(1.F - m_heldAt));
                m_showBelow = std::min(FLY_HIDDEN_BY, m_heldAt);
            }
            damageMonitors();
        }

        // the window's tile drawn over the others
        bool raise(const PHLWINDOWREF& window) {
            const auto IT = std::ranges::find_if(m_tiles, [&](const STile& tile) { return tile.window == window; });
            if (IT == m_tiles.end())
                return false;
            std::rotate(IT, IT + 1, m_tiles.end());
            damageAll();
            return true;
        }

        // Once a frame is drawn: a flight still under way asks for the next.
        // Damage asked for while the frame is being drawn goes into that
        // frame, and with nothing else on screen moving there would be no
        // next one — the flight stood still until the pointer moved.
        void afterFrame(const PHLMONITOR& monitor) {
            if (!m_flying || !monitor || !anchorOn(monitor))
                return;
            if (m_closing || std::chrono::duration<float>(Time::steadyNow() - m_since) < std::chrono::duration<float>(FLY_DURATION) + std::chrono::milliseconds{50})
                g_pHyprRenderer->damageMonitor(monitor);
        }

        bool done() const {
            return m_done;
        }

        // how far out of their windows a flying set's tiles are: 0 in them,
        // 1 in place
        float shown() const {
            if (!m_flying)
                return 1.F;
            if (m_held)
                return m_heldAt;
            const float T = std::clamp(std::chrono::duration<float>(Time::steadyNow() - m_since).count() / std::chrono::duration<float>(FLY_DURATION).count(), 0.F, 1.F);
            return m_closing ? 1.F - flyCurve(T) : flyCurve(T);
        }

        // The shell's next frame is the one it shows its pane in. A surface
        // that maps after the request is picked up as it maps: a layer from
        // inside the commit it maps with (a listener added during a signal
        // hears only the ones after, and that frame is the shell's first,
        // which it draws empty), a popup on the next frame drawn.
        void listenForCommit() {
            if (!m_armed)
                return;
            for (const auto& monitor : State::monitorState()->monitors()) {
                const auto ANCHOR = anchorOn(monitor);
                if (!ANCHOR || !ANCHOR->surface || std::ranges::find(m_armSurfaces, ANCHOR->surface) != m_armSurfaces.end())
                    continue;
                m_armSurfaces.emplace_back(ANCHOR->surface);
                // the listeners stay until the next request: this runs inside one
                m_armListeners.emplace_back(ANCHOR->surface->m_events.commit.listen([this] {
                    if (!m_armed)
                        return;
                    m_armed = false;
                    damageAll(); // where the old tiles were
                    m_tiles = std::move(m_pending);
                    m_pending.clear();
                    if (fly)
                        flyOut();
                    damageAll();
                }));
            }
        }

        // the layer surface the tiles are on, or the popup it has open
        std::optional<SAnchor> anchorOn(const PHLMONITOR& monitor) const {
            const auto LAYER = Kiwi::layerOn(monitor, namespace_);
            if (!LAYER)
                return std::nullopt;
            if (!popup)
                return SAnchor{
                    .origin  = LAYER->m_geometry.pos(),
                    .alpha   = LAYER->alpha()[Desktop::View::LS_ALPHA_FADE]->value(),
                    .surface = LAYER->wlSurface() ? LAYER->wlSurface()->resource() : nullptr,
                };
            if (!LAYER->m_popupHead)
                return std::nullopt;

            std::optional<SAnchor> found;
            LAYER->m_popupHead->breadthfirst(
                [&found](SP<CPopup> node, void*) {
                    if (found || !node || !node->m_mapped || node->inert() || !node->wlSurface() || !node->wlSurface()->resource())
                        return;
                    found = SAnchor{
                        .origin  = node->coordsGlobal(),
                        .alpha   = node->alpha()[Desktop::View::POPUP_ALPHA_FADE]->value(),
                        .surface = node->wlSurface()->resource(),
                    };
                },
                nullptr);
            return found;
        }

        std::vector<SDrawTile> tilesOn(const PHLMONITOR& monitor, const std::optional<SAnchor>& anchor) const {
            std::vector<SDrawTile> tiles;
            if (!anchor)
                return tiles;
            const float SHOWN = shown();
            for (const auto& tile : m_tiles) {
                const auto WINDOW = tile.window.lock();
                if (!WINDOW)
                    continue;
                const auto ON_MONITOR = [&](const CBox& rect) { return rect.copy().translate(anchor->origin - monitor->m_position).scale(monitor->m_scale).round(); };
                auto       box        = ON_MONITOR(tile.rect);
                auto       clip       = ON_MONITOR(tile.clip);
                if (SHOWN < 1.F) {
                    // on the way between the window and its tile
                    const auto FROM = WINDOW->geometricBox(IGeometric::GEOMETRIC_CURRENT).translate(-monitor->m_position).scale(monitor->m_scale);
                    box             = between(FROM, box, SHOWN).round();
                    clip            = box;
                }
                tiles.emplace_back(SDrawTile{.window = tile.window, .box = box, .clip = clip, .badge = tile.badge});
            }
            return tiles;
        }

        // just after the layer (or its popups) has been added to the frame
        void afterLayer(const PHLLS& layer, const PHLMONITOR& monitor, bool popups) {
            if (m_tiles.empty() || popups != popup || layer->m_namespace != namespace_)
                return;
            const auto ANCHOR = anchorOn(monitor);
            auto       tiles  = tilesOn(monitor, ANCHOR);
            if (tiles.empty())
                return;
            // the windows in flight are the windows: whole all the way
            const float ALPHA = fly ? 1.F : ANCHOR->alpha;
            g_pHyprRenderer->m_renderPass.add(makeUnique<CPreviewPassElement>(std::move(tiles), std::round(rounding * monitor->m_scale), squareTop, ALPHA, m_badges));
        }

        // A window nobody can see is suspended and never drawn, so it would
        // freeze in its tile: it is woken here and sent the frame callbacks
        // it would otherwise never get, and what it draws damages its tile
        // from the commit above — damage asked for during a render lands in
        // the frame being drawn instead of asking for the next one. A window
        // that is on screen somewhere needs none of this: it draws for its
        // own sake.
        void keepAlive(const PHLMONITOR& monitor) {
            // a popup mapped after the request is picked up here
            listenForCommit();
            if (m_flying)
                flight(monitor);
            if (m_tiles.empty() || !live)
                return;

            const auto NOW = Time::steadyNow();
            for (const auto& tile : tilesOn(monitor, anchorOn(monitor))) {
                const auto WINDOW = tile.window.lock();
                // visibleOnMonitor is only an overlap: a window on another
                // workspace still sits where it was. This asks whether the
                // frame being drawn will contain it.
                // Nor will it a window this set has faded out for its flight:
                // its picture would stand still all through Mission Control.
                if (!WINDOW || !WINDOW->m_isMapped || (g_pHyprRenderer->shouldRenderWindow(WINDOW, monitor) && !isHidden(tile.window)))
                    continue;

                ++m_counters.keepAlives;
                wake(WINDOW);
                WINDOW->wlSurface()->resource()->breadthfirst([&NOW](SP<CWLSurfaceResource> surface, const Vector2D&, void*) { surface->frame(NOW); }, nullptr);
            }
        }

        // where this window is being shown, if anywhere
        void damageTilesOf(const PHLWINDOWREF& window) {
            for (const auto& monitor : State::monitorState()->monitors()) {
                for (const auto& tile : tilesOn(monitor, anchorOn(monitor))) {
                    if (tile.window != window)
                        continue;
                    ++m_counters.damages;
                    g_pHyprRenderer->damageBox(tile.clip.copy().scale(1.0 / monitor->m_scale).translate(monitor->m_position));
                }
            }
        }

      private:
        SCounters&                          m_counters;
        BadgeTextures&                      m_badges;
        std::vector<STile>                  m_tiles;
        // new tiles are held back until the shell's surface next commits;
        // the ones on screen stay until then
        std::vector<STile>                  m_pending;
        bool                                m_armed = false;
        std::vector<CHyprSignalListener>    m_armListeners;
        std::vector<WP<CWLSurfaceResource>> m_armSurfaces;
        std::vector<PHLWINDOWREF>           m_woken; // suspended again once their tiles are gone

        // a flying set's flight, and the windows it has faded out with
        // the alpha each had before
        bool            m_flying = false, m_closing = false, m_done = false;
        bool            m_held   = false; // by a gesture, at m_heldAt
        float           m_heldAt = 0.F;
        Time::steady_tp m_since;
        float           m_applied       = -1.F; // the flight's point last applied to the windows
        bool            m_hiddenChanged = false;
        // the share of the way below which the windows show: FLY_HIDDEN_BY
        // for a flight of its own; nothing while fingers hold it, nor on
        // the way out after (the windows are gone already); on the way home
        // after, from where the fingers let go
        float m_showBelow = FLY_HIDDEN_BY;
        struct SHidden {
            PHLWINDOWREF window;
            float        alpha = 1.F;
        };
        std::vector<SHidden> m_hidden;

        // tiles in place, or newly so: out of their windows from wherever
        // the flight is, coming back included
        void flyOut() {
            if (m_held) {
                hideWindows();
                return;
            }
            const float SHOWN = m_flying ? shown() : 0.F;
            if (!m_flying)
                m_showBelow = FLY_HIDDEN_BY;
            m_flying          = true;
            m_closing         = false;
            m_since           = Time::steadyNow() - std::chrono::duration_cast<Time::steady_dur>(std::chrono::duration<float>(FLY_DURATION) * flyCurveInverse(SHOWN));
            hideWindows();
        }

        // the tiles' windows faded with the flight, any others given back
        void hideWindows() {
            std::erase_if(m_hidden, [this](const SHidden& hidden) {
                const auto WINDOW = hidden.window.lock();
                if (WINDOW && std::ranges::any_of(m_tiles, [&](const STile& tile) { return tile.window == hidden.window; }))
                    return false;
                if (WINDOW)
                    WINDOW->alpha(Desktop::View::WINDOW_ALPHA_FULLSCREEN)->setValueAndWarp(hidden.alpha);
                return true;
            });
            for (const auto& tile : m_tiles) {
                const auto WINDOW = tile.window.lock();
                if (WINDOW && std::ranges::none_of(m_hidden, [&](const SHidden& hidden) { return hidden.window == tile.window; }))
                    m_hidden.emplace_back(SHidden{.window = tile.window, .alpha = WINDOW->alphaValue(Desktop::View::WINDOW_ALPHA_FULLSCREEN)});
            }
            m_hiddenChanged = true;
        }

        bool isHidden(const PHLWINDOWREF& window) const {
            return std::ranges::any_of(m_hidden, [&](const SHidden& hidden) { return hidden.window == window; });
        }

        void showWindows() {
            for (const auto& hidden : m_hidden) {
                if (const auto WINDOW = hidden.window.lock())
                    WINDOW->alpha(Desktop::View::WINDOW_ALPHA_FULLSCREEN)->setValueAndWarp(hidden.alpha);
            }
            m_hidden.clear();
        }

        // each frame of a flight, before it is drawn
        void flight(const PHLMONITOR& monitor) {
            const auto LAYER = Kiwi::layerOn(monitor, namespace_);
            const bool ANYWHERE =
                std::ranges::any_of(State::monitorState()->monitors(), [this](const PHLMONITOR& m) { return m && Kiwi::layerOn(m, namespace_); });
            const float SHOWN = shown();
            if (!ANYWHERE || (m_closing && SHOWN <= 0.F)) {
                landed();
                return;
            }
            // a warp damages what it changes even when nothing does: only
            // while the flight moves, or Mission Control would redraw the
            // screen every frame for as long as it is open
            if (SHOWN != m_applied || m_hiddenChanged) {
                m_applied       = SHOWN;
                m_hiddenChanged = false;
                const float LEFT = m_showBelow <= 0.F ? (SHOWN <= 0.F ? 1.F : 0.F) : 1.F - std::clamp(SHOWN / m_showBelow, 0.F, 1.F);
                for (const auto& hidden : m_hidden) {
                    if (const auto WINDOW = hidden.window.lock())
                        WINDOW->alpha(Desktop::View::WINDOW_ALPHA_FULLSCREEN)->setValueAndWarp(hidden.alpha * LEFT);
                }
            }
            if (LAYER && LAYER->alpha()[Desktop::View::LS_ALPHA_FADE]->value() != SHOWN)
                LAYER->alpha()[Desktop::View::LS_ALPHA_FADE]->setValueAndWarp(SHOWN);
        }

        // home, or the surface they were on is gone
        void landed() {
            const bool WAS_CLOSING = m_closing;
            m_flying               = false;
            m_closing              = false;
            m_held                 = false;
            showWindows();
            if (!WAS_CLOSING)
                return;
            clear();
            m_done = true;
            g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwipreviews", .data = std::format("flown,{}", name)});
        }

        // Hyprland suspends a window whose workspace is not on screen, and
        // picks the state again on every workspace and monitor change, so
        // this holds only until the next one — after which the window is on
        // screen or its tile is gone.
        void wake(const PHLWINDOW& window) {
            if (std::ranges::find(m_woken, window) == m_woken.end())
                m_woken.emplace_back(window);
            window->setSuspended(false);
        }

        void suspendWoken() {
            for (const auto& ref : m_woken) {
                const auto WINDOW = ref.lock();
                if (!WINDOW || !WINDOW->m_isMapped)
                    continue;
                WINDOW->setSuspended(WINDOW->isHidden() || !WINDOW->m_workspace || !WINDOW->m_workspace->isVisible());
            }
            m_woken.clear();
        }

        void damageAll() {
            for (const auto& monitor : State::monitorState()->monitors()) {
                for (const auto& tile : tilesOn(monitor, anchorOn(monitor)))
                    g_pHyprRenderer->damageBox(tile.clip.copy().scale(1.0 / monitor->m_scale).translate(monitor->m_position));
            }
        }
    };

    // Fingers on the trackpad, as Hyprland hands them over: the travel is up
    // the trackpad, in its units.
    class CFlyGesture : public ITrackpadGesture {
      public:
        struct SHandlers {
            std::function<void(bool up, float travel, uint32_t ms)> begin;
            std::function<void(float travel, uint32_t ms)>          update;
            std::function<void(bool cancelled)>                     end;
        };

        explicit CFlyGesture(SHandlers handlers) : m_handlers(std::move(handlers)) {}

        void begin(const STrackpadGestureBegin& e) override {
            ITrackpadGesture::begin(e);
            if (e.swipe)
                m_handlers.begin(e.direction == TRACKPAD_GESTURE_DIR_UP, -e.swipe->delta.y * m_scale, e.swipe->timeMs);
        }

        void update(const STrackpadGestureUpdate& e) override {
            if (e.swipe)
                m_handlers.update(-e.swipe->delta.y * m_scale, e.swipe->timeMs);
        }

        void end(const STrackpadGestureEnd& e) override {
            m_handlers.end(e.swipe && e.swipe->cancelled);
        }

      private:
        SHandlers m_handlers;
    };

    class CKiwiPreviews {
      public:
        bool init(HANDLE handle) {
            m_command = HyprlandAPI::registerHyprCtlCommand(handle,
                                                            SHyprCtlCommand{
                                                                .name = "kiwi-previews",
                                                                // the arguments are part of the request, so it can
                                                                // only be matched by its start
                                                                .exact = false,
                                                                .fn    = [this](eHyprCtlOutputFormat, std::string request) { return take(request); },
                                                            });
            if (!m_command)
                return false;

            // right over the shell's surface (layers.cpp)
            if (!Kiwi::Layers::available())
                return false;
            Kiwi::Layers::afterLayer([this](const PHLLS& layer, const PHLMONITOR& monitor, bool popups) { afterLayer(layer, monitor, popups); });
            // damage and frame callbacks belong outside the render itself
            m_preListener = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) {
                m_rendering = monitor;
                swipeOnto();
                for (auto& [_, set] : m_sets)
                    set->keepAlive(monitor);
                std::erase_if(m_sets, [](const auto& entry) { return entry.second->done(); });
            });
            // damage from here on is the next frame's (as the genie has it)
            m_stageListener = Event::bus()->m_events.render.stage.listen([this](eRenderStage stage) {
                if (stage != RENDER_POST)
                    return;
                const auto MONITOR = m_rendering.lock();
                for (auto& [_, set] : m_sets)
                    set->afterFrame(MONITOR);
            });
            m_openedListener = Event::bus()->m_events.layer.opened.listen([this](PHLLS) {
                for (auto& [_, set] : m_sets)
                    set->listenForCommit();
            });
            // a reload has cleared the gestures, the config's own back by now
            m_reloadListener = Event::bus()->m_events.config.reloaded.listen([this] {
                m_gestureAdded = false;
                g_pEventLoopManager->doLater([this] { addGesture(); });
            });
            return true;
        }

        void exit() {
            // Hyprland would call into a plugin that is gone
            removeGesture();
            m_reloadListener.reset();
            m_preListener.reset();
            m_stageListener.reset();
            m_openedListener.reset();
            m_command.reset();
            m_sets.clear();
            m_badges.clear();
        }

        // just after a layer, or its popups, has been added to the frame
        void afterLayer(const PHLLS& layer, const PHLMONITOR& monitor, bool popups) {
            if (!layer || !monitor)
                return;
            // flying tiles last: a window dragged over Mission Control's bar
            // goes over the desktops' pictures there
            for (const bool FLY : {false, true})
                for (auto& [_, set] : m_sets)
                    if (set->fly == FLY)
                        set->afterLayer(layer, monitor, popups);
        }

      private:
        std::map<std::string, UP<CTileSet>, std::less<>> m_sets;
        SCounters                                        m_counters;
        BadgeTextures                                    m_badges;
        SP<SHyprCtlCommand>                              m_command;
        CHyprSignalListener                              m_preListener;
        CHyprSignalListener                              m_stageListener;
        CHyprSignalListener                              m_openedListener;
        CHyprSignalListener                              m_reloadListener;
        PHLMONITORREF                                    m_rendering;

        // ─── The gesture ──────────────────────────────────────────────────────
        // the set it flies and on how many fingers, and the swipe under way
        std::string m_gestureSet;
        size_t      m_gestureFingers = 0;
        bool        m_gestureAdded   = false;
        struct {
            bool                active = false, opening = false;
            float               progress = 0.F, velocity = 0.F;
            uint32_t            lastMs   = 0;
            Time::steady_tp     lastAt;
            // let go before the tiles came: on out, or home
            std::optional<bool> decided;
            Time::steady_tp     decidedAt;
        } m_swipe;

        std::string addGesture() {
            if (m_gestureFingers == 0)
                return "ok";
            removeGesture();
            auto result = g_pTrackpadGestures->addGesture(makeUnique<CFlyGesture>(CFlyGesture::SHandlers{
                                                              .begin  = [this](bool up, float travel, uint32_t ms) { swipeBegin(up, travel, ms); },
                                                              .update = [this](float travel, uint32_t ms) { swipeUpdate(travel, ms); },
                                                              .end    = [this](bool cancelled) { swipeEnd(cancelled); },
                                                          }),
                                                          m_gestureFingers, TRACKPAD_GESTURE_DIR_VERTICAL, 0, 1.F, false);
            if (!result)
                return result.error();
            m_gestureAdded = true;
            return "ok";
        }

        // only ever ours: one the config has on the same fingers stays
        void removeGesture() {
            if (m_gestureAdded)
                (void)g_pTrackpadGestures->removeGesture(m_gestureFingers, TRACKPAD_GESTURE_DIR_VERTICAL, 0, 1.F, false);
            m_gestureAdded = false;
        }

        CTileSet* gestureSet() {
            const auto IT = m_sets.find(m_gestureSet);
            return IT == m_sets.end() ? nullptr : IT->second.get();
        }

        void swipeBegin(bool up, float travel, uint32_t ms) {
            m_swipe         = {};
            const auto SET  = gestureSet();
            if (SET && SET->isClosing())
                return; // on its way home already
            const bool OPEN = SET && SET->isOut();
            if (up && !OPEN) {
                m_swipe.opening = true;
                g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwigesture", .data = std::format("open,{}", m_gestureSet)});
            } else if (!up && OPEN) {
                m_swipe.progress = SET->shown();
                SET->hold(m_swipe.progress);
            } else if (!up && SET && SET->isOutEmpty()) {
                // nothing to take home under the fingers: the shell just closes it
                g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwigesture", .data = std::format("close,{}", m_gestureSet)});
                return;
            } else
                return;
            m_swipe.active = true;
            m_swipe.lastMs = ms;
            // the shell lets nothing be pointed at while the fingers have the windows
            g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwigesture", .data = std::format("held,{}", m_gestureSet)});
            swipeUpdate(travel, ms);
        }

        void swipeUpdate(float travel, uint32_t ms) {
            if (!m_swipe.active)
                return;
            m_swipe.progress = std::clamp(m_swipe.progress + travel / GESTURE_DISTANCE, 0.F, 1.F);
            const float DT   = std::max(1.F, static_cast<float>(ms - m_swipe.lastMs));
            m_swipe.velocity = 0.6F * m_swipe.velocity + 0.4F * (travel / DT);
            m_swipe.lastMs   = ms;
            m_swipe.lastAt   = Time::steadyNow();
            if (const auto SET = gestureSet(); SET && SET->hasTiles())
                SET->hold(m_swipe.progress);
        }

        void swipeEnd(bool cancelled) {
            if (!m_swipe.active)
                return;
            m_swipe.active = false;
            // fingers that came to rest before letting go flicked nothing
            if (Time::steadyNow() - m_swipe.lastAt > GESTURE_REST)
                m_swipe.velocity = 0.F;
            // past the mark from where it started, the way the fingers went
            const float PAST = m_swipe.opening ? GESTURE_PAST : 1.F - GESTURE_PAST;
            bool        out  = m_swipe.velocity > GESTURE_FLICK ? true : m_swipe.velocity < -GESTURE_FLICK ? false : m_swipe.progress > PAST;
            if (cancelled)
                out = !m_swipe.opening;
            // with how far and how fast, for tuning the two above on a real trackpad
            g_pEventManager->postEvent(SHyprIPCEvent{
                .event = "kiwigesture", .data = std::format("let,{},{},{:.2f},{:.2f}", m_gestureSet, out ? "out" : "home", m_swipe.progress, m_swipe.velocity)});
            if (const auto SET = gestureSet(); SET && SET->hasTiles() && SET->isHeld())
                SET->letGo(out);
            else {
                m_swipe.decided   = out;
                m_swipe.decidedAt = Time::steadyNow();
            }
        }

        // The tiles the swipe opened come a few frames into it: they are
        // put where the fingers are by now, or, the fingers already gone,
        // where the swipe would have left them.
        void swipeOnto() {
            const auto SET = gestureSet();
            if (!SET || !SET->hasTiles() || SET->isHeld())
                return;
            if (m_swipe.active && m_swipe.opening)
                SET->hold(m_swipe.progress);
            else if (m_swipe.decided) {
                // a swipe given up on long ago isn't this opening's
                if (Time::steadyNow() - m_swipe.decidedAt < std::chrono::seconds{1}) {
                    SET->hold(m_swipe.progress);
                    SET->letGo(*m_swipe.decided);
                }
                m_swipe.decided.reset();
            }
        }

        // "<set> <namespace> <rounding> [live|still] [popup] <tile> ...",
        // "clear [<set>]" or "status"
        std::string take(std::string_view request) {
            request.remove_prefix(std::string_view{"kiwi-previews"}.size());
            const auto WORDS = split(request, ' ');
            if (!WORDS.empty() && WORDS[0] == "status") {
                std::string sets;
                for (const auto& [name, set] : m_sets)
                    sets += std::format(" {}: {} tiles on {}{} ({}{}{})", name, set->size(), set->namespace_, set->popup ? " popup" : "", set->live ? "live" : "still",
                                        set->squareTop ? ", square top" : "", set->fly ? ", flying" : "");
                return std::format("sets:{}; commits {}, damages {}, keepalives {}\n", sets.empty() ? " none" : sets, m_counters.commits, m_counters.damages,
                                   m_counters.keepAlives);
            }
            if (WORDS.size() == 3 && WORDS[0] == "gesture") {
                size_t fingers = 0;
                if (!parse(WORDS[2], fingers))
                    return "fingers must be a number";
                removeGesture();
                m_gestureSet     = std::string{WORDS[1]};
                m_gestureFingers = fingers;
                return addGesture();
            }
            if (WORDS.size() == 3 && WORDS[0] == "raise") {
                const auto IT     = m_sets.find(WORDS[1]);
                const auto WINDOW = windowFrom(WORDS[2]);
                if (IT == m_sets.end() || !WINDOW || !IT->second->raise(WINDOW))
                    return "no such tile";
                return "ok";
            }
            // the gesture's swipe without a trackpad, step by step: for tests,
            // and for playing the same swipe back as often as needed
            if (WORDS.size() >= 2 && WORDS[0] == "swipe") {
                float    travel = 0.F;
                uint32_t ms     = 0;
                if (WORDS[1] == "begin" && WORDS.size() == 3 && (WORDS[2] == "up" || WORDS[2] == "down"))
                    swipeBegin(WORDS[2] == "up", 0.F, 0);
                else if (WORDS[1] == "update" && WORDS.size() == 4 && parse(WORDS[2], travel) && parse(WORDS[3], ms))
                    swipeUpdate(travel, ms);
                else if (WORDS[1] == "end")
                    swipeEnd(WORDS.size() == 3 && WORDS[2] == "cancel");
                else
                    return "usage: kiwi-previews swipe begin up|down | update <travel> <ms> | end [cancel]";
                return "ok";
            }
            if (WORDS.empty() || WORDS[0] == "clear") {
                if (WORDS.size() > 1) {
                    // a flying set goes when it has flown home
                    if (const auto IT = m_sets.find(WORDS[1]); IT != m_sets.end()) {
                        IT->second->close();
                        if (IT->second->done())
                            m_sets.erase(IT);
                    }
                } else
                    m_sets.clear();
                return "ok";
            }
            if (WORDS.size() < 3)
                return "usage: kiwi-previews <set> <namespace> <rounding> [live|still] [popup] [square-top] [fly] <address>,<x>,<y>,<w>,<h>[,<cx>,<cy>,<cw>,<ch>[,<badge>]] ...";

            int rounding = 0;
            if (!parse(WORDS[2], rounding))
                return "rounding must be a number";

            size_t first = 3;
            bool   live = false, popup = false, squareTop = false, fly = false;
            for (; first < WORDS.size(); ++first) {
                if (WORDS[first] == "live")
                    live = true;
                else if (WORDS[first] == "popup")
                    popup = true;
                else if (WORDS[first] == "square-top")
                    squareTop = true;
                else if (WORDS[first] == "fly")
                    fly = true;
                else if (WORDS[first] != "still")
                    break;
            }

            const std::string  NAME{WORDS[0]};
            std::vector<STile> tiles;
            for (const auto& word : WORDS | std::views::drop(first)) {
                const auto FIELDS = split(word, ',');
                if (FIELDS.size() != 5 && FIELDS.size() != 9 && FIELDS.size() != 10)
                    return "a tile is <address>,<x>,<y>,<w>,<h>[,<cx>,<cy>,<cw>,<ch>[,<badge>]]";

                double numbers[8];
                for (size_t i = 0; i + 1 < std::min<size_t>(FIELDS.size(), 9); ++i) {
                    if (!parse(FIELDS[i + 1], numbers[i]))
                        return "a tile's rectangles must be numbers";
                }
                const std::string BADGE = FIELDS.size() == 10 ? unescape(FIELDS[9]) : "";

                // closed, or closing, between the shell's list and this call
                const auto WINDOW = windowFrom(FIELDS[0]);
                if (!WINDOW || !WINDOW->m_isMapped || !WINDOW->wlSurface() || !WINDOW->wlSurface()->resource())
                    continue;

                const CBox RECT{numbers[0], numbers[1], numbers[2], numbers[3]};
                const CBox CLIP = FIELDS.size() == 9 ? CBox{numbers[4], numbers[5], numbers[6], numbers[7]}.intersection(RECT) : RECT;
                if (RECT.w < 1 || RECT.h < 1 || CLIP.w < 1 || CLIP.h < 1)
                    continue;

                tiles.emplace_back(STile{.window = WINDOW, .rect = RECT, .clip = CLIP, .badge = BADGE});
                // the window's own frames are what its tile follows
                tiles.back().commit = WINDOW->wlSurface()->resource()->m_events.commit.listen([this, NAME, ref = PHLWINDOWREF{WINDOW}] {
                    ++m_counters.commits;
                    if (const auto IT = m_sets.find(NAME); IT != m_sets.end())
                        IT->second->damageTilesOf(ref);
                });
            }

            auto& set = m_sets[NAME];
            if (!set)
                set = makeUnique<CTileSet>(m_counters, m_badges);
            set->namespace_ = std::string{WORDS[1]};
            set->rounding   = rounding;
            set->live       = live;
            set->popup      = popup;
            set->squareTop  = squareTop;
            set->fly        = fly;
            set->name       = NAME;

            const auto COUNT = tiles.size();
            set->apply(std::move(tiles));
            return std::format("ok: {} tiles, drawn from the shell's next frame\n", COUNT);
        }
    };

    UP<CKiwiPreviews> g_kiwiPreviews;

}

namespace Kiwi::Previews {
    bool init(HANDLE handle) {
        g_kiwiPreviews = makeUnique<CKiwiPreviews>();
        if (!g_kiwiPreviews->init(handle)) {
            g_kiwiPreviews.reset();
            return false;
        }
        return true;
    }

    void exit() {
        if (g_kiwiPreviews)
            g_kiwiPreviews->exit();
        g_kiwiPreviews.reset();
    }
}
