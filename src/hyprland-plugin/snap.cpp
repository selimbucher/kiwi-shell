// Snapping: a window dragged against an edge of the screen goes there, as on
// Windows and macOS. Against the left or right edge it is tiled on that side,
// by Hyprland's own tiling: next to the tiled window at that edge, at the
// pointer's height (the whole desktop when it is the first one tiled there);
// against the top it fills the desktop, a floating window still. While the
// pointer holds it there, where it will go shows under the window, coming
// out of it.
//
// The layout is the user's: a window tiled here is tiled as one tiled any
// other way, and goes on with whatever keybinds and rules the config has for
// tiled windows. Where it lands is worked out as dwindle (Hyprland's default
// layout) works it out; another layout puts it where that layout puts new
// windows, and the shape shown is only near it.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <SharedDefs.hpp>
#include <config/ConfigValue.hpp>
#include <config/shared/complex/ComplexDataTypes.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/Window.hpp>
#include <desktop/Workspace.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <layout/LayoutManager.hpp>
#include <layout/algorithm/Algorithm.hpp>
#include <layout/space/Space.hpp>
#include <layout/supplementary/DragController.hpp>
#include <layout/target/Target.hpp>
#include <managers/input/InputManager.hpp>
#include <output/Monitor.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/pass/PassElement.hpp>
#include <state/MonitorState.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <optional>

namespace {
    using Layout::Supplementary::CDragStateController;
    using Render::GL::g_pHyprOpenGL;

    constexpr auto MOUSE_MOVE = "Layout::Supplementary::CDragStateController::mouseMove(Hyprutils::Math::Vector2D const&)";
    constexpr auto DRAG_END   = "Layout::Supplementary::CDragStateController::dragEnd()";

    // the pointer this close to an edge of the screen is against it
    constexpr double EDGE = 3.0;
    // the shape coming out of the window, and going
    constexpr auto PREVIEW_IN  = std::chrono::milliseconds{180};
    constexpr auto PREVIEW_OUT = std::chrono::milliseconds{120};
    // logical: the shape's corners, and its edge
    constexpr double PREVIEW_ROUNDING = 12.0;
    constexpr int    PREVIEW_BORDER   = 1;

    enum eZone : uint8_t {
        ZONE_NONE,
        ZONE_LEFT,
        ZONE_RIGHT,
        ZONE_TOP,
    };

    CFunctionHook* g_moveHook = nullptr;
    CFunctionHook* g_endHook  = nullptr;

    // what the drag is against, and the shape shown for it
    struct SPreview {
        eZone           zone = ZONE_NONE;
        PHLWINDOWREF    window;
        PHLMONITORREF   monitor;
        CBox            from, to; // logical, global: the window's box as it got there, where it will go
        Time::steady_tp since;
        bool            leaving = false; // fading where it was, the drag gone off the edge or ended
    } g_preview;

    CHyprSignalListener g_stageListener;


    float progress() {
        const auto DURATION = g_preview.leaving ? PREVIEW_OUT : PREVIEW_IN;
        return std::clamp(std::chrono::duration<float>(Time::steadyNow() - g_preview.since).count() / std::chrono::duration<float>(DURATION).count(), 0.F, 1.F);
    }

    bool showing() {
        return g_preview.zone != ZONE_NONE || (g_preview.leaving && progress() < 1.F);
    }

    float easeOut(float t) {
        return 1.F - std::pow(1.F - t, 3.F);
    }

    // the shape now: growing out of the window, or fading where it was
    CBox shapeNow(float& alpha) {
        const float T = easeOut(progress());
        if (g_preview.leaving) {
            alpha = 1.F - T;
            return g_preview.to;
        }
        alpha = T;
        const auto& A = g_preview.from;
        const auto& B = g_preview.to;
        return CBox{A.x + (B.x - A.x) * T, A.y + (B.y - A.y) * T, A.w + (B.w - A.w) * T, A.h + (B.h - A.h) * T};
    }

