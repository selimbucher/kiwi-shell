// geometry-events: Hyprland announces on its event socket where a window went.
//
// Hyprland's socket2 says when a window opens, closes, floats, goes
// fullscreen or changes workspace, but not when it is moved or resized, by
// hand or by a keybind. A client that cares where windows are (kiwi's dock
// hides while a window reaches into its strip) could only find out by asking
// over and over. This plugin adds the missing event:
//
//     windowgeometry>>ADDRESS,X,Y,WIDTH,HEIGHT
//
// in layout coordinates, the same numbers `hyprctl clients` reports as `at`
// and `size`: where the window is going, not where its animation has got to.
// It is posted when the frame changes:
//
//  - A keybind move or resize, a layout change or a floating/fullscreen
//    toggle announces the frame the window is animating to, right away.
//  - While the pointer drags or resizes a window, its frame is posted at
//    most once per frame Hyprland draws, and once more where it ends. A
//    mouse reports far more often than a screen redraws, and every event
//    wakes every socket listener.
//  - A frame set again unchanged (layouts re-apply theirs often) is not
//    announced again.
//
// How it hears about it: every layout path, drags, keybinds, floating and
// tiling alike, ends in CWindow::setBox (inherited from
// CGeometricMovableAnimated, reached through a virtual thunk that only
// forwards to it). Hyprland has no signal there, so the plugin hooks it and
// notes which window changed, then compares and posts from an idle callback,
// once per trip around the event loop; a dragged window from Hyprland's
// render.pre instead, which comes once per drawn frame and is only listened
// to while the drag lasts. The window's own move()/resize() are
// not hooked: outside the layout only trackpad window gestures and the
// scrolling layout call them (and the open animation, which re-applies the
// frame the layout already set).

#include <plugins/PluginAPI.hpp>
#include <desktop/view/Window.hpp>
#include <layout/LayoutManager.hpp>
#include <layout/target/Target.hpp>
#include <managers/EventManager.hpp>
#include <managers/eventLoop/EventLoopManager.hpp>
#include <event/EventBus.hpp>

#include <format>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
    using Desktop::View::CGeometricMovableAnimated;
    using Desktop::View::CWindow;
    using Desktop::View::IGeometric;

    constexpr auto SET_BOX = "Desktop::View::CGeometricMovableAnimated::setBox(Hyprutils::Math::CBox const&)";

    // Outlives the plugin's state: Hyprland runs pluginExit first and removes
    // the hook only after that, so windows can still be laid out in between.
    CFunctionHook* g_setBoxHook = nullptr;

    class CGeometryEvents {
      public:
        bool init(HANDLE handle) {
            for (const auto& fn : HyprlandAPI::findFunctionsByName(handle, "setBox")) {
                if (fn.demangled != SET_BOX)
                    continue;
                g_setBoxHook = HyprlandAPI::createFunctionHook(handle, fn.address, reinterpret_cast<void*>(&hkSetBox));
                break;
            }
            if (!g_setBoxHook || !g_setBoxHook->hook())
                return false;

            m_closeListener = Event::bus()->m_events.window.close.listen([this](PHLWINDOW w) { m_announced.erase(w.get()); });
            return true;
        }

        void exit() {
            // Hyprland removes the hook itself, after this has returned
            m_closeListener.reset();
            m_frameListener.reset();
            m_pending.reset();
        }

        // setBox is called with the geometric part of whatever it moved;
        // layer surfaces share the class, so keep only windows.
        void changed(CGeometricMovableAnimated* geometric) {
            const auto window = dynamic_cast<CWindow*>(geometric);
            if (!window)
                return;

            m_changed.emplace_back(window->m_self);
            if (!m_pending)
                m_pending = g_pEventLoopManager->doLaterLock([this] { announce(); });
        }

      private:
        struct SAnnounced {
            PHLWINDOWREF window;
            CBox         box;
        };

        // the last frame posted per window, so an unchanged one isn't posted
        // again; keyed by address, checked against the ref for reuse
        std::unordered_map<CWindow*, SAnnounced> m_announced;
        std::vector<PHLWINDOWREF>                m_changed;
        UP<SEventLoopDoLaterLock>                m_pending;
        CHyprSignalListener                      m_closeListener;
        // only while a window is dragged
        CHyprSignalListener                      m_frameListener;

        static PHLWINDOW dragged() {
            const auto drag = g_layoutManager->dragController()->target();
            return drag ? drag->window() : nullptr;
        }

        void announce() {
            m_pending.reset();
            const auto changed = std::move(m_changed);
            m_changed.clear();

            const auto draggedWindow = dragged();
            for (const auto& ref : changed) {
                const auto w = ref.lock();
                if (!w || !w->m_isMapped)
                    continue;
                if (w == draggedWindow)
                    followDrag();
                else
                    post(w);
            }

            // the drag is over; dragEnd set the last frame, posted above
            if (!draggedWindow)
                m_frameListener.reset();
        }

        void followDrag() {
            if (m_frameListener)
                return;
            m_frameListener = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR) {
                const auto w = dragged();
                if (w && w->m_isMapped)
                    post(w);
                // a drag that ended without setting a last frame: the
                // listener goes from outside its own emission
                else if (!w && !m_pending)
                    m_pending = g_pEventLoopManager->doLaterLock([this] { announce(); });
            });
        }

        void post(const PHLWINDOW& w) {
            auto box = w->geometricBox(IGeometric::GEOMETRIC_GOAL);
            box.round();

            auto& last = m_announced[w.get()];
            if (last.window.lock() == w && last.box == box)
                return;
            last = {.window = w, .box = box};

            g_pEventManager->postEvent(SHyprIPCEvent{
                .event = "windowgeometry",
                .data  = std::format("{:x},{},{},{},{}", reinterpret_cast<uintptr_t>(w.get()), static_cast<int>(box.x), static_cast<int>(box.y),
                                     static_cast<int>(box.w), static_cast<int>(box.h)),
            });
        }

        static void hkSetBox(CGeometricMovableAnimated* self, const CBox& box);
    };

    UP<CGeometryEvents> g_geometryEvents;

    void CGeometryEvents::hkSetBox(CGeometricMovableAnimated* self, const CBox& box) {
        using FSetBox = void (*)(CGeometricMovableAnimated*, const CBox&);
        reinterpret_cast<FSetBox>(g_setBoxHook->m_original)(self, box);
        if (g_geometryEvents)
            g_geometryEvents->changed(self);
    }
}

APICALL EXPORT std::string pluginAPIVersion() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO pluginInit(HANDLE handle) {
    // kiwi loads this at every start and logs why it failed, so a refusal is
    // quiet here: no notification on screen for something the shell handles
    if (std::string(__hyprland_api_get_hash()) != __hyprland_api_get_client_hash())
        throw std::runtime_error("[geometry-events] built for a different Hyprland");

    g_geometryEvents = makeUnique<CGeometryEvents>();
    if (!g_geometryEvents->init(handle)) {
        g_geometryEvents.reset();
        throw std::runtime_error("[geometry-events] no CWindow::setBox to hook");
    }

    return {.name = "geometry-events", .description = "Announces window moves and resizes on the event socket", .author = "selim", .version = "0.1.0"};
}

APICALL EXPORT void pluginExit() {
    if (g_geometryEvents)
        g_geometryEvents->exit();
    g_geometryEvents.reset();
}
