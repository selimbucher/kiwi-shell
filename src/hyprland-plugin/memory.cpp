// Memory: floating windows open where the app's window was last left.
//
// On macOS and Windows every app saves its own window frame and restores it at
// launch. Wayland apps can't: they may not position their own windows, so
// Hyprland opens each one centred at whatever size the app asks for, every
// time. The compositor keeps that memory instead:
//
//  - A window whose app has no other window on the workspace opens at the size
//    and position the app's window last had when it was closed. The position is
//    kept as a share of the free space, so a window at the right edge of one
//    screen opens at the right edge of a smaller one; the size shrinks to fit,
//    and it is kept off the edges of the screen and the shell's bars.
//  - Another window of an app already open on the workspace opens a title bar
//    down and right of it instead of exactly on top, the cascade of macOS and
//    Windows.
//  - A frame is remembered only once the user has moved or resized the window,
//    so splash screens and untouched extra windows don't overwrite it.
//
// Frames are kept per app (the window's initial class), across restarts, in
// $XDG_STATE_HOME/hypr/window-memory. Dialogs, X11 windows (which place
// themselves) and windows with a size, move or center rule are left alone.
//
// This was a plugin of its own, window-memory; where that is still loaded,
// this part stands aside rather than place every window twice.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <plugins/PluginSystem.hpp>
#include <desktop/view/Window.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/state/FocusState.hpp>
#include <desktop/Workspace.hpp>
#include <desktop/rule/windowRule/WindowRuleApplicator.hpp>
#include <layout/LayoutManager.hpp>
#include <layout/space/Space.hpp>
#include <managers/fullscreen/FullscreenController.hpp>
#include <render/decorations/IHyprWindowDecoration.hpp>
#include <render/decorations/DecorationPositioner.hpp>
#include <event/EventBus.hpp>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
    using Desktop::View::IGeometric;

    // About a title bar: the step between cascaded windows.
    constexpr double CASCADE_STEP = 28;
    // Closer than this counts as the same place.
    constexpr double TOLERANCE = 2;
    // A window never opens flush against an edge of the work area.
    constexpr double EDGE_GAP = 8;

    struct SFrame {
        double w = 0, h = 0;
        // Share (0..1) of the free space left of and above the window.
        double x = 0.5, y = 0.5;
    };

    struct STracked {
        PHLWINDOWREF window;
        CBox         placed; // where the window was when it had opened
    };

    std::string appOf(const PHLWINDOW& w) {
        return w->m_initialClass;
    }

    CBox boxOf(const PHLWINDOW& w) {
        return {w->position(IGeometric::GEOMETRIC_GOAL), w->size(IGeometric::GEOMETRIC_GOAL)};
    }

    bool near(double a, double b) {
        return std::abs(a - b) <= TOLERANCE;
    }

    bool near(const CBox& a, const CBox& b) {
        return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
    }

    // The room decorations (title bar, border) take around the window, summed
    // from the decorations themselves: Hyprland measures them only after
    // window.open.
    SBoxExtents extentsOf(const PHLWINDOW& w) {
        SBoxExtents ext;
        for (const auto& deco : w->m_windowDecorations) {
            const auto info = deco->getPositioningInfo();
            if (!info.reserved)
                continue;
            if (info.edges & DECORATION_EDGE_LEFT)
                ext.topLeft.x += info.desiredExtents.topLeft.x;
            if (info.edges & DECORATION_EDGE_TOP)
                ext.topLeft.y += info.desiredExtents.topLeft.y;
            if (info.edges & DECORATION_EDGE_RIGHT)
                ext.bottomRight.x += info.desiredExtents.bottomRight.x;
            if (info.edges & DECORATION_EDGE_BOTTOM)
                ext.bottomRight.y += info.desiredExtents.bottomRight.y;
        }
        return ext;
    }

    // Where a window may be put: the work area, kept off every edge. On a
    // small output the gap gives way rather than eat the screen.
    CBox placeArea(const PHLWINDOW& w) {
        const auto   area = w->m_workspace->m_space->workArea(true);
        const double gap  = std::min({EDGE_GAP, area.w / 8, area.h / 8});
        return {area.x + gap, area.y + gap, area.w - 2 * gap, area.h - 2 * gap};
    }

    // The room a window of this size leaves in the work area.
    Vector2D freeSpace(const CBox& area, const SBoxExtents& ext, const Vector2D& size) {
        return {area.w - ext.topLeft.x - ext.bottomRight.x - size.x, area.h - ext.topLeft.y - ext.bottomRight.y - size.y};
    }

    // Main windows only: no dialogs, X11 or rule-placed windows.
    bool eligible(const PHLWINDOW& w) {
        if (!w || w->m_isX11 || !w->m_isFloating || appOf(w).empty())
            return false;
        if (w->parent() || w->isModal())
            return false;
        if (!w->m_workspace || !w->m_workspace->m_space || !w->layoutTarget())
            return false;

        const auto& rules = w->m_ruleApplicator->static_;
        return !rules.size && !rules.position && !rules.center.value_or(false);
    }

    // The app's other main windows on the same workspace.
    std::vector<PHLWINDOW> siblingsOf(const PHLWINDOW& w) {
        std::vector<PHLWINDOW> siblings;
        for (const auto& other : Desktop::windowState()->windows()) {
            if (other == w || !other->m_isMapped || other->isHidden() || !other->m_isFloating || other->parent() || other->isModal())
                continue;
            if (other->m_workspace == w->m_workspace && appOf(other) == appOf(w))
                siblings.push_back(other);
        }
        return siblings;
    }

    void fitSize(const PHLWINDOW& w, CBox& box, const CBox& area, const SBoxExtents& ext) {
        box.w = std::min(box.w, area.w - ext.topLeft.x - ext.bottomRight.x);
        box.h = std::min(box.h, area.h - ext.topLeft.y - ext.bottomRight.y);
        if (const auto max = w->maxSize()) {
            box.w = std::min(box.w, max->x);
            box.h = std::min(box.h, max->y);
        }
        if (const auto min = w->minSize()) {
            box.w = std::max(box.w, min->x);
            box.h = std::max(box.h, min->y);
        }
    }

    CBox restore(const PHLWINDOW& w, const SFrame& frame, const CBox& area, const SBoxExtents& ext) {
        CBox box{0, 0, frame.w, frame.h};
        fitSize(w, box, area, ext);
        const auto room = freeSpace(area, ext, box.size());
        box.x           = area.x + ext.topLeft.x + std::max(0.0, room.x) * frame.x;
        box.y           = area.y + ext.topLeft.y + std::max(0.0, room.y) * frame.y;
        return box;
    }

    CBox cascade(const PHLWINDOW& w, const std::vector<PHLWINDOW>& siblings, CBox box, const CBox& area, const SBoxExtents& ext) {
        // The new window isn't focused yet: step from the one the user was in
        // if it's the app's, else from the app's newest.
        auto anchor = siblings.back();
        if (const auto focused = Desktop::focusState()->window(); std::ranges::find(siblings, focused) != siblings.end())
            anchor = focused;

        fitSize(w, box, area, ext);

        auto pos = anchor->position(IGeometric::GEOMETRIC_GOAL) + Vector2D{CASCADE_STEP, CASCADE_STEP};
        // Skip spots another of the app's windows already sits on, and start
        // again at the top left when the window would leave the work area.
        for (size_t i = 0; i <= siblings.size(); ++i) {
            if (pos.x + box.w + ext.bottomRight.x > area.x + area.w || pos.y + box.h + ext.bottomRight.y > area.y + area.h)
                pos = {area.x + ext.topLeft.x, area.y + ext.topLeft.y};

            const bool taken = std::ranges::any_of(siblings, [&](const PHLWINDOW& s) {
                const auto p = s->position(IGeometric::GEOMETRIC_GOAL);
                return near(p.x, pos.x) && near(p.y, pos.y);
            });
            if (!taken)
                break;

            pos = pos + Vector2D{CASCADE_STEP, CASCADE_STEP};
        }

        box.x = pos.x;
        box.y = pos.y;
        return box;
    }

    std::filesystem::path stateFile() {
        const char*           state = std::getenv("XDG_STATE_HOME");
        const char*           home  = std::getenv("HOME");
        std::filesystem::path base  = state && *state ? std::filesystem::path(state) : std::filesystem::path(home ? home : "") / ".local/state";
        return base / "hypr" / "window-memory";
    }

    // Locale-independent, unlike streams and stod.
    std::string format(double v) {
        char buf[32];
        const auto [end, ec] = std::to_chars(buf, buf + sizeof(buf), v);
        return ec == std::errc{} ? std::string(buf, end) : "0";
    }

    bool parse(const std::string& s, double& v) {
        const auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), v);
        return ec == std::errc{} && end == s.data() + s.size() && std::isfinite(v);
    }

    // the plugin this part used to be, loaded as well
    bool standingAside() {
        if (!g_pPluginSystem)
            return false;
        return std::ranges::any_of(g_pPluginSystem->getAllPlugins(), [](const CPlugin* p) { return p && p->m_name == "window-memory"; });
    }

    class CWindowMemory {
      public:
        void init() {
            load();
            m_openListener     = Event::bus()->m_events.window.open.listen([this](PHLWINDOW w) { place(w); });
            m_openLateListener = Event::bus()->m_events.window.openLate.listen([this](PHLWINDOW w) { track(w); });
            m_closeListener    = Event::bus()->m_events.window.close.listen([this](PHLWINDOW w) { closed(w); });
            m_exitListener     = Event::bus()->m_events.exit.listen([this]() { rememberOpen(); });
        }

        void exit() {
            m_openListener.reset();
            m_openLateListener.reset();
            m_closeListener.reset();
            m_exitListener.reset();
            rememberOpen();
            m_tracked.clear();
        }

      private:
        std::map<std::string, SFrame>                              m_frames;
        std::unordered_map<Desktop::View::CWindow*, STracked>      m_tracked;
        CHyprSignalListener                                        m_openListener, m_openLateListener, m_closeListener, m_exitListener;

        // window.open comes after Hyprland has placed the window and before it
        // is animated in, so the window appears in its final place.
        void place(const PHLWINDOW& w) {
            if (!eligible(w) || standingAside())
                return;

            const auto area = placeArea(w);
            const auto ext  = extentsOf(w);
            const auto from = boxOf(w);
            CBox       box;

            if (const auto siblings = siblingsOf(w); !siblings.empty())
                box = cascade(w, siblings, from, area, ext);
            else if (const auto frame = m_frames.find(appOf(w)); frame != m_frames.end())
                box = restore(w, frame->second, area, ext);
            else
                return;

            box.round();
            if (!near(box, from))
                g_layoutManager->setTargetGeom(box, w->layoutTarget());
        }

        // The frame a window opened with, to tell later whether the user moved
        // or resized it.
        void track(const PHLWINDOW& w) {
            if (eligible(w) && !standingAside())
                m_tracked[w.get()] = {.window = w, .placed = boxOf(w)};
        }

        void closed(const PHLWINDOW& w) {
            const auto it = m_tracked.find(w.get());
            if (it == m_tracked.end())
                return;

            const auto tracked = it->second;
            m_tracked.erase(it);

            // A slot left by a dead window at a reused address.
            if (tracked.window.lock() != w)
                return;

            if (remember(w, tracked.placed) && !standingAside())
                save();
        }

        // Windows still open when Hyprland exits.
        void rememberOpen() {
            bool changed = false;
            for (auto& [_, tracked] : m_tracked) {
                const auto w = tracked.window.lock();
                if (w && remember(w, tracked.placed)) {
                    tracked.placed = boxOf(w);
                    changed        = true;
                }
            }
            if (changed && !standingAside())
                save();
        }

        bool remember(const PHLWINDOW& w, const CBox& placed) {
            // Tiled, fullscreen or maximised: the floating frame isn't what's
            // on screen, so keep the old one.
            if (!w->m_isFloating || Fullscreen::controller()->isFullscreen(w) || !w->m_workspace || !w->m_workspace->m_space)
                return false;

            // Snapped (to a half, a quarter, the whole screen): the frame is
            // the snap's, not the app's. It is kept at the size the window
            // had before, around where it was; with none of its own known,
            // the old one is kept.
            auto box = boxOf(w);
            if (const auto BEFORE = Kiwi::Snap::sizeBefore(w)) {
                if (near(BEFORE->x, box.w) && near(BEFORE->y, box.h))
                    return false;
                box = CBox{box.middle() - *BEFORE / 2.0, *BEFORE};
            }
            if (near(box, placed))
                return false;

            const auto app = appOf(w);
            if (app.find_first_of("\t\n") != std::string::npos)
                return false;

            const auto area  = placeArea(w);
            const auto ext   = extentsOf(w);
            const auto room  = freeSpace(area, ext, box.size());
            const auto share = [](double offset, double room) { return room > 0 ? std::clamp(offset / room, 0.0, 1.0) : 0.5; };

            m_frames[app] = {
                .w = box.w,
                .h = box.h,
                .x = share(box.x - area.x - ext.topLeft.x, room.x),
                .y = share(box.y - area.y - ext.topLeft.y, room.y),
            };
            return true;
        }

        // One line per app: class, width, height, x share, y share, tab-separated.
        void load() {
            std::ifstream in(stateFile());
            std::string   line;
            while (std::getline(in, line)) {
                std::vector<std::string> fields;
                size_t                   start = 0;
                for (size_t tab; (tab = line.find('\t', start)) != std::string::npos; start = tab + 1)
                    fields.push_back(line.substr(start, tab - start));
                fields.push_back(line.substr(start));

                SFrame frame;
                if (fields.size() == 5 && !fields[0].empty() && parse(fields[1], frame.w) && parse(fields[2], frame.h) && parse(fields[3], frame.x) &&
                    parse(fields[4], frame.y) && frame.w > 0 && frame.h > 0)
                    m_frames[fields[0]] = frame;
            }
        }

        void save() {
            const auto      path = stateFile();
            std::error_code ec;
            std::filesystem::create_directories(path.parent_path(), ec);

            const auto tmp = path.string() + ".tmp";
            {
                std::ofstream out(tmp, std::ios::trunc);
                for (const auto& [app, f] : m_frames)
                    out << app << '\t' << format(f.w) << '\t' << format(f.h) << '\t' << format(f.x) << '\t' << format(f.y) << '\n';
                if (!out)
                    return;
            }
            std::filesystem::rename(tmp, path, ec);
        }
    };

    UP<CWindowMemory> g_windowMemory;
}

namespace Kiwi::Memory {
    bool init(HANDLE) {
        g_windowMemory = makeUnique<CWindowMemory>();
        g_windowMemory->init();
        return true;
    }

    void exit() {
        if (g_windowMemory)
            g_windowMemory->exit();
        g_windowMemory.reset();
    }
}