    void damage() {
        auto box = g_preview.to.copy();
        if (!g_preview.leaving) {
            const double LEFT = std::min(box.x, g_preview.from.x), TOP = std::min(box.y, g_preview.from.y);
            const double RIGHT = std::max(box.x + box.w, g_preview.from.x + g_preview.from.w), BOTTOM = std::max(box.y + box.h, g_preview.from.y + g_preview.from.h);
            box = CBox{LEFT, TOP, RIGHT - LEFT, BOTTOM - TOP};
        }
        g_pHyprRenderer->damageBox(box.expand(PREVIEW_BORDER + 2));
    }

    class CSnapPreviewElement : public IPassElement {
      public:
        CSnapPreviewElement(CBox box, float alpha) : m_box(box), m_alpha(alpha) {}

        std::vector<UP<IPassElement>> draw() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (!MONITOR || m_alpha <= 0.F)
                return {};
            const double SCALE = MONITOR->m_scale;
            const CBox   BOX   = m_box.copy().translate(-MONITOR->m_position).scale(SCALE).round();
            const int    ROUND = std::round(PREVIEW_ROUNDING * SCALE);
            g_pHyprOpenGL->renderRect(BOX, CHyprColor(1.F, 1.F, 1.F, 0.14F * m_alpha), {.round = ROUND});
            g_pHyprOpenGL->renderBorder(BOX, Config::CGradientValueData(CHyprColor(1.F, 1.F, 1.F, 0.45F)),
                                        {.round = ROUND, .roundingPower = 2.F, .borderSize = PREVIEW_BORDER, .a = m_alpha});
            return {};
        }

        bool needsLiveBlur() override {
            return false;
        }

        bool needsPrecomputeBlur() override {
            return false;
        }

        const char* passName() override {
            return "CKiwiSnapPreviewElement";
        }

        ePassElementType type() override {
            return EK_CUSTOM;
        }

