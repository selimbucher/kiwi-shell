// Stacking: tiled and floating windows in one order, as on any other desktop.
//
// Hyprland keeps every window in one list, bottom to top, and moves a window
// to the top when it is clicked or raised (alterzorder, which the shell uses
// to bring one forward). But it draws a desktop's tiled windows first and the
// floating ones over them, and looks for the window under the pointer among
// the floating ones first: a tiled window brought forward stayed behind every
// floating one, Spotify coming out of the dock and going straight back
// behind a terminal. Here a desktop's windows are drawn in the list's order,
// and the pointer finds the one on top, tiled or not.
//
// Pinned windows, fullscreen and special workspaces are left as Hyprland has
// them: they are drawn by other passes, over all this.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <SharedDefs.hpp>
#include <desktop/state/Fadeout.hpp>
#include <desktop/state/ViewHitTester.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/Window.hpp>
#include <desktop/Workspace.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <output/Monitor.hpp>
#include <render/Renderer.hpp>

#include <algorithm>
#include <vector>

namespace {
    constexpr auto RENDER_WORKSPACE_WINDOWS =
        "Render::IHyprRenderer::renderWorkspaceWindows(Hyprutils::Memory::CSharedPointer<Monitor::CMonitor>, Hyprutils::Memory::CSharedPointer<CWorkspace>, "
        "std::chrono::time_point<std::chrono::_V2::steady_clock, std::chrono::duration<long, std::ratio<1l, 1000000000l> > > const&)";
    constexpr auto WINDOW_AT =
        "Desktop::CViewHitTester::windowAt(Hyprutils::Math::Vector2D const&, unsigned short, Hyprutils::Memory::CSharedPointer<Desktop::View::CWindow>) const";

    CFunctionHook* g_renderHook = nullptr;
    CFunctionHook* g_hitHook    = nullptr;

    // the renderer's own way of drawing one window, which it keeps to itself
    struct SRenderer : Render::IHyprRenderer {
        using Render::IHyprRenderer::renderWindow;
    };
    constexpr auto RENDER_WINDOW = &SRenderer::renderWindow;

    // Hyprland's pass, but one: every window of the desktop in the list's
    // order, then their popups over them all (a menu over the window next to
    // its own, as Hyprland has it among tiled windows). The checks for which
    // window belongs to the pass are Hyprland's.
    void hkRenderWorkspaceWindows(Render::IHyprRenderer* self, PHLMONITOR monitor, PHLWORKSPACE workspace, const Time::steady_tp& time) {
        Event::bus()->m_events.render.stage.emit(RENDER_PRE_WINDOWS);

        std::vector<PHLWINDOW> windows;
        windows.reserve(Desktop::windowState()->windows().size());
        for (const auto& w : Desktop::windowState()->windows()) {
            if (w->isHidden() || !w->m_isMapped || !self->shouldRenderWindow(w, monitor))
                continue;
            // drawn with the pinned ones, over all of these
            if (w->m_isFloating && w->m_pinned)
                continue;
            const bool IGNORE_SPECIAL_CHECK = w->m_monitorMovedFrom != -1 && (w->m_workspace && !w->m_workspace->isVisible());
            if (!IGNORE_SPECIAL_CHECK && workspace->m_isSpecialWorkspace != w->onSpecialWorkspace())
                continue;
            // special ones on another monitor are drawn with its own desktop
            if (w->m_isFloating && workspace->m_isSpecialWorkspace && w->m_monitor != workspace->m_monitor)
                continue;
            windows.emplace_back(w);
        }

        for (const auto& w : windows) {
            // where a window dragged against an edge will go, under it (snap.cpp)
            Kiwi::Snap::underWindow(w, monitor);
            (self->*RENDER_WINDOW)(w, monitor, time, true, Render::RENDER_PASS_MAIN, false, false);
        }
        self->renderFadeouts(monitor, Desktop::FADEOUT_PLANE_WINDOW_TILED, workspace);

        for (const auto& w : windows)
            (self->*RENDER_WINDOW)(w, monitor, time, true, Render::RENDER_PASS_POPUP, false, false);
        self->renderFadeouts(monitor, Desktop::FADEOUT_PLANE_WINDOW_FLOATING, workspace);
    }

    // Hyprland's answer, unless it is a floating window with a tiled one over
    // it in the list there: then the tiled one, as it is drawn.
    PHLWINDOW hkWindowAt(const Desktop::CViewHitTester* self, const Vector2D& pos, uint16_t properties, PHLWINDOW ignoreWindow) {
        using FWindowAt = PHLWINDOW (*)(const Desktop::CViewHitTester*, const Vector2D&, uint16_t, PHLWINDOW);
        const auto FOUND = reinterpret_cast<FWindowAt>(g_hitHook->m_original)(self, pos, properties, ignoreWindow);
        if (!FOUND || !FOUND->m_isFloating || FOUND->m_pinned || !FOUND->m_workspace || FOUND->onSpecialWorkspace())
            return FOUND;

        const auto& WINDOWS = Desktop::windowState()->windows();
        const auto  AT      = std::ranges::find(WINDOWS, FOUND);
        if (AT == WINDOWS.end())
            return FOUND;
        // the topmost first
        for (auto it = WINDOWS.rbegin(); it != WINDOWS.rend() && *it != FOUND; ++it) {
            const auto& w = *it;
            if (w->m_isFloating || !w->m_isMapped || w->isHidden() || w == ignoreWindow || w->m_workspace != FOUND->m_workspace || !w->acceptsInput() ||
                w->m_X11ShouldntFocus || w->m_ruleApplicator->noFocus().valueOrDefault())
                continue;
            if (w->getWindowBoxUnified(properties).containsPoint(pos))
                return w;
        }
        return FOUND;
    }

    CFunctionHook* hook(HANDLE handle, const char* name, const char* demangled, void* to) {
        for (const auto& fn : HyprlandAPI::findFunctionsByName(handle, name)) {
            if (fn.demangled != demangled)
                continue;
            const auto HOOK = HyprlandAPI::createFunctionHook(handle, fn.address, to);
            return HOOK && HOOK->hook() ? HOOK : nullptr;
        }
        return nullptr;
    }
}

namespace Kiwi::Stacking {
    bool init(HANDLE handle) {
        // both or neither: drawn in one order but found in the other, a click
        // would go to a window under the one seen
        g_hitHook = hook(handle, "windowAt", WINDOW_AT, reinterpret_cast<void*>(&hkWindowAt));
        if (!g_hitHook)
            return false;
        g_renderHook = hook(handle, "renderWorkspaceWindows", RENDER_WORKSPACE_WINDOWS, reinterpret_cast<void*>(&hkRenderWorkspaceWindows));
        if (!g_renderHook) {
            g_hitHook->unhook();
            g_hitHook = nullptr;
            return false;
        }
        return true;
    }

    bool active() {
        return g_renderHook != nullptr;
    }

    void exit() {
        // Hyprland removes the hooks itself, after this has returned
        g_renderHook = nullptr;
        g_hitHook    = nullptr;
    }
}
