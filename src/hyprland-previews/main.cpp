// kiwi-previews: the compositor draws the switcher's window previews itself.
//
// The app switcher shows what each window looks like. Getting those pictures
// the usual way means asking the compositor to export every window to the
// shell (hyprland-toplevel-export, the protocol screen recorders use): the
// shell needs the permission that grants it every window's pixels, the
// pictures are copies, and a copy is a still — a video in a preview does not
// move.
//
// Here the shell sends where its tiles are and the compositor draws the
// windows' own textures there, once per frame: the pictures are live and
// never leave the compositor, so the shell needs no capture permission at
// all. What arrives from the shell is a list of rectangles; nothing is sent
// back, and a client that talked to this plugin could only make windows
// appear on the screen, which it can already see.
//
//     hyprctl kiwi-previews <namespace> <rounding> <address>,<x>,<y>,<w>,<h> ...
//     hyprctl kiwi-previews clear
//
// x and y are logical pixels from the top-left of the layer surface called
// <namespace>, which is where the shell knows its tiles to be; the plugin
// looks up where that surface currently is on each monitor. The tiles are
// drawn after the windows and before the layers above them, so the shell's
// own titles, icons and selection stay on top — it leaves the tile itself
// transparent, a hole for this to fill.
//
// A tile is redrawn when the window in it commits a frame, not on a timer.
// A window nobody can see is the exception: Hyprland tells such a window it
// is suspended and stops drawing it, and a client that is told that stops
// painting, so while it is in a tile the plugin takes that back and sends it
// the frame callbacks it would otherwise never get. It is suspended again as
// soon as its tile is gone.

#include <plugins/PluginAPI.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <desktop/view/Window.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <output/Monitor.hpp>
#include <state/MonitorState.hpp>
#include <protocols/core/Compositor.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/pass/PassElement.hpp>

#include <algorithm>
#include <format>
#include <charconv>
#include <ranges>
#include <type_traits>
#include <string>
#include <string_view>
#include <vector>

namespace {
    using Render::GL::g_pHyprOpenGL;
    using Desktop::View::CWindow;
    using Desktop::View::IGeometric;

    // one tile: a window, and where the shell put it in its surface
    struct STile {
        PHLWINDOWREF        window;
        CBox                rect; // logical, from the layer surface's top-left
        CHyprSignalListener commit;
    };

    // The tiles of one monitor, in its own scaled pixels, as handed to the
    // render pass.
    struct SDrawTile {
        PHLWINDOWREF window;
        CBox         box;
    };

    class CPreviewPassElement : public IPassElement {
      public:
        CPreviewPassElement(std::vector<SDrawTile>&& tiles, int rounding) : m_tiles(std::move(tiles)), m_rounding(rounding) {}

        std::vector<UP<IPassElement>> draw() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (!MONITOR)
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

                g_pHyprRenderer->m_renderData.clipBox = tile.box;

                SURFACE->resource()->breadthfirst(
                    [&](SP<CWLSurfaceResource> surface, const Vector2D& offset, void*) {
                        if (!surface->m_current.texture || surface->m_current.size.x < 1 || surface->m_current.size.y < 1)
                            return;

                        CBox box{OFFSET + offset * FACTOR, surface->m_current.size * FACTOR};
                        box.round();

                        // the corners are the tile's, so only the window's own
                        // surface is rounded; anything inside it is square
                        const bool MAIN = surface == SURFACE->resource();
                        g_pHyprOpenGL->renderTexture(surface->m_current.texture, box,
                                                     {
                                                         .surface       = surface,
                                                         .a             = 1.F,
                                                         .round         = MAIN ? m_rounding : 0,
                                                         .roundingPower = 2.F,
                                                     });
                    },
                    nullptr);

                g_pHyprRenderer->m_renderData.clipBox = {};
            }

            return {};
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

