#pragma once

// kiwi's Hyprland plugin: what the shell needs from inside the compositor.
// Each part is its own file and says there what it is for:
//
//   geometry.cpp  announces window moves and resizes on the event socket
//   previews.cpp  draws the switchers' and the dock's previews from the windows themselves
//   genie.cpp     pours a window into its dock icon and back out of it
//   desktops.cpp  keeps the shell's desktops as workspaces, empty or not
//   stacking.cpp  tiled and floating windows stacked in one order
//   snap.cpp      a window dragged against an edge of the screen tiled there, or filling it
//   layers.cpp    the moment right after a layer is drawn, for the other two
//   fingers.cpp   how far the fingers went on the trackpad, for previews.cpp's gesture
//   requests.hpp  reading the shell's requests, shared by the parts
//
// They are one plugin because one is one thing to build, to enable and to
// build again after a Hyprland update — which every plugin needs, being
// compiled against the compositor it loads into.

#include <plugins/PluginAPI.hpp>

#include <functional>
#include <optional>
#include <string>

namespace Kiwi {
    // What the shell and the plugin say to each other: the requests, the
    // replies and the events. It goes up by one whenever any of them changes,
    // here and in kiwi-shell's hypr.ts (PLUGIN_PROTOCOL), which asks for it
    // with `hyprctl kiwi-version` and won't use a plugin that says otherwise:
    // on Arch the plugin is built by hyprpm from the repository, the shell by
    // the AUR package from a release, and the two need not be the same.
    constexpr int PROTOCOL = 12; // 12: kiwigesture let says how far on the trackpad, no close; kiwipreviews at; an empty flying set flies

    // right after a layer surface (or, with popups, its popups) is drawn
    namespace Layers {
        using FAfterLayer = std::function<void(const PHLLS&, const PHLMONITOR&, bool popups)>;
        bool init(HANDLE handle);
        bool available();
        void afterLayer(FAfterLayer listener);
        void exit();
    }

    namespace Geometry {
        bool init(HANDLE handle);
        void exit();
    }

    namespace Previews {
        bool init(HANDLE handle);
        void exit();
    }

    // A swipe's travel as the fingers went, libinput's acceleration undone:
    // in its unaccelerated units (0.0951 mm), as GNOME and niri have it.
    namespace Fingers {
        // a swipe beginning: the touchpad's acceleration as it is set now
        void     begin();
        // one of its deltas as Hyprland has it, at the time it does
        Vector2D travel(const Vector2D& delta, uint32_t timeMs);
    }

    namespace Genie {
        bool init(HANDLE handle);
        // where the shell keeps minimized windows (a special workspace's
        // name), once it has said
        std::string minimizedWorkspace();
        void exit();
    }

    namespace Desktops {
        bool init(HANDLE handle);
        void exit();
    }

    namespace Stacking {
        bool init(HANDLE handle);
        // whether windows are drawn in one order (or Hyprland's, tiled first)
        bool active();
        void exit();
    }

    // the session locked, a display switched off: told on the event socket
    namespace Screen {
        bool init(HANDLE handle);
        void exit();
    }

    // an app's own minimize button minimizing its window (minimize.cpp)
    namespace Minimize {
        bool init(HANDLE handle);
        void exit();
    }

    // floating windows opening where their app's last was left (memory.cpp)
    namespace Memory {
        bool init(HANDLE handle);
        void exit();
    }

    namespace Snap {
        bool init(HANDLE handle);
        // right before `window` is drawn: what it is dragged towards, under it
        void underWindow(const PHLWINDOW& window, const PHLMONITOR& monitor);
        // while a window joins the tiling beside a chosen tile (dragged
        // against an edge, or back from minimized): that tile, for the layout
        // looking for the one to split
        std::optional<PHLWINDOW> splitting(const Vector2D& pos, uint16_t properties);
        // a window still where a snap put it: the size it had before
        std::optional<Vector2D> sizeBefore(const PHLWINDOW& window);
        void exit();
    }
}
