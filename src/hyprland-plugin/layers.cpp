// Layers: a moment in the frame right after a layer surface is drawn.
//
// The previews and the genie are drawn over the shell's own surfaces — the
// switchers, the dock, the dock's popups — and under whatever is above them:
// another layer, the lock screen, the cursor. Hyprland has no signal there,
// so the layer's render is hooked, and each part asks to be told.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <helpers/time/Time.hpp>
#include <output/Monitor.hpp>
#include <render/Renderer.hpp>

#include <vector>

namespace {
    constexpr auto RENDER_LAYER =
        "Render::IHyprRenderer::renderLayer(Hyprutils::Memory::CSharedPointer<Desktop::View::CLayerSurface>, Hyprutils::Memory::CSharedPointer<Monitor::CMonitor>, "
        "std::chrono::time_point<std::chrono::_V2::steady_clock, std::chrono::duration<long, std::ratio<1l, 1000000000l> > > const&, bool, bool)";

    CFunctionHook*                          g_hook = nullptr;
    std::vector<Kiwi::Layers::FAfterLayer> g_listeners;

    void hkRenderLayer(Render::IHyprRenderer* self, PHLLS layer, PHLMONITOR monitor, const Time::steady_tp& time, bool popups, bool lockscreen) {
        using FRenderLayer = void (*)(Render::IHyprRenderer*, PHLLS, PHLMONITOR, const Time::steady_tp&, bool, bool);
        reinterpret_cast<FRenderLayer>(g_hook->m_original)(self, layer, monitor, time, popups, lockscreen);
        if (lockscreen || !layer || !monitor)
            return;
        for (const auto& listener : g_listeners)
            listener(layer, monitor, popups);
    }
}

namespace Kiwi::Layers {
    bool init(HANDLE handle) {
        for (const auto& fn : HyprlandAPI::findFunctionsByName(handle, "renderLayer")) {
            if (fn.demangled != RENDER_LAYER)
                continue;
            g_hook = HyprlandAPI::createFunctionHook(handle, fn.address, reinterpret_cast<void*>(&hkRenderLayer));
            break;
        }
        return g_hook && g_hook->hook();
    }

    bool available() {
        return g_hook != nullptr;
    }

    void afterLayer(FAfterLayer listener) {
        g_listeners.emplace_back(std::move(listener));
    }

    void exit() {
        // Hyprland removes the hook itself, after this has returned
        g_listeners.clear();
    }
}