            double left = m_tiles[0].box.x, top = m_tiles[0].box.y;
            double right = left + m_tiles[0].box.w, bottom = top + m_tiles[0].box.h;
            for (const auto& tile : m_tiles) {
                left   = std::min(left, tile.box.x);
                top    = std::min(top, tile.box.y);
                right  = std::max(right, tile.box.x + tile.box.w);
                bottom = std::max(bottom, tile.box.y + tile.box.h);
            }
            // the pass wants it unscaled
            return CBox{left, top, right - left, bottom - top}.scale(1.0 / MONITOR->m_scale).round();
        }

      private:
        std::vector<SDrawTile> m_tiles;
        int                    m_rounding = 0;
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

            m_stageListener = Event::bus()->m_events.render.stage.listen([this](eRenderStage stage) {
                if (stage == RENDER_POST_WINDOWS)
                    render();
            });
            // damage and frame callbacks belong outside the render itself
            m_preListener = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) { keepAlive(monitor); });
            return true;
        }

        void exit() {
            suspendWoken();
            m_stageListener.reset();
            m_preListener.reset();
            m_command.reset();
            m_tiles.clear();
        }

      private:
        std::string                        m_namespace;
        int                                m_rounding = 0;
        std::vector<STile>                 m_tiles;
        SP<SHyprCtlCommand>                m_command;
        std::vector<PHLWINDOWREF>          m_woken; // suspended again once their tiles are gone
        size_t                             m_commits = 0, m_damages = 0, m_keepAlives = 0;
        CHyprSignalListener                m_stageListener;
        CHyprSignalListener                m_preListener;

        static std::vector<std::string_view> split(std::string_view text, char by) {
            std::vector<std::string_view> parts;
            while (!text.empty()) {
                const auto AT = text.find(by);
                if (AT == std::string_view::npos) {
                    parts.emplace_back(text);
                    break;
                }
                if (AT > 0)
                    parts.emplace_back(text.substr(0, AT));
                text.remove_prefix(AT + 1);
            }
            return parts;
        }

        // from_chars takes a base for integers and a format for floats
        template <typename T>
        static bool parse(std::string_view text, T& out, int base = 10) {
            const auto END    = text.data() + text.size();
            const auto RESULT = [&] {
                if constexpr (std::is_integral_v<T>)
                    return std::from_chars(text.data(), END, out, base);
                else
                    return std::from_chars(text.data(), END, out);
            }();
            return RESULT.ec == std::errc{} && RESULT.ptr == END;
        }

        static PHLWINDOW windowFrom(std::string_view address) {
            uintptr_t handle = 0;
            if (address.starts_with("0x"))
                address.remove_prefix(2);
            if (!parse(address, handle, 16))
                return nullptr;

            for (const auto& window : Desktop::windowState()->windows()) {
                if (reinterpret_cast<uintptr_t>(window.get()) == handle)
                    return window;
            }
            return nullptr;
        }

        // "kiwi-previews <namespace> <rounding> <address>,<x>,<y>,<w>,<h> ..."
        // or "kiwi-previews clear"
        std::string take(std::string_view request) {
            request.remove_prefix(std::string_view{"kiwi-previews"}.size());
            const auto WORDS = split(request, ' ');
            if (!WORDS.empty() && WORDS[0] == "status")
                return std::format("tiles {}, drawn now {}, commits {}, damages {}, keepalives {}\n", m_tiles.size(), drawnNow(), m_commits, m_damages, m_keepAlives);
            if (WORDS.empty() || WORDS[0] == "clear") {
                clear();
                return "ok";
            }
            if (WORDS.size() < 2)
                return "usage: kiwi-previews <namespace> <rounding> [<address>,<x>,<y>,<w>,<h> ...]";

            int rounding = 0;
            if (!parse(WORDS[1], rounding))
                return "rounding must be a number";

            std::vector<STile> tiles;
            for (const auto& word : WORDS | std::views::drop(2)) {
                const auto FIELDS = split(word, ',');
                if (FIELDS.size() != 5)
                    return "a tile is <address>,<x>,<y>,<w>,<h>";

                const auto WINDOW = windowFrom(FIELDS[0]);
                if (!WINDOW)
                    continue; // closed between the shell's list and this call

                double numbers[4];
                for (size_t i = 0; i < 4; ++i) {
                    if (!parse(FIELDS[i + 1], numbers[i]))
                        return "a tile's x, y, width and height must be numbers";
                }
                if (numbers[2] < 1 || numbers[3] < 1)
                    continue;

                tiles.emplace_back(STile{.window = WINDOW, .rect = {numbers[0], numbers[1], numbers[2], numbers[3]}});
                // the window's own frames are what the tile follows
                tiles.back().commit = WINDOW->wlSurface()->resource()->m_events.commit.listen([this, ref = PHLWINDOWREF{WINDOW}] {
                    ++m_commits;
                    damageTilesOf(ref);
                });
            }

            const auto HAD = !m_tiles.empty();
            suspendWoken();
            m_namespace = std::string{WORDS[0]};
            m_rounding     = rounding;
            m_tiles        = std::move(tiles);
            if (!HAD && !m_tiles.empty())
                damageAll();

            return std::format("ok: {} tiles, {} of them on a monitor now\n", m_tiles.size(), drawnNow());
        }

        // what the next frame would draw, for the reply
        size_t drawnNow() const {
            size_t drawn = 0;
            for (const auto& monitor : State::monitorState()->monitors())
                drawn += tilesOn(monitor).size();
            return drawn;
        }

        void clear() {
            suspendWoken();
            if (m_tiles.empty())
                return;
            damageAll();
            m_tiles.clear();
        }

        // the surface the shell's tile coordinates are relative to
        PHLLS layerOn(const PHLMONITOR& monitor) const {
            if (!monitor)
                return nullptr;
            for (const auto& level : monitor->m_layerSurfaceLayers) {
                for (const auto& layer : level) {
                    const auto LAYER = layer.lock();
                    if (LAYER && LAYER->m_layerSurface && LAYER->m_namespace == m_namespace && LAYER->m_mapped)
                        return LAYER;
                }
            }
            return nullptr;
        }

        std::vector<SDrawTile> tilesOn(const PHLMONITOR& monitor) const {
            std::vector<SDrawTile> tiles;
            const auto             LAYER = layerOn(monitor);
            if (!LAYER)
                return tiles;

            for (const auto& tile : m_tiles) {
                if (tile.window.expired())
                    continue;

                CBox box = tile.rect.copy().translate(LAYER->m_geometry.pos() - monitor->m_position).scale(monitor->m_scale);
                box.round();
                tiles.emplace_back(SDrawTile{.window = tile.window, .box = box});
            }
            return tiles;
        }

        void render() {
            if (m_tiles.empty())
                return;

            auto tiles = tilesOn(g_pHyprRenderer->m_renderData.pMonitor.lock());
            if (tiles.empty())
                return;

            g_pHyprRenderer->m_renderPass.add(makeUnique<CPreviewPassElement>(std::move(tiles), std::round(m_rounding * g_pHyprRenderer->m_renderData.pMonitor->m_scale)));
        }

        // A window nobody can see is suspended and never drawn, so it would
        // freeze in its tile: it is woken here and sent the frame callbacks
        // it would otherwise never get, and what it draws damages its tile
        // from the commit above — damage asked for during a render lands in
        // the frame being drawn instead of asking for the next one. A window
        // that is on screen somewhere needs none of this: it draws for its
        // own sake.
        void keepAlive(const PHLMONITOR& monitor) {
            if (m_tiles.empty())
                return;

            const auto NOW = Time::steadyNow();
            for (const auto& tile : tilesOn(monitor)) {
                const auto WINDOW = tile.window.lock();
                // visibleOnMonitor is only an overlap: a window on another
                // workspace still sits where it was. This asks whether the
                // frame being drawn will contain it.
                if (!WINDOW || !WINDOW->m_isMapped || g_pHyprRenderer->shouldRenderWindow(WINDOW, monitor))
                    continue;

                ++m_keepAlives;
                wake(WINDOW);
                WINDOW->wlSurface()->resource()->breadthfirst([&NOW](SP<CWLSurfaceResource> surface, const Vector2D&, void*) { surface->frame(NOW); }, nullptr);
            }
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

        // where this window is being shown, if anywhere
        void damageTilesOf(const PHLWINDOWREF& window) {
            for (const auto& monitor : State::monitorState()->monitors()) {
                for (const auto& tile : tilesOn(monitor)) {
                    if (tile.window != window)
                        continue;
                    ++m_damages;
                    g_pHyprRenderer->damageBox(tile.box.copy().scale(1.0 / monitor->m_scale).translate(monitor->m_position));
                }
            }
        }

        void damageAll() {
            for (const auto& monitor : State::monitorState()->monitors()) {
                for (const auto& tile : tilesOn(monitor)) {
                    CBox damage = tile.box.copy().scale(1.0 / monitor->m_scale).translate(monitor->m_position);
                    g_pHyprRenderer->damageBox(damage);
                }
            }
        }
    };

    UP<CKiwiPreviews> g_kiwiPreviews;
}

APICALL EXPORT std::string pluginAPIVersion() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO pluginInit(HANDLE handle) {
    // kiwi loads this at every start and logs why it failed, so a refusal is
    // quiet here: no notification on screen for something the shell handles
    if (std::string(__hyprland_api_get_hash()) != __hyprland_api_get_client_hash())
        throw std::runtime_error("[kiwi-previews] built for a different Hyprland");

    g_kiwiPreviews = makeUnique<CKiwiPreviews>();
    if (!g_kiwiPreviews->init(handle)) {
        g_kiwiPreviews.reset();
        throw std::runtime_error("[kiwi-previews] could not register the kiwi-previews command");
    }

    return {.name = "kiwi-previews", .description = "Draws the shell's window previews from the windows themselves", .author = "selim", .version = "0.1.0"};
}

APICALL EXPORT void pluginExit() {
    if (g_kiwiPreviews)
        g_kiwiPreviews->exit();
    g_kiwiPreviews.reset();
}
