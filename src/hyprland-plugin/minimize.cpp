// Minimize: an app's own minimize button minimizes its window.
//
// Hyprland has no minimizing of its own. An app asking for it (xdg_toplevel's
// set_minimized, an X11 window going iconic) is let through to nothing, and
// Hyprland tells apps beforehand that they can't (xdg_toplevel's
// wm_capabilities leave minimize out), so GTK and libadwaita grey their
// minimize button out. The shell minimizes windows to a special workspace,
// the Dock's (genie.cpp pours them into its icons). So every app is told it
// can minimize, and a window that asks goes there.
//
// A plugin of its own did this for kiwi before (hyprland-csd-minimize, patched
// to advertise the capability); where that is still loaded, this part stands
// aside rather than move every window twice.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <plugins/PluginSystem.hpp>
#include <desktop/view/Window.hpp>
#include <desktop/state/WindowState.hpp>
#include <event/EventBus.hpp>
#include <managers/KeybindManager.hpp>
#include <managers/eventLoop/EventLoopManager.hpp>
#include <protocols/XDGShell.hpp>
#include <xwayland/XSurface.hpp>

#include <algorithm>
#include <format>
#include <unordered_map>

namespace {
    // The toplevel's protocol object, which Hyprland keeps to itself: reached
    // by a pointer to the member, named in an explicit instantiation (where
    // access isn't checked).
    template <typename Tag, typename Tag::type M>
    struct SField {
        friend typename Tag::type field(Tag) {
            return M;
        }
    };
    struct SToplevelResource {
        using type = SP<CXdgToplevel> CXDGToplevelResource::*;
        friend type field(SToplevelResource);
    };
    template struct SField<SToplevelResource, &CXDGToplevelResource::m_resource>;

    // where the shell minimizes to, if it hasn't said (genie.cpp)
    constexpr auto MINIMIZED = "special:minimized";

    struct SWatched {
        PHLWINDOWREF        window; // (a slot left by a dead window at a reused address)
        CHyprSignalListener stateChanged;
    };
    std::unordered_map<Desktop::View::CWindow*, SWatched> g_watched;
    CHyprSignalListener                                   g_openListener, g_closeListener;

    // the plugin this part used to be, loaded as well
    bool standingAside() {
        return g_pPluginSystem &&
            std::ranges::any_of(g_pPluginSystem->getAllPlugins(), [](const CPlugin* p) { return p && p->m_name == "csd-minimize"; });
    }

    void minimize(const PHLWINDOWREF& weak) {
        // after the request has been dealt with by the protocol
        g_pEventLoopManager->doLater([weak] {
            const auto WINDOW = weak.lock();
            if (!WINDOW || !WINDOW->m_isMapped || !WINDOW->m_workspace || WINDOW->onSpecialWorkspace())
                return;
            auto workspace = Kiwi::Genie::minimizedWorkspace();
            if (workspace.empty())
                workspace = MINIMIZED;
            const auto MOVE = g_pKeybindManager->m_dispatchers.find("movetoworkspacesilent");
            if (MOVE != g_pKeybindManager->m_dispatchers.end())
                MOVE->second(std::format("{},address:0x{:x}", workspace, reinterpret_cast<uintptr_t>(WINDOW.get())));
        });
    }

    // Told it can minimize: wm_capabilities sent again, with minimize in it.
    void advertise(const SP<CXDGToplevelResource>& toplevel) {
        const auto& resource = (*toplevel).*field(SToplevelResource{});
        if (!resource || resource->version() < 5)
            return;
        wl_array capabilities;
        wl_array_init(&capabilities);
        for (const uint32_t CAPABILITY : {XDG_TOPLEVEL_WM_CAPABILITIES_FULLSCREEN, XDG_TOPLEVEL_WM_CAPABILITIES_MAXIMIZE, XDG_TOPLEVEL_WM_CAPABILITIES_MINIMIZE})
            *static_cast<uint32_t*>(wl_array_add(&capabilities, sizeof(uint32_t))) = CAPABILITY;
        resource->sendWmCapabilities(&capabilities);
        wl_array_release(&capabilities);
    }

    void watch(const PHLWINDOW& window) {
        if (!window || standingAside())
            return;
        auto& watched = g_watched[window.get()];
        if (watched.window.lock() == window)
            return;
        watched                 = SWatched{.window = window};
        const PHLWINDOWREF WEAK = window;

        if (const auto XDG = window->m_xdgSurface.lock(); XDG && XDG->m_toplevel.lock()) {
            const auto TOPLEVEL = XDG->m_toplevel.lock();
            advertise(TOPLEVEL);
            watched.stateChanged = TOPLEVEL->m_events.stateChanged.listen([WEAK] {
                const auto WINDOW   = WEAK.lock();
                const auto XDG      = WINDOW ? WINDOW->m_xdgSurface.lock() : nullptr;
                const auto TOPLEVEL = XDG ? XDG->m_toplevel.lock() : nullptr;
                if (TOPLEVEL && TOPLEVEL->m_state.requestsMinimize.value_or(false))
                    minimize(WEAK);
            });
        } else if (const auto X = window->m_xwaylandSurface.lock()) {
            watched.stateChanged = X->m_events.stateChanged.listen([WEAK] {
                const auto WINDOW = WEAK.lock();
                const auto X      = WINDOW ? WINDOW->m_xwaylandSurface.lock() : nullptr;
                if (!X || !X->m_state.requestsMinimize.value_or(false))
                    return;
                // answered at once, or some X11 apps wait for it to happen
                X->m_state.requestsMinimize.reset();
                X->setMinimized(false);
                minimize(WEAK);
            });
        }
    }
}

namespace Kiwi::Minimize {
    bool init(HANDLE) {
        for (const auto& window : Desktop::windowState()->windows())
            if (window->m_isMapped)
                watch(window);
        g_openListener  = Event::bus()->m_events.window.open.listen([](PHLWINDOW window) { watch(window); });
        g_closeListener = Event::bus()->m_events.window.close.listen([](PHLWINDOW window) { g_watched.erase(window.get()); });
        return true;
    }

    void exit() {
        g_openListener.reset();
        g_closeListener.reset();
        g_watched.clear();
    }
}
