#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>

#include <format>
#include <stdexcept>
#include <string>

static SP<SHyprCtlCommand> g_versionCommand;

APICALL EXPORT std::string pluginAPIVersion() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO pluginInit(HANDLE handle) {
    // kiwi loads this at every start and logs why it failed, so a refusal is
    // quiet here: no notification on screen for something the shell handles
    if (std::string(__hyprland_api_get_hash()) != __hyprland_api_get_client_hash())
        throw std::runtime_error("[kiwi] built for a different Hyprland");

    // The shell can do without any part, so one that won't start is not
    // worth refusing the others over; it says in its own log what is missing.
    // the previews and the genie are drawn right after the shell's layers
    Kiwi::Layers::init(handle);
    const bool GEOMETRY = Kiwi::Geometry::init(handle);
    const bool PREVIEWS = Kiwi::Previews::init(handle);
    const bool GENIE    = Kiwi::Genie::init(handle);
    const bool DESKTOPS = Kiwi::Desktops::init(handle);
    const bool STACKING = Kiwi::Stacking::init(handle);
    // its shape is drawn in the stacking's pass
    const bool SNAP = STACKING && Kiwi::Snap::init(handle);
    const bool SCREEN = Kiwi::Screen::init(handle);
    if (!GEOMETRY && !PREVIEWS && !GENIE && !DESKTOPS && !STACKING)
        throw std::runtime_error("[kiwi] none of its parts could start");

    g_versionCommand = HyprlandAPI::registerHyprCtlCommand(handle,
                                                           SHyprCtlCommand{
                                                               .name  = "kiwi-version",
                                                               .exact = true,
                                                               .fn    = [](eHyprCtlOutputFormat, std::string) { return std::format("{}", Kiwi::PROTOCOL); },
                                                           });

    return {
        .name        = "kiwi",
        .description = std::string{"For kiwi-shell: "} + (GEOMETRY ? "window geometry events" : "(no window geometry events)") + ", " +
            (PREVIEWS ? "window previews" : "(no window previews)") + ", " +
            (GENIE ? "minimize and restore animation" : "(no minimize animation)") + ", " + (DESKTOPS ? "desktops" : "(no desktops)") + ", " +
            (STACKING ? "one stacking order" : "(tiled windows under floating ones)") + ", " + (SNAP ? "snapping to the edges" : "(no snapping)") + ", " +
            (SCREEN ? "screen lock and power events" : "(no screen events)"),
        .author  = "selim",
        .version = "0.2.0",
    };
}

APICALL EXPORT void pluginExit() {
    Kiwi::Screen::exit();
    Kiwi::Snap::exit();
    Kiwi::Stacking::exit();
    Kiwi::Desktops::exit();
    Kiwi::Genie::exit();
    Kiwi::Previews::exit();
    Kiwi::Geometry::exit();
    Kiwi::Layers::exit();
    g_versionCommand.reset();
}
