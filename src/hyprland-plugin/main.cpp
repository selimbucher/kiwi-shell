#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>

#include <stdexcept>
#include <string>

APICALL EXPORT std::string pluginAPIVersion() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO pluginInit(HANDLE handle) {
    // kiwi loads this at every start and logs why it failed, so a refusal is
    // quiet here: no notification on screen for something the shell handles
    if (std::string(__hyprland_api_get_hash()) != __hyprland_api_get_client_hash())
        throw std::runtime_error("[kiwi] built for a different Hyprland");

    // The shell can do without either part, so one that won't start is not
    // worth refusing the other over; it says in its own log what is missing.
    const bool GEOMETRY = Kiwi::Geometry::init(handle);
    const bool PREVIEWS = Kiwi::Previews::init(handle);
    const bool GENIE    = Kiwi::Genie::init(handle);
    if (!GEOMETRY && !PREVIEWS)
        throw std::runtime_error("[kiwi] neither window geometry nor previews could start");

    return {
        .name        = "kiwi",
        .description = std::string{"For kiwi-shell: "} + (GEOMETRY ? "window geometry events" : "(no window geometry events)") + ", " +
            (PREVIEWS ? "window previews" : "(no window previews)") + ", " +
            (GENIE ? "minimize animation" : "(no minimize animation)"),
        .author  = "selim",
        .version = "0.2.0",
    };
}

APICALL EXPORT void pluginExit() {
    Kiwi::Genie::exit();
    Kiwi::Previews::exit();
    Kiwi::Geometry::exit();
}
