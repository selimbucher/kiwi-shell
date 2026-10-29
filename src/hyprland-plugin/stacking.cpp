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
// Pinned windows and a desktop with a fullscreen or maximized window are left
// as Hyprland has them: they are drawn by other passes, which the pointer
// finds as Hyprland finds them. A special workspace is drawn by this pass too.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <SharedDefs.hpp>
#include <desktop/state/Fadeout.hpp>
#include <desktop/state/FadingOutState.hpp>
#include <desktop/state/ViewHitTester.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/Window.hpp>
#include <desktop/Workspace.hpp>
#include <desktop/state/FocusState.hpp>
#include <config/ConfigValue.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <managers/fullscreen/FullscreenController.hpp>
#include <output/Monitor.hpp>
#include <protocols/XDGShell.hpp>
#include <render/Renderer.hpp>
#include <render/Framebuffer.hpp>
#include <render/pass/RectPassElement.hpp>
#include <render/pass/TexPassElement.hpp>
#include <state/MonitorState.hpp>

#include <algorithm>
#include <unordered_map>
#include <ranges>
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

    // A closing window's fade, as Hyprland draws one (renderFadeouts).
    void drawFadeout(Render::IHyprRenderer* self, const PHLMONITOR& monitor, const SP<Desktop::IFadeout>& fadeout) {
        const auto FB = fadeout->framebuffer();
        if (!FB || !FB->getTexture())
            return;
        const auto EFFECTS = fadeout->effects();
        if (EFFECTS.dimAroundAlpha > 0.F) {
            CRectPassElement::SRectData data;
            data.box   = {0, 0, monitor->m_transformedSize.x, monitor->m_transformedSize.y};
            data.color = CHyprColor(0, 0, 0, EFFECTS.dimAroundAlpha);
            self->m_renderPass.add(makeUnique<CRectPassElement>(data));
        }
        if (EFFECTS.preBlur) {
            CRectPassElement::SRectData data;
            data.box           = EFFECTS.preBlur->box;
            data.color         = CHyprColor(0, 0, 0, 0);
            data.blur          = true;
            data.blurA         = EFFECTS.preBlur->alpha;
            data.round         = EFFECTS.preBlur->round;
            data.roundingPower = EFFECTS.preBlur->roundingPower;
            data.xray          = EFFECTS.preBlur->xray;
            self->m_renderPass.add(makeUnique<CRectPassElement>(data));
        }
        CTexPassElement::SRenderData data;
        data.flipEndFrame          = true;
        data.tex                   = FB->getTexture();
        data.box                   = fadeout->renderBox();
        data.a                     = fadeout->alpha();
        data.damage                = CRegion{0, 0, monitor->m_transformedSize.x, monitor->m_transformedSize.y};
        data.blur                  = EFFECTS.textureBlur.enabled;
        data.blurA                 = EFFECTS.textureBlur.alpha;
        data.forceBlurBlend        = EFFECTS.textureBlur.forceBlend;
        data.ignoreAlpha           = EFFECTS.textureBlur.ignoreAlpha;
        data.blockBlurOptimization = EFFECTS.textureBlur.blockBlurOptimization;
        self->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }

    // Hyprland's pass, but one: every window of the desktop in the list's
    // order, then their popups over them all (a menu over the window next to
    // its own, as Hyprland has it among tiled windows). The checks for which
    // window belongs to the pass are Hyprland's. A window closing fades where
    // it was in the order — Hyprland keeps its place in the list (zIndex), the
    // windows above it moved down one since — not over all the others.
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

        std::vector<SP<Desktop::IFadeout>> fadeouts;
        for (const auto& fadeout : Desktop::fadingOutState()->fadeouts()) {
            if (!fadeout || fadeout->monitor() != monitor || (fadeout->workspace() && fadeout->workspace() != workspace))
                continue;
            if (fadeout->plane() == Desktop::FADEOUT_PLANE_WINDOW_TILED || fadeout->plane() == Desktop::FADEOUT_PLANE_WINDOW_FLOATING)
                fadeouts.emplace_back(fadeout);
        }
        std::ranges::stable_sort(fadeouts, {}, [](const auto& fadeout) { return fadeout->zIndex(); });
        // (each window's place in the list, only while one is fading out)
        std::unordered_map<const void*, int> place;
        if (!fadeouts.empty())
            for (const auto& w : Desktop::windowState()->windows())
                place.emplace(w.get(), place.size());

        size_t faded = 0;
        for (const auto& w : windows) {
            if (faded < fadeouts.size())
                for (const int AT = place[w.get()]; faded < fadeouts.size() && fadeouts[faded]->zIndex() <= AT; ++faded)
                    drawFadeout(self, monitor, fadeouts[faded]);
            // where a window dragged against an edge will go, under it (snap.cpp)
            Kiwi::Snap::underWindow(w, monitor);
            (self->*RENDER_WINDOW)(w, monitor, time, true, Render::RENDER_PASS_MAIN, false, false);
        }
        for (; faded < fadeouts.size(); ++faded)
            drawFadeout(self, monitor, fadeouts[faded]);

        for (const auto& w : windows)
            (self->*RENDER_WINDOW)(w, monitor, time, true, Render::RENDER_PASS_POPUP, false, false);
    }

    // Hyprland's answer, unless it is a floating window with something of
    // this pass drawn over it there: a popup (all of them are over all the
    // windows), or a tiled window above it in the list. Hyprland's own rules
    // for which window may have the pointer stand.
    PHLWINDOW hkWindowAt(const Desktop::CViewHitTester* self, const Vector2D& pos, uint16_t properties, PHLWINDOW ignoreWindow) {
        using namespace Desktop::View;
        // the tile a window dragged against an edge joins, as shown (snap.cpp)
        if (const auto SPLIT = Kiwi::Snap::splitting(pos, properties))
            return *SPLIT;

        using FWindowAt = PHLWINDOW (*)(const Desktop::CViewHitTester*, const Vector2D&, uint16_t, PHLWINDOW);
        const auto FOUND = reinterpret_cast<FWindowAt>(g_hitHook->m_original)(self, pos, properties, ignoreWindow);
        if (!FOUND || !FOUND->m_isFloating || FOUND->m_pinned || !FOUND->m_workspace)
            return FOUND;
        // floating windows asked for, or the windows that come before a lock
        // screen: as Hyprland has them
        if (properties & (FLOATING_ONLY | FOCUS_PRIORITY))
            return FOUND;
        // what this display draws there (a window may reach over from another)
        const auto MONITOR = State::monitorState()->query().vec(pos).run();
        if (!MONITOR)
            return FOUND;
        const auto WORKSPACE = FOUND->onSpecialWorkspace() ? MONITOR->m_activeSpecialWorkspace : MONITOR->m_activeWorkspace;
        if (!WORKSPACE || Fullscreen::controller()->hasFullscreen(WORKSPACE))
            return FOUND;

        static auto PMODALPARENTBLOCKING = CConfigValue<Config::INTEGER>("general:modal_parent_blocking");
        static auto PFOLLOWMOUSESHRINK   = CConfigValue<Config::INTEGER>("input:follow_mouse_shrink");
        const auto  TAKES                = [&](const PHLWINDOW& w) {
            return w->m_isMapped && !w->isHidden() && !w->m_pinned && w != ignoreWindow && w->m_workspace == WORKSPACE && w->acceptsInput() && !w->m_X11ShouldntFocus &&
                !w->m_ruleApplicator->noFocus().valueOrDefault() &&
                !(*PMODALPARENTBLOCKING && w->m_xdgSurface && w->m_xdgSurface->m_toplevel && w->m_xdgSurface->m_toplevel->anyChildModal());
        };
        const auto& WINDOWS = Desktop::windowState()->windows();

        // a popup over it, the topmost window's first
        for (const auto& w : WINDOWS | std::views::reverse) {
            if (!w->m_isX11 && (w == FOUND || TAKES(w)) && w->hasPopupAt(pos))
                return w;
        }

        // a tiled window over it, the topmost first
        const auto SHRINK = (properties & FOLLOW_MOUSE_CHECK) ? *PFOLLOWMOUSESHRINK : 0;
        for (auto it = WINDOWS.rbegin(); it != WINDOWS.rend() && *it != FOUND; ++it) {
            const auto& w = *it;
            if (w->m_isFloating || !TAKES(w))
                continue;
            CBox box = (properties & USE_PROP_TILED) ? w->getWindowBoxUnified(properties) : w->layoutBox();
            if (SHRINK > 0 && w != Desktop::focusState()->window())
                box = box.copy().expand(-SHRINK);
            if (box.containsPoint(pos))
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
