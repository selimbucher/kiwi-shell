// Desktops: the shell's desktops kept as Hyprland workspaces, empty or not.
//
// macOS keeps a desktop until it is closed, whether anything is on it or not;
// Hyprland drops a workspace as soon as it is empty and out of sight. So the
// shell names the workspaces that are its desktops, display by display, and
// they are kept: an empty one is made where it belongs, and every one of them
// is marked persistent, as a workspace rule would mark it. Hyprland's own
// workspace swipe then moves through exactly the shell's desktops.
//
//     hyprctl kiwi-desktops <monitor>:<id>[,<id>...] ...
//     hyprctl kiwi-desktops
//
// Each request is the whole set; a workspace kept before and missing now is
// let go, and Hyprland drops it if nothing else keeps it. A request with
// none lets them all go. A monitor that isn't connected keeps its desktops
// for when it is.
//
// A config reload takes persistence from every workspace no rule asks it for,
// so the set is applied again after each, and when a monitor is connected.
//
// While a display's desktops slide (Hyprland's own swipe under the fingers,
// its finish after they let go, a switch from the keyboard), the plugin says
// where the slide is, every frame it moves:
//
//     kiwidesk>>MONITOR,WORKSPACEID,FRACTION
//
// FRACTION is how far the active workspace is from its place, in desktops
// (its offset over the display's width and the gap between workspaces):
// the view is FRACTION desktops back from WORKSPACEID. Mission Control
// follows it, so that a swipe while it is open moves its desktops with the
// fingers rather than jumping once Hyprland has switched.

#include "kiwi.hpp"
#include "requests.hpp"

#include <plugins/PluginAPI.hpp>
#include <desktop/Workspace.hpp>
#include <config/ConfigValue.hpp>
#include <event/EventBus.hpp>
#include <managers/EventManager.hpp>
#include <managers/eventLoop/EventLoopManager.hpp>
#include <output/Monitor.hpp>
#include <state/MonitorState.hpp>
#include <state/WorkspaceState.hpp>

#include <algorithm>
#include <cmath>
#include <format>
#include <map>
#include <ranges>
#include <string>
#include <vector>

namespace {
    using Kiwi::parse;
    using Kiwi::split;