        std::optional<CBox> boundingBox() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (!MONITOR)
                return {};
            return m_box.copy().translate(-MONITOR->m_position).scale(MONITOR->m_scale).expand(PREVIEW_BORDER * MONITOR->m_scale + 2).round();
        }

      private:
        CBox  m_box;
        float m_alpha;
    };

    // ─── Where it would go ────────────────────────────────────────────────────

    double distance(const CBox& box, const Vector2D& point) {
        const double DX = std::max({box.x - point.x, 0.0, point.x - (box.x + box.w)});
        const double DY = std::max({box.y - point.y, 0.0, point.y - (box.y + box.h)});
        return std::hypot(DX, DY);
    }

    CBox goalBox(const PHLWINDOW& window) {
        return window->geometricBox(Desktop::View::IGeometric::GEOMETRIC_GOAL);
    }

    // where the window joins the layout: at the edge of the desktop's tiled
    // area, at the pointer's height
    Vector2D focalPoint(eZone zone, const CBox& area, const Vector2D& pointer) {
        return Vector2D{zone == ZONE_LEFT ? area.x + 1.0 : area.x + area.w - 1.0, std::clamp(pointer.y, area.y + 1.0, area.y + area.h - 1.0)};
    }

    // the tiled window there: the one dwindle will split for it
    PHLWINDOW tiledAt(const PHLWORKSPACE& workspace, const Vector2D& point, const PHLWINDOW& dragged) {
        PHLWINDOW nearest;
        double    best = std::numeric_limits<double>::max();
        for (const auto& w : Desktop::windowState()->windows()) {
            if (w == dragged || w->m_isFloating || !w->m_isMapped || w->isHidden() || w->m_workspace != workspace)
                continue;
            const double D = distance(goalBox(w), point);
            if (D < best) {
                best    = D;
                nearest = w;
            }
        }
        return nearest;
    }

    std::optional<CBox> destination(eZone zone, const PHLMONITOR& monitor, const PHLWINDOW& dragged, const Vector2D& pointer) {
        const auto WORKSPACE = monitor->m_activeWorkspace;
        if (!WORKSPACE || !WORKSPACE->m_space)
            return std::nullopt;
        // filling it, as a lone tiled window does
        const CBox AREA = WORKSPACE->m_space->workArea();
        if (zone == ZONE_TOP)
            return AREA;

        const auto NEIGHBOR = tiledAt(WORKSPACE, focalPoint(zone, AREA, pointer), dragged);
        if (!NEIGHBOR)
            return AREA;
        // half of it, the gap between the two taken out of the middle
        static auto PGAPSIN = CConfigValue<Config::IComplexConfigValue>("general:gaps_in");
        const auto* GAPS    = sc<Config::CCssGapData*>(PGAPSIN.ptr());
        const CBox  BOX     = goalBox(NEIGHBOR);
        const double GAP    = GAPS ? GAPS->m_left + GAPS->m_right : 0.0;
        const double HALF   = std::max(1.0, (BOX.w - GAP) / 2.0);
        return zone == ZONE_LEFT ? CBox{BOX.x, BOX.y, HALF, BOX.h} : CBox{BOX.x + BOX.w - HALF, BOX.y, HALF, BOX.h};
    }

    // ─── The drag ─────────────────────────────────────────────────────────────

    // which edge the pointer is against, if one with nothing beyond it (between
    // two displays, it is on its way to the other)
    eZone zoneAt(const PHLMONITOR& monitor, const Vector2D& pointer) {
        // (the query answers the nearest display for a point on none)
        const auto BEYOND = [&](double dx, double dy) {
            const auto POINT = pointer + Vector2D{dx, dy};
            const auto OTHER = State::monitorState()->query().vec(POINT).run();
            return OTHER && OTHER != monitor && CBox{OTHER->m_position, OTHER->m_size}.containsPoint(POINT);
        };
        const auto POS    = monitor->m_position;
        const auto SIZE   = monitor->m_size;
        if (pointer.x <= POS.x + EDGE && !BEYOND(-EDGE - 1, 0))
            return ZONE_LEFT;
        if (pointer.x >= POS.x + SIZE.x - EDGE && !BEYOND(EDGE + 1, 0))
            return ZONE_RIGHT;
        if (pointer.y <= POS.y + EDGE && !BEYOND(0, -EDGE - 1))
            return ZONE_TOP;
        return ZONE_NONE;
    }

    void leave() {
        if (g_preview.zone == ZONE_NONE)
            return;
        g_preview.zone    = ZONE_NONE;
        g_preview.leaving = true;
        g_preview.since   = Time::steadyNow();
        damage();
    }

    void hkMouseMove(CDragStateController* self, const Vector2D& pointer) {
        using FMouseMove = void (*)(CDragStateController*, const Vector2D&);
        reinterpret_cast<FMouseMove>(g_moveHook->m_original)(self, pointer);

        const auto TARGET = self->target();
        const auto WINDOW = TARGET ? TARGET->window() : nullptr;
        if (!WINDOW || self->mode() != MBIND_MOVE || !self->dragThresholdReached() || WINDOW->onSpecialWorkspace())
            return leave();
        const auto MONITOR = State::monitorState()->query().vec(pointer).run();
        if (!MONITOR || (MONITOR->m_activeSpecialWorkspace))
            return leave();

        const auto ZONE = zoneAt(MONITOR, pointer);
        if (ZONE == ZONE_NONE)
            return leave();
        const auto TO = destination(ZONE, MONITOR, WINDOW, pointer);
        if (!TO)
            return leave();
        if (ZONE == g_preview.zone && MONITOR == g_preview.monitor.lock() && *TO == g_preview.to)
            return;

        // out of the window, or on from where it was
        float      alpha = 0.F;
        const CBox FROM  = g_preview.zone != ZONE_NONE ? shapeNow(alpha) : goalBox(WINDOW);
        damage();
        g_preview = SPreview{.zone = ZONE, .window = WINDOW, .monitor = MONITOR, .from = FROM, .to = *TO, .since = Time::steadyNow()};
        damage();
    }

    // As Hyprland ends it (a window dragged out of tiling goes back into it
    // where the pointer is), then where the edge says.
    void hkDragEnd(CDragStateController* self) {
        using FDragEnd   = void (*)(CDragStateController*);
        const auto ZONE   = g_preview.zone;
        const auto TARGET = self->target();
        const bool MOVING = self->mode() == MBIND_MOVE;
        const auto POINTER = g_pInputManager->getMouseCoordsInternal();
        leave();

        // as it was before the drag took it out of tiling, or as it floated
        const auto SIZE = TARGET ? TARGET->position().size() : Vector2D{};
        reinterpret_cast<FDragEnd>(g_endHook->m_original)(self);

        if (ZONE == ZONE_NONE || !MOVING || !TARGET || !TARGET->window() || !TARGET->space())
            return;
        const auto SPACE     = TARGET->space();
        const auto ALGORITHM = SPACE->algorithm();
        if (!ALGORITHM)
            return;

        // The desktop filled as a lone tiled window fills it, its bar and all:
        // a floating window's box is what's inside them
        if (ZONE == ZONE_TOP) {
            if (!TARGET->floating())
                g_layoutManager->changeFloatingMode(TARGET);
            const auto RESERVED = TARGET->window()->getFullWindowReservedArea();
            CBox       box      = SPACE->workArea();
            box.x += RESERVED.topLeft.x;
            box.y += RESERVED.topLeft.y;
            box.w -= RESERVED.topLeft.x + RESERVED.bottomRight.x;
            box.h -= RESERVED.topLeft.y + RESERVED.bottomRight.y;
            g_layoutManager->setTargetGeom(box, TARGET);
            return;
        }

        // Tiled, next to the window at the edge: taken out of the layout and
        // put back in with that point for where (dwindle splits the tile
        // nearest it), on the edge's side
        if (TARGET->floating())
            TARGET->rememberFloatingSize(SIZE);
        (void)g_layoutManager->layoutMsg(ZONE == ZONE_LEFT ? "preselect l" : "preselect r");
        TARGET->setWasTiling(true);
        ALGORITHM->removeTarget(TARGET);
        TARGET->setFloating(false);
        ALGORITHM->moveTarget(TARGET, focalPoint(ZONE, SPACE->workArea(), POINTER));
        TARGET->setWasTiling(false);
        SPACE->recalculate();
    }

    CFunctionHook* hook(HANDLE handle, const char* name, const char* demangled, void* to) {
        for (const auto& fn : HyprlandAPI::findFunctionsByName(handle, name)) {
            if (fn.demangled != demangled)
                continue;
            const auto HOOK = HyprlandAPI::createFunctionHook(handle, fn.address, to);
            return HOOK && HOOK->hook() ? HOOK : nullptr;
        }
        return nullptr;
    }
}

namespace Kiwi::Snap {
    bool init(HANDLE handle) {
        g_moveHook = hook(handle, "mouseMove", MOUSE_MOVE, reinterpret_cast<void*>(&hkMouseMove));
        g_endHook  = hook(handle, "dragEnd", DRAG_END, reinterpret_cast<void*>(&hkDragEnd));
        if (!g_moveHook || !g_endHook) {
            if (g_moveHook)
                g_moveHook->unhook();
            if (g_endHook)
                g_endHook->unhook();
            g_moveHook = g_endHook = nullptr;
            return false;
        }
        // the shape's next frame while it comes or goes
        g_stageListener = Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
            if (stage == RENDER_POST && showing() && progress() < 1.F)
                damage();
        });
        return true;
    }

    void underWindow(const PHLWINDOW& window, const PHLMONITOR& monitor) {
        if (!showing() || window != g_preview.window.lock() || monitor != g_preview.monitor.lock())
            return;
        float      alpha = 0.F;
        const CBox BOX   = shapeNow(alpha);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CSnapPreviewElement>(BOX, alpha));
    }

    void exit() {
        g_stageListener.reset();
        g_moveHook = g_endHook = nullptr;
    }
}
