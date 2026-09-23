#pragma once

// kiwi's Hyprland plugin: what the shell needs from inside the compositor.
// Each part is its own file and says there what it is for:
//
//   geometry.cpp  announces window moves and resizes on the event socket
//   previews.cpp  draws the switchers' tiles from the windows themselves
//   genie.cpp     pours a window into its dock icon and back out of it
//
// They are one plugin because one is one thing to build, to enable and to
// build again after a Hyprland update — which every plugin needs, being
// compiled against the compositor it loads into.

#include <plugins/PluginAPI.hpp>

namespace Kiwi {
    namespace Geometry {
        bool init(HANDLE handle);
        void exit();
    }

    namespace Previews {
        bool init(HANDLE handle);
        void exit();
    }

    namespace Genie {
        bool init(HANDLE handle);
        void exit();
    }
}
