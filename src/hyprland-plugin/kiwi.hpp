#pragma once

// kiwi's Hyprland plugin: what the shell needs from inside the compositor.
// Each part is its own file and says there what it is for:
//
//   geometry.cpp  announces window moves and resizes on the event socket
//   previews.cpp  draws the switchers' tiles from the windows themselves
//   genie.cpp     pours a window into its dock icon and back out of it
//   requests.hpp  reading the shell's requests, shared by the parts
//
// They are one plugin because one is one thing to build, to enable and to
// build again after a Hyprland update — which every plugin needs, being
// compiled against the compositor it loads into.

#include <plugins/PluginAPI.hpp>

namespace Kiwi {
    // What the shell and the plugin say to each other: the requests, the
    // replies and the events. It goes up by one whenever any of them changes,
    // here and in kiwi-shell's hypr.ts (PLUGIN_PROTOCOL), which asks for it
    // with `hyprctl kiwi-version` and won't use a plugin that says otherwise:
    // on Arch the plugin is built by hyprpm from the repository, the shell by
    // the AUR package from a release, and the two need not be the same.
    constexpr int PROTOCOL = 3;

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
