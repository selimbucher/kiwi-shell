#pragma once

// What the parts share for reading the shell's requests: splitting them,
// reading numbers, and finding the window and the layer surface they name.

#include <desktop/state/WindowState.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <desktop/view/Window.hpp>
#include <output/Monitor.hpp>

#include <charconv>
#include <string_view>
#include <type_traits>
#include <vector>

namespace Kiwi {
    // the parts of `text` between the `by`s, empty ones left out
    inline std::vector<std::string_view> split(std::string_view text, char by) {
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

    // all of `text` as a number; from_chars takes a base for integers and a
    // format for floats
    template <typename T>
    bool parse(std::string_view text, T& out, int base = 10) {
        const auto END    = text.data() + text.size();
        const auto RESULT = [&] {
            if constexpr (std::is_integral_v<T>)
                return std::from_chars(text.data(), END, out, base);
            else
                return std::from_chars(text.data(), END, out);
        }();
        return RESULT.ec == std::errc{} && RESULT.ptr == END;
    }

    // the window at a Hyprland address ("0x55…" or without the 0x), if it
    // still exists
    inline PHLWINDOW windowFrom(std::string_view address) {
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

    // the mapped layer surface called `name` on `monitor`
    inline PHLLS layerOn(const PHLMONITOR& monitor, std::string_view name) {
        if (!monitor)
            return nullptr;
        for (const auto& level : monitor->m_layerSurfaceLayers) {
            for (const auto& layer : level) {
                const auto LAYER = layer.lock();
                if (LAYER && LAYER->m_layerSurface && LAYER->m_namespace == name && LAYER->m_mapped)
                    return LAYER;
            }
        }
        return nullptr;
    }
}
