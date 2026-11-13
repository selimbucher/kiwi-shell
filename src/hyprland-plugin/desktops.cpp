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
// for when it is: meanwhile only the ones with windows stay, wherever
// Hyprland has carried them, and the rest are made again when it connects.
// It then shows the desktop it showed when it went, which Hyprland does
// itself only when that workspace was still there.
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
#include <workspace/HLWorkspace.hpp>
#include <workspace/RegularWorkspace.hpp>
#include <ipc/s1/S1.hpp>
#include <config/ConfigValue.hpp>
#include <event/EventBus.hpp>
#include <ipc/s2/S2.hpp>
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
#include <utility>
#include <vector>

namespace {
    using Kiwi::parse;
    using Kiwi::split;

    class CKiwiDesktops {
      public:
        bool init(HANDLE handle) {
            m_command = HyprlandAPI::registerHyprCtlCommand(handle,
                                                            IPC::Socket1::SCommand{
                                                                .name    = "kiwi-desktops",
                                                                .match   = IPC::Socket1::COMMAND_MATCH_PREFIX,
                                                                .handler = [this](const IPC::Socket1::SRequest& request) -> IPC::Socket1::SResponse { return take(request.command); },
                                                            });
            if (!m_command)
                return false;

            // after the reload has taken persistence away, not before
            m_refreshedListener = Event::bus()->m_events.config.props_refreshed.listen([this](bool) { applySoon(); });
            m_monitorListener   = Event::bus()->m_events.monitor.added.listen([this](PHLMONITOR monitor) {
                m_connected.emplace_back(monitor);
                applySoon();
            });
            // Hyprland keeps what a display showed when it went, but no longer
            // tells: remember it here, as it did, before its workspaces move
            m_goneListener = Event::bus()->m_events.monitor.preRemoved.listen([this](PHLMONITOR monitor) {
                if (monitor && monitor->m_enabled && monitor->m_activeWorkspace) {
                    if (const auto ID = monitor->m_activeWorkspace->numberedID())
                        m_remembered[monitor->m_name] = *ID;
                }
            });
            m_frameListener     = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) { tellSlide(monitor); });
            return true;
        }

        void exit() {
            m_connected.clear();
            m_refreshedListener.reset();
            m_monitorListener.reset();
            m_goneListener.reset();
            m_frameListener.reset();
            m_command.reset();
            m_kept.clear();
            release({});
        }

      private:
        // the desktops by monitor name, in the shell's order
        std::map<std::string, std::vector<Workspace::WorkspaceIDContainer>> m_kept;
        // the desktop each display showed when it was disconnected
        std::map<std::string, Workspace::WorkspaceIDContainer> m_remembered;
        // the workspaces marked persistent here
        std::vector<PHLWORKSPACEREF> m_ours;
        // monitors connected since the set was last applied
        std::vector<PHLMONITORREF> m_connected;
        SP<IPC::Socket1::SCommand>   m_command;
        CHyprSignalListener          m_refreshedListener, m_monitorListener, m_goneListener, m_frameListener;
        // where each display's slide was last told to be, by monitor name
        // (a workspace by the name Hyprland's own events give it)
        std::map<std::string, std::pair<std::string, double>> m_slides;

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
            // (at rest is said even after a step smaller than that: the shell
            // follows the slide until it hears it is over)
            const auto&  NAME     = WS->addressableName();
            if (last.first == NAME && (FRACTION == last.second || (FRACTION != 0.0 && std::abs(last.second - FRACTION) < 1e-4)))
                return;
            const bool MOVED = last.first != NAME || FRACTION != 0.0 || last.second != 0.0;
            last             = {NAME, FRACTION};
            if (MOVED)
                IPC::Socket2::sock()->postEvent(IPC::Socket2::SEvent{.event = "kiwidesk", .data = std::format("{},{},{:.4f}", monitor->m_name, NAME, FRACTION)});
        }
        bool                         m_applying = false;

        void applySoon() {
            if (m_applying)
                return;
            m_applying = true;
            g_pEventLoopManager->doLater([this] {
                m_applying = false;
                apply();
                for (const auto& ref : std::exchange(m_connected, {})) {
                    if (const auto MONITOR = ref.lock())
                        showRemembered(MONITOR);
                }
            });
        }

        void showRemembered(const PHLMONITOR& monitor) {
            const auto REMEMBERED = m_remembered.find(monitor->m_name);
            const auto KEPT       = m_kept.find(monitor->m_name);
            if (REMEMBERED == m_remembered.end() || KEPT == m_kept.end() || !std::ranges::contains(KEPT->second, REMEMBERED->second))
                return;
            const auto ID = REMEMBERED->second;
            if (monitor->m_activeWorkspace && monitor->m_activeWorkspace->numberedID() == ID)
                return;
            const auto WORKSPACE = State::workspaceState()->query().numbered(Workspace::SWorkspaceNumberedID{ID}).run();
            if (WORKSPACE && WORKSPACE->m_monitor == monitor)
                monitor->changeWorkspace(WORKSPACE, false, true, true);
        }

        void apply() {
            std::vector<PHLWORKSPACE> kept;
            for (const auto& [name, ids] : m_kept) {
                const auto MONITOR = monitorNamed(name);
                if (!MONITOR)
                    continue;
                for (const auto ID : ids) {
                    auto workspace = State::workspaceState()->query().numbered(Workspace::SWorkspaceNumberedID{ID}).run();
                    // one on another monitor now was moved there: it stays
                    // where it was put, and the shell hears of it there
                    if (!workspace) {
                        workspace = State::workspaceState()->createNumbered(Workspace::SWorkspaceNumberedID{ID}, MONITOR, "", false);
                        if (workspace)
                            workspace->ready();
                    }
                    const auto REGULAR = dynamicPointerCast<Workspace::CRegularWorkspace>(workspace);
                    if (!REGULAR)
                        continue;
                    REGULAR->setPersistent(true);
                    kept.emplace_back(workspace);
                }
            }
            release(kept);
        }

        // lets go of every workspace kept here that isn't in `kept`
        void release(const std::vector<PHLWORKSPACE>& kept) {
            for (const auto& ref : m_ours) {
                const auto WORKSPACE = ref.lock();
                if (const auto REGULAR = dynamicPointerCast<Workspace::CRegularWorkspace>(WORKSPACE); REGULAR && std::ranges::find(kept, WORKSPACE) == kept.end())
                    REGULAR->setPersistent(false);
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
            std::map<std::string, std::vector<Workspace::WorkspaceIDContainer>> kept;
            for (const auto& word : split(request, ' ')) {
                const auto COLON = word.rfind(':');
                if (COLON == std::string_view::npos || COLON == 0)
                    return "a monitor's desktops are <monitor>:<id>[,<id>...]";
                auto& ids = kept[std::string{word.substr(0, COLON)}];
                for (const auto& field : split(word.substr(COLON + 1), ',')) {
                    Workspace::WorkspaceIDContainer id = 0;
                    if (!parse(field, id) || id == 0)
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
