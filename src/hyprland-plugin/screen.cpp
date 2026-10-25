// Screen: whether anything on it is seen. Hyprland's event socket says neither
// when the session locks nor when a display is switched off (DPMS), and the
// shell keeps some things going only for the eye — the island's music bars
// listen to the speakers thirty times a second. So it is told here:
//
//     kiwiscreen>>locked
//     kiwiscreen>>unlocked
//     kiwiscreen>>dpms,<monitor>,0|1

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <event/EventBus.hpp>
#include <managers/EventManager.hpp>
#include <managers/SessionLockManager.hpp>
#include <output/Monitor.hpp>
#include <state/MonitorState.hpp>

#include <format>
#include <vector>

namespace {
    CHyprSignalListener g_lockListener;
    CHyprSignalListener g_unlockListener;
    CHyprSignalListener g_monitorListener;

    struct SWatched {
        PHLMONITORREF       monitor;
        CHyprSignalListener dpms;
    };
    std::vector<SWatched> g_watched;

    void post(const std::string& data) {
        g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwiscreen", .data = data});
    }

    void watch(const PHLMONITOR& monitor) {
        std::erase_if(g_watched, [&](const SWatched& w) { return w.monitor.expired() || w.monitor == monitor; });
        g_watched.emplace_back(SWatched{
            .monitor = monitor,
            .dpms    = monitor->m_events.dpmsChanged.listen([weak = PHLMONITORREF{monitor}] {
                if (const auto MONITOR = weak.lock())
                    post(std::format("dpms,{},{}", MONITOR->m_name, MONITOR->m_dpmsStatus ? 1 : 0));
            }),
        });
    }
}

namespace Kiwi::Screen {
    bool init(HANDLE) {
        if (!g_pSessionLockManager)
            return false;
        g_lockListener   = g_pSessionLockManager->m_events.lock.listen([] { post("locked"); });
        g_unlockListener = g_pSessionLockManager->m_events.unlock.listen([] { post("unlocked"); });
        for (const auto& monitor : State::monitorState()->monitors())
            watch(monitor);
        g_monitorListener = Event::bus()->m_events.monitor.newMon.listen([](PHLMONITOR monitor) { watch(monitor); });
        return true;
    }

    void exit() {
        g_lockListener.reset();
        g_unlockListener.reset();
        g_monitorListener.reset();
        g_watched.clear();
    }
}