    class CKiwiDesktops {
      public:
        bool init(HANDLE handle) {
            m_command = HyprlandAPI::registerHyprCtlCommand(handle,
                                                            SHyprCtlCommand{
                                                                .name  = "kiwi-desktops",
                                                                .exact = false,
                                                                .fn    = [this](eHyprCtlOutputFormat, std::string request) { return take(request); },
                                                            });
            if (!m_command)
                return false;

            // after the reload has taken persistence away, not before
            m_refreshedListener = Event::bus()->m_events.config.props_refreshed.listen([this](bool) { applySoon(); });
            m_monitorListener   = Event::bus()->m_events.monitor.added.listen([this](PHLMONITOR) { applySoon(); });
            m_frameListener     = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) { tellSlide(monitor); });
            return true;
        }

        void exit() {
            m_refreshedListener.reset();
            m_monitorListener.reset();
            m_frameListener.reset();
            m_command.reset();
            m_kept.clear();
            release({});
        }

      private:
        // the desktops by monitor name, in the shell's order
        std::map<std::string, std::vector<WORKSPACEID>> m_kept;
        // the workspaces marked persistent here
        std::vector<PHLWORKSPACEREF> m_ours;
        SP<SHyprCtlCommand>          m_command;
        CHyprSignalListener          m_refreshedListener, m_monitorListener, m_frameListener;
        // where each display's slide was last told to be, by monitor name
        std::map<std::string, std::pair<WORKSPACEID, double>> m_slides;

        // Only when it has moved: a display at rest sends nothing, and
        // one frame at rest after a slide says it has stopped.
        void tellSlide(const PHLMONITOR& monitor) {
            if (!monitor || !monitor->m_activeWorkspace)
                return;
            static auto  GAP      = CConfigValue<Config::INTEGER>("general:gaps_workspaces");
            const auto   WS       = monitor->m_activeWorkspace;
            const double DESKTOP  = monitor->m_size.x + *GAP;
            const double FRACTION = DESKTOP > 0 ? WS->m_renderOffset->value().x / DESKTOP : 0.0;
            auto&        last     = m_slides[monitor->m_name];
            if (last.first == WS->m_id && std::abs(last.second - FRACTION) < 1e-4)
                return;
            const bool MOVED = last.first != WS->m_id || FRACTION != 0.0 || last.second != 0.0;
            last             = {WS->m_id, FRACTION};
            if (MOVED)
                g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwidesk", .data = std::format("{},{},{:.4f}", monitor->m_name, WS->m_id, FRACTION)});
        }
        bool                         m_applying = false;

        void applySoon() {
            if (m_applying)
                return;
            m_applying = true;
            g_pEventLoopManager->doLater([this] {
                m_applying = false;
                apply();
            });
        }

        void apply() {
            std::vector<PHLWORKSPACE> kept;
            for (const auto& [name, ids] : m_kept) {
                const auto MONITOR = monitorNamed(name);
                if (!MONITOR)
                    continue;
                for (const auto ID : ids) {
                    auto workspace = State::workspaceState()->query().id(ID).run();
                    // one on another monitor now was moved there: it stays
                    // where it was put, and the shell hears of it there
                    if (!workspace)
                        workspace = State::workspaceState()->create(ID, MONITOR->m_id, "", false);
                    if (!workspace || workspace->m_isSpecialWorkspace)
                        continue;
                    workspace->setPersistent(true);
                    kept.emplace_back(workspace);
                }
            }
            release(kept);
        }

        // lets go of every workspace kept here that isn't in `kept`
        void release(const std::vector<PHLWORKSPACE>& kept) {
            for (const auto& ref : m_ours) {
                const auto WORKSPACE = ref.lock();
                if (WORKSPACE && std::ranges::find(kept, WORKSPACE) == kept.end())
                    WORKSPACE->setPersistent(false);
            }
            m_ours.clear();
            for (const auto& workspace : kept)
                m_ours.emplace_back(workspace);
        }

        static PHLMONITOR monitorNamed(std::string_view name) {
            for (const auto& monitor : State::monitorState()->monitors()) {
                if (monitor && monitor->m_name == name)
                    return monitor;
            }
            return nullptr;
        }

        // "<monitor>:<id>,<id> ..." or nothing
        std::string take(std::string_view request) {
            request.remove_prefix(std::string_view{"kiwi-desktops"}.size());
            std::map<std::string, std::vector<WORKSPACEID>> kept;
            for (const auto& word : split(request, ' ')) {
                const auto COLON = word.rfind(':');
                if (COLON == std::string_view::npos || COLON == 0)
                    return "a monitor's desktops are <monitor>:<id>[,<id>...]";
                auto& ids = kept[std::string{word.substr(0, COLON)}];
                for (const auto& field : split(word.substr(COLON + 1), ',')) {
                    WORKSPACEID id = 0;
                    if (!parse(field, id) || id <= 0)
                        return "a desktop is a workspace id above 0";
                    ids.emplace_back(id);
                }
            }
            m_kept = std::move(kept);
            apply();
            return "ok";
        }
    };

    UP<CKiwiDesktops> g_kiwiDesktops;
}

namespace Kiwi::Desktops {
    bool init(HANDLE handle) {
        g_kiwiDesktops = makeUnique<CKiwiDesktops>();
        if (!g_kiwiDesktops->init(handle)) {
            g_kiwiDesktops.reset();
            return false;
        }
        return true;
    }

    void exit() {
        if (g_kiwiDesktops)
            g_kiwiDesktops->exit();
        g_kiwiDesktops.reset();
    }
}
