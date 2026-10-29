// Snapping, as on macOS (Sequoia): a window dragged against an edge of the
// screen goes there. Against the left or right edge it takes that half of
// the desktop, against a corner a quarter, against the top all of it; while
// the pointer holds it there, where it will go shows under the window, coming
// out of it. Dragged away again it gets back the size it had, held where it
// was taken. So does a tiled window: dragged by its bar it comes out of the
// tiling at the size it had before, where Hyprland would move it to another
// tile (as a drag with a modifier held still does).
//
// Hyprland's tiling is the user's, and stays. On a desktop with tiled
// windows, a window snapped to a side or a corner joins the tiling there,
// next to the tile at that edge (a side splits that tile across, a corner
// from top to bottom), as one tiled any other way, and goes on with whatever
// keybinds and rules the config has for tiled windows. On a desktop with none
// it floats at its half or quarter, the gaps the tiling would leave left. A
// window filling the desktop floats either way. Where a tiled one lands is
// worked out as dwindle (Hyprland's default layout) works it out; another
// layout puts it where that layout puts new windows, and the shape shown is
// only near it.
//
// A window snapped to a half, floating, leaves the other half free, and the
// shell is told where:
//
//     kiwisnapped>><address>,left|right,<monitor>,<x>,<y>,<w>,<h>
//
// It may offer the desktop's other windows for it, as macOS's Split View
// does, and puts the one picked there with
//
//     hyprctl kiwi-snap 0x<address> left|right|top|top-left|top-right|bottom-left|bottom-right [<x>,<y>,<w>,<h>]
//
// A tiled window minimized and brought back goes back into the tiling where
// it was (dwindle alone splits whichever tile the pointer is over, the Dock's
// at that moment), or floats where it was when its desktop has no tiling left.

#include "kiwi.hpp"
#include "requests.hpp"

#include <plugins/PluginAPI.hpp>
#include <SharedDefs.hpp>
#include <config/ConfigValue.hpp>
#include <config/shared/complex/ComplexDataTypes.hpp>
#include <desktop/state/FocusState.hpp>
#include <desktop/state/ViewHitTester.hpp>
#include <desktop/state/ViewState.hpp>
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
#include <managers/EventManager.hpp>
#include <managers/eventLoop/EventLoopManager.hpp>
#include <managers/fullscreen/FullscreenController.hpp>
#include <managers/input/InputManager.hpp>
#include <managers/SessionLockManager.hpp>
#include <pointer/cursor/CursorShapeOverrideController.hpp>
#include <output/Monitor.hpp>
#include <protocols/LayerShell.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/pass/PassElement.hpp>
#include <state/MonitorState.hpp>

#include <linux/input-event-codes.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <format>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {
    using Layout::Supplementary::CDragStateController;
    using Render::GL::g_pHyprOpenGL;

    constexpr auto MOUSE_MOVE         = "Layout::Supplementary::CDragStateController::mouseMove(Hyprutils::Math::Vector2D const&)";
    constexpr auto DRAG_END           = "Layout::Supplementary::CDragStateController::dragEnd()";
    constexpr auto UPDATE_DRAG_WINDOW = "Layout::Supplementary::CDragStateController::updateDragWindow()";
    constexpr auto DRAG_BEGIN         = "Layout::Supplementary::CDragStateController::dragBegin(Hyprutils::Memory::CSharedPointer<Layout::ITarget>, eMouseBindMode, "
                                        "std::optional<Layout::eRectCorner>, bool)";

    // the pointer this close to an edge of the screen is against it
    constexpr double EDGE = 3.0;
    // against an edge this near a corner (a share of the display's shorter
    // side), it is in the corner
    constexpr double CORNER_SHARE = 0.125;
    // the pointer this far from where it took a snapped or tiled window
    // takes it away; nearer, a click on its bar leaves it where it is
    constexpr double TAKE_AWAY = 6.0;
    // the shape coming out of the window, and going
    constexpr auto PREVIEW_IN  = std::chrono::milliseconds{180};
    constexpr auto PREVIEW_OUT = std::chrono::milliseconds{120};
    // logical: the shape's corners, and its edge
    constexpr double PREVIEW_ROUNDING = 12.0;
    constexpr int    PREVIEW_BORDER   = 1;
    // Hyprland's size for a floating window with nothing better to go by
    // (DefaultFloatingAlgorithm)
    constexpr Vector2D DEFAULT_SIZE = {640, 400};

    enum eZone : uint8_t {
        ZONE_NONE,
        ZONE_LEFT,
        ZONE_RIGHT,
        ZONE_TOP,
        ZONE_TOP_LEFT,
        ZONE_TOP_RIGHT,
        ZONE_BOTTOM_LEFT,
        ZONE_BOTTOM_RIGHT,
    };

    constexpr std::array<std::pair<eZone, const char*>, 7> ZONE_NAMES = {{
        {ZONE_LEFT, "left"},
        {ZONE_RIGHT, "right"},
        {ZONE_TOP, "top"},
        {ZONE_TOP_LEFT, "top-left"},
        {ZONE_TOP_RIGHT, "top-right"},
        {ZONE_BOTTOM_LEFT, "bottom-left"},
        {ZONE_BOTTOM_RIGHT, "bottom-right"},
    }};

    bool onLeft(eZone zone) {
        return zone == ZONE_LEFT || zone == ZONE_TOP_LEFT || zone == ZONE_BOTTOM_LEFT;
    }

    bool isCorner(eZone zone) {
        return zone >= ZONE_TOP_LEFT;
    }

    bool onTop(eZone zone) {
        return zone == ZONE_TOP_LEFT || zone == ZONE_TOP_RIGHT;
    }

    CFunctionHook* g_moveHook   = nullptr;
    CFunctionHook* g_endHook    = nullptr;
    CFunctionHook* g_updateHook = nullptr;
    CFunctionHook* g_layerHook  = nullptr;
    CFunctionHook* g_beginHook  = nullptr;

    SP<SHyprCtlCommand> g_command;

    // ─── What Hyprland keeps of a drag to itself ──────────────────────────────
    // A window given another size under the pointer is dragged on from there.
    // (An explicit instantiation may name a private member; the friend hands
    // it out.)

    template <typename Tag, typename Tag::type M>
    struct SDragField {
        friend typename Tag::type field(Tag) {
            return M;
        }
    };
    struct SBeginPointer {
        using type = Vector2D CDragStateController::*;
        friend type field(SBeginPointer);
    };
    struct SLastPointer {
        using type = Vector2D CDragStateController::*;
        friend type field(SLastPointer);
    };
    struct SBeginPosition {
        using type = Vector2D CDragStateController::*;
        friend type field(SBeginPosition);
    };
    struct SBeginSize {
        using type = Vector2D CDragStateController::*;
        friend type field(SBeginSize);
    };
    struct SThresholdReached {
        using type = bool CDragStateController::*;
        friend type field(SThresholdReached);
    };
    struct SDraggingTiled {
        using type = bool CDragStateController::*;
        friend type field(SDraggingTiled);
    };
    template struct SDragField<SBeginPointer, &CDragStateController::m_beginDragXY>;
    template struct SDragField<SLastPointer, &CDragStateController::m_lastDragXY>;
    template struct SDragField<SBeginPosition, &CDragStateController::m_beginDragPositionXY>;
    template struct SDragField<SBeginSize, &CDragStateController::m_beginDragSizeXY>;
    template struct SDragField<SThresholdReached, &CDragStateController::m_dragThresholdReached>;
    template struct SDragField<SDraggingTiled, &CDragStateController::m_draggingTiled>;
    // which of a window's edges the pointer is on, as its shape shows it
    struct SBorderIcon {
        using type = eBorderIconDirection CInputManager::*;
        friend type field(SBorderIcon);
    };
    template struct SDragField<SBorderIcon, &CInputManager::m_borderIconDirection>;

    // ─── Boxes ────────────────────────────────────────────────────────────────

    double distance(const CBox& box, const Vector2D& point) {
        const double DX = std::max({box.x - point.x, 0.0, point.x - (box.x + box.w)});
        const double DY = std::max({box.y - point.y, 0.0, point.y - (box.y + box.h)});
        return std::hypot(DX, DY);
    }

    bool sameBox(const CBox& a, const CBox& b) {
        return std::abs(a.x - b.x) < 1 && std::abs(a.y - b.y) < 1 && std::abs(a.w - b.w) < 1 && std::abs(a.h - b.h) < 1;
    }

    // the window itself, without its bar and borders
    CBox goalBox(const PHLWINDOW& window) {
        return window->geometricBox(Desktop::View::IGeometric::GEOMETRIC_GOAL);
    }

    // the window with its bar and borders: what is seen as the window
    CBox outerOf(const CBox& inner, const PHLWINDOW& window) {
        const auto R = window->getFullWindowReservedArea();
        return CBox{inner.x - R.topLeft.x, inner.y - R.topLeft.y, inner.w + R.topLeft.x + R.bottomRight.x, inner.h + R.topLeft.y + R.bottomRight.y};
    }

    CBox innerOf(const CBox& outer, const PHLWINDOW& window) {
        const auto R = window->getFullWindowReservedArea();
        return CBox{outer.x + R.topLeft.x, outer.y + R.topLeft.y, outer.w - R.topLeft.x - R.bottomRight.x, outer.h - R.topLeft.y - R.bottomRight.y};
    }

    Config::CCssGapData gapsIn() {
        static auto PGAPSIN = CConfigValue<Config::IComplexConfigValue>("general:gaps_in");
        const auto* GAPS    = sc<Config::CCssGapData*>(PGAPSIN.ptr());
        return GAPS ? *GAPS : Config::CCssGapData{};
    }

    // A part of the desktop's work area as Hyprland's tiling lays a window
    // into it: the gap between tiles on each side that isn't the area's edge
    // (WindowTarget::updatePos). The window there, with its bar.
    CBox tileIn(const CBox& part, const CBox& area) {
        const auto GAPS   = gapsIn();
        const auto STICKS = [](double a, double b) { return std::abs(a - b) < 2; };
        const double LEFT = STICKS(part.x, area.x) ? 0 : GAPS.m_left, TOP = STICKS(part.y, area.y) ? 0 : GAPS.m_top;
        const double RIGHT = STICKS(part.x + part.w, area.x + area.w) ? 0 : GAPS.m_right, BOTTOM = STICKS(part.y + part.h, area.y + area.h) ? 0 : GAPS.m_bottom;
        return CBox{part.x + LEFT, part.y + TOP, part.w - LEFT - RIGHT, part.h - TOP - BOTTOM}.round();
    }

    // where macOS puts a window snapped to `zone`, in the work area
    CBox zoneIn(eZone zone, const CBox& area) {
        const double HALF_W = std::round(area.w / 2.0), HALF_H = std::round(area.h / 2.0);
        const double X = onLeft(zone) ? area.x : area.x + HALF_W, W = onLeft(zone) ? HALF_W : area.w - HALF_W;
        const double Y = onTop(zone) ? area.y : area.y + HALF_H, H = onTop(zone) ? HALF_H : area.h - HALF_H;
        switch (zone) {
            case ZONE_TOP: return tileIn(area, area);
            case ZONE_LEFT:
            case ZONE_RIGHT: return tileIn(CBox{X, area.y, W, area.h}, area);
            default: return tileIn(CBox{X, Y, W, H}, area);
        }
    }

    // ─── Where it goes ────────────────────────────────────────────────────────

    bool tiledHere(const PHLWINDOW& w, const PHLWORKSPACE& workspace, const PHLWINDOW& but) {
        return w != but && !w->m_isFloating && w->m_isMapped && !w->isHidden() && w->m_workspace == workspace;
    }

    bool anyTiled(const PHLWORKSPACE& workspace, const PHLWINDOW& but) {
        return std::ranges::any_of(Desktop::windowState()->windows(), [&](const auto& w) { return tiledHere(w, workspace, but); });
    }

    // the tiled window nearest a point: the one dwindle will split there
    PHLWINDOW tiledAt(const PHLWORKSPACE& workspace, const Vector2D& point, const PHLWINDOW& but) {
        PHLWINDOW nearest;
        double    best = std::numeric_limits<double>::max();
        for (const auto& w : Desktop::windowState()->windows()) {
            if (!tiledHere(w, workspace, but))
                continue;
            const double D = distance(goalBox(w), point);
            if (D < best) {
                best    = D;
                nearest = w;
            }
        }
        return nearest;
    }

    // where a window joins the tiling: a side's edge at the pointer's height,
    // or the corner
    Vector2D focalPoint(eZone zone, const CBox& area, const Vector2D& pointer) {
        const double X = onLeft(zone) ? area.x + 1.0 : area.x + area.w - 1.0;
        if (!isCorner(zone))
            return Vector2D{X, std::clamp(pointer.y, area.y + 1.0, area.y + area.h - 1.0)};
        return Vector2D{X, onTop(zone) ? area.y + 1.0 : area.y + area.h - 1.0};
    }

    struct SPlace {
        CBox         outer;           // where the window goes, with its bar: the shape shown
        bool         tiled = false;   // into the desktop's tiling...
        PHLWINDOWREF beside;          // ...next to this tile (none: the first)
        Vector2D     focal;           // ...found there
        const char*  side = nullptr;  // dwindle's preselect for it
    };

    std::optional<SPlace> placeFor(eZone zone, const PHLWORKSPACE& workspace, const PHLWINDOW& window, const Vector2D& pointer) {
        if (zone == ZONE_NONE || !workspace || !workspace->m_space)
            return std::nullopt;
        const CBox AREA = workspace->m_space->workArea();
        if (zone == ZONE_TOP || !anyTiled(workspace, window))
            return SPlace{.outer = zoneIn(zone, AREA)};

        // next to the tile there: half of it, the gap between the two taken
        // out of the middle, across for a side, from top to bottom for a corner
        const auto FOCAL    = focalPoint(zone, AREA, pointer);
        const auto NEIGHBOR = tiledAt(workspace, FOCAL, window);
        if (!NEIGHBOR)
            return SPlace{.outer = zoneIn(zone, AREA)};
        const auto  GAPS = gapsIn();
        const CBox  BOX  = outerOf(goalBox(NEIGHBOR), NEIGHBOR);
        SPlace      place{.tiled = true, .beside = NEIGHBOR, .focal = FOCAL};
        if (!isCorner(zone)) {
            const double HALF = std::max(1.0, std::round((BOX.w - GAPS.m_left - GAPS.m_right) / 2.0));
            place.outer       = onLeft(zone) ? CBox{BOX.x, BOX.y, HALF, BOX.h} : CBox{BOX.x + BOX.w - HALF, BOX.y, HALF, BOX.h};
            place.side        = onLeft(zone) ? "l" : "r";
        } else {
            const double HALF = std::max(1.0, std::round((BOX.h - GAPS.m_top - GAPS.m_bottom) / 2.0));
            place.outer       = onTop(zone) ? CBox{BOX.x, BOX.y, BOX.w, HALF} : CBox{BOX.x, BOX.y + BOX.h - HALF, BOX.w, HALF};
            place.side        = onTop(zone) ? "u" : "d";
        }
        return place;
    }

    // which edge or corner the pointer is against, if one with nothing
    // beyond it (between two displays, it is on its way to the other)
    eZone zoneAt(const PHLMONITOR& monitor, const Vector2D& pointer) {
        // (the query answers the nearest display for a point on none)
        const auto BEYOND = [&](double dx, double dy) {
            const auto POINT = pointer + Vector2D{dx, dy};
            const auto OTHER = State::monitorState()->query().vec(POINT).run();
            return OTHER && OTHER != monitor && CBox{OTHER->m_position, OTHER->m_size}.containsPoint(POINT);
        };
        const auto   POS    = monitor->m_position;
        const auto   SIZE   = monitor->m_size;
        const double CORNER = std::min(SIZE.x, SIZE.y) * CORNER_SHARE;
        const bool   LEFT   = pointer.x <= POS.x + EDGE && !BEYOND(-EDGE - 1, 0);
        const bool   RIGHT  = pointer.x >= POS.x + SIZE.x - EDGE && !BEYOND(EDGE + 1, 0);
        const bool   TOP    = pointer.y <= POS.y + EDGE && !BEYOND(0, -EDGE - 1);
        const bool   BOTTOM = pointer.y >= POS.y + SIZE.y - EDGE && !BEYOND(0, EDGE + 1);
        const bool   NEAR_TOP = pointer.y < POS.y + CORNER, NEAR_BOTTOM = pointer.y > POS.y + SIZE.y - CORNER;
        const bool   NEAR_LEFT = pointer.x < POS.x + CORNER, NEAR_RIGHT = pointer.x > POS.x + SIZE.x - CORNER;
        if ((LEFT && NEAR_TOP) || (TOP && NEAR_LEFT))
            return ZONE_TOP_LEFT;
        if ((RIGHT && NEAR_TOP) || (TOP && NEAR_RIGHT))
            return ZONE_TOP_RIGHT;
        if ((LEFT && NEAR_BOTTOM) || (BOTTOM && NEAR_LEFT))
            return ZONE_BOTTOM_LEFT;
        if ((RIGHT && NEAR_BOTTOM) || (BOTTOM && NEAR_RIGHT))
            return ZONE_BOTTOM_RIGHT;
        if (LEFT)
            return ZONE_LEFT;
        if (RIGHT)
            return ZONE_RIGHT;
        if (TOP)
            return ZONE_TOP;
        // (the bottom edge is the Dock's)
        return ZONE_NONE;
    }

    // ─── The shape under the window ───────────────────────────────────────────

    // what the drag is against, and the shape shown for it
    struct SPreview {
        eZone           zone = ZONE_NONE;
        PHLWINDOWREF    window;
        PHLMONITORREF   monitor;
        CBox            from, to; // logical, global: the window's box as it got there, where it will go
        float           fromAlpha = 0.F; // as shown when it set off, from where it was
        Time::steady_tp since;
        bool            leaving = false; // fading where it was, the drag gone off the edge or ended
    } g_preview;

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

    // The shape now: growing out of the window, or fading where it was. From
    // wherever it was when it set off: one going on to another place, or
    // coming back before it has faded, carries on from there rather than
    // blinking out and in.
    CBox shapeNow(float& alpha) {
        const float T = easeOut(progress());
        if (g_preview.leaving) {
            alpha = g_preview.fromAlpha * (1.F - T);
            return g_preview.to;
        }
        alpha = g_preview.fromAlpha + (1.F - g_preview.fromAlpha) * T;
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
            // the pass wants it unscaled: it scales it itself
            return m_box.copy().translate(-MONITOR->m_position).expand(PREVIEW_BORDER + 2).round();
        }

      private:
        CBox  m_box;
        float m_alpha;
    };

    void leave() {
        if (g_preview.zone == ZONE_NONE)
            return;
        // fading from how it is, half grown as it may be
        float      alpha = 0.F;
        const CBox NOW   = shapeNow(alpha);
        damage();
        g_preview.zone      = ZONE_NONE;
        g_preview.leaving   = true;
        g_preview.from      = NOW;
        g_preview.to        = NOW;
        g_preview.fromAlpha = alpha;
        g_preview.since     = Time::steadyNow();
        damage();
    }

    // ─── Snapped windows ──────────────────────────────────────────────────────

    // windows floating where a snap put them, and the size each had before
    struct SSnapped {
        PHLWINDOWREF window;
        CBox         box; // the floating box it was given
        Vector2D     size;
    };
    std::vector<SSnapped> g_snapped;

    SSnapped* snappedOf(const PHLWINDOW& window) {
        std::erase_if(g_snapped, [](const auto& s) { return s.window.expired(); });
        const auto IT = std::ranges::find_if(g_snapped, [&](const auto& s) { return s.window.lock() == window; });
        return IT == g_snapped.end() ? nullptr : &*IT;
    }

    void forget(const PHLWINDOW& window) {
        std::erase_if(g_snapped, [&](const auto& s) { return s.window.expired() || s.window.lock() == window; });
    }

    // the size a window comes out of the tiling at: what it had floating, or
    // asked for, or Hyprland's guess, no larger than the desktop
    Vector2D sizeOutOfTiling(const SP<Layout::ITarget>& target, const Vector2D& kept) {
        Vector2D size = kept;
        if (size.x <= 5 || size.y <= 5) {
            const auto DESIRED = target->desiredGeometry();
            size               = DESIRED && DESIRED->size.x > 5 && DESIRED->size.y > 5 ? DESIRED->size : DEFAULT_SIZE;
        }
        if (const auto SPACE = target->space()) {
            const auto AREA = SPACE->workArea(true);
            size            = Vector2D{std::min(size.x, AREA.w), std::min(size.y, AREA.h)};
        }
        const auto MIN = target->minSize().value_or(Vector2D{MIN_WINDOW_SIZE, MIN_WINDOW_SIZE});
        const auto MAX = target->maxSize().value_or(Vector2D{std::numeric_limits<double>::max(), std::numeric_limits<double>::max()});
        return size.clamp(MIN, MAX).round();
    }

    // ─── Taking a window away ─────────────────────────────────────────────────
    // A tiled window taken by its bar (no modifier held: that's Hyprland's own
    // move) stays in its tile until the pointer has gone a little way; then it
    // comes out at its own size, the point held keeping its place across it.

    struct {
        WP<Layout::ITarget> target;
        Vector2D            size; // what it had floating before the tiling took it
        bool                active = false;
    } g_untile;

    bool hkUpdateDragWindow(CDragStateController* self) {
        using FUpdate     = bool (*)(CDragStateController*);
        const auto TARGET = self->target();
        const auto WINDOW = TARGET ? TARGET->window() : nullptr;
        g_untile          = {};
        if (!WINDOW || self->mode() != MBIND_MOVE || TARGET->floating() || Fullscreen::controller()->isFullscreen(WINDOW) || WINDOW->m_group ||
            g_pInputManager->getModsFromAllKBs() != 0)
            return reinterpret_cast<FUpdate>(g_updateHook->m_original)(self);

        // Hyprland floats it here once the drag is far enough, and guesses
        // a size for it first: neither, the threshold is this file's
        const auto KEPT                      = TARGET->lastFloatingSize();
        self->*field(SThresholdReached{}) = false;
        const bool REJECTED                  = reinterpret_cast<FUpdate>(g_updateHook->m_original)(self);
        TARGET->rememberFloatingSize(KEPT);
        if (!REJECTED)
            g_untile = {.target = TARGET, .size = KEPT, .active = true};
        return REJECTED;
    }

    // Moves the window to `size` under the pointer, the point it was taken by
    // (`taken`, in `box`) keeping its place across it and its height on the
    // bar, and the drag going on from there.
    void takeAway(CDragStateController* self, const SP<Layout::ITarget>& target, const CBox& box, const Vector2D& taken, const Vector2D& pointer,
                  const Vector2D& size) {
        const double ACROSS = box.w > 0 ? std::clamp((taken.x - box.x) / box.w, 0.0, 1.0) : 0.5;
        const double DOWN   = std::min(taken.y - box.y, size.y / 2.0);
        const auto   POS    = Vector2D{pointer.x - ACROSS * size.x, pointer.y - DOWN}.round();
        target->setPositionGlobal(CBox{POS, size});
        target->warpPositionSize();
        self->*field(SBeginPointer{})  = pointer;
        self->*field(SLastPointer{})   = pointer;
        self->*field(SBeginPosition{}) = POS;
        self->*field(SBeginSize{})     = size;
    }

    // False to leave this move out: still in its tile, or still snapped.
    bool takenAway(CDragStateController* self, const Vector2D& pointer) {
        const auto TARGET = self->target();
        const auto WINDOW = TARGET ? TARGET->window() : nullptr;
        if (!WINDOW || self->mode() != MBIND_MOVE)
            return true;
        const auto BEGIN = self->*field(SBeginPointer{});

        // out of the tiling
        if (g_untile.active) {
            if (g_untile.target.lock() != TARGET || TARGET->floating()) {
                g_untile = {};
                return true;
            }
            if (BEGIN.distance(pointer) < TAKE_AWAY)
                return false;
            const auto BOX  = goalBox(WINDOW);
            const auto SIZE = sizeOutOfTiling(TARGET, g_untile.size);
            g_untile        = {};
            // floating at its own size, not put back into the tiling where
            // it is let go, as Hyprland would
            g_layoutManager->changeFloatingMode(TARGET);
            TARGET->rememberFloatingSize(SIZE);
            takeAway(self, TARGET, BOX, BEGIN, pointer, SIZE);
            self->*field(SThresholdReached{}) = true;
            self->*field(SDraggingTiled{})    = false;
            return true;
        }

        // out of where a snap put it
        const auto SNAPPED = snappedOf(WINDOW);
        if (!SNAPPED)
            return true;
        const CBox BOX = TARGET->position();
        if (!TARGET->floating() || !sameBox(BOX, SNAPPED->box)) {
            forget(WINDOW);
            return true;
        }
        if (BEGIN.distance(pointer) < TAKE_AWAY)
            return false;
        const auto SIZE = sizeOutOfTiling(TARGET, SNAPPED->size);
        forget(WINDOW);
        takeAway(self, TARGET, BOX, BEGIN, pointer, SIZE);
        return true;
    }

    // ─── The drag ─────────────────────────────────────────────────────────────

    CHyprSignalListener g_stageListener;
    CHyprSignalListener g_keyListener;
    CHyprSignalListener g_moveListener;
    CHyprSignalListener g_pointerListener;
    CHyprSignalListener g_buttonListener;
    // a key going down or up while a window is dragged, which ends the drag
    // (Hyprland's keybinds do), until it has been dealt with
    bool g_keyed = false;

    // The line between snapped windows that meet across a gap: dragged on
    // one of them, it moves on every window along it, as the line between
    // tiled windows does on a Mac (a half's edge takes both quarters beside
    // it, and the quarter above or below too). `vertical`: a line from top to
    // bottom; `before`: the dragged window is left of it (above it); `from`,
    // `to`: where the dragged window's edge on it was and is.
    void moveLine(const PHLWINDOW& window, const CBox& was, bool vertical, bool before, double from, double to) {
        // the gap between two snapped windows, at most
        constexpr double GAP_MAX = 64;
        // along the line, and across it
        const auto START = [&](const CBox& b) { return vertical ? b.y : b.x; };
        const auto SPAN  = [&](const CBox& b) { return vertical ? b.h : b.w; };
        const auto NEAR  = [&](const CBox& b) { return vertical ? b.x : b.y; };
        const auto FAR   = [&](const CBox& b) { return vertical ? b.x + b.w : b.y + b.h; };
        // side by side along the line, by more than rounding
        const auto BESIDE = [&](const CBox& a, const CBox& b) { return std::min(START(a) + SPAN(a), START(b) + SPAN(b)) - std::max(START(a), START(b)) > 2; };

        struct SOnLine {
            SSnapped*           snapped;
            SP<Layout::ITarget> target;
            bool                before; // left of the line (above it)
            double              gap;    // to the line where the dragged edge is
            bool                along = false;
        };
        std::vector<SOnLine> candidates;
        for (auto& other : g_snapped) {
            const auto OTHER  = other.window.lock();
            const auto TARGET = OTHER ? OTHER->layoutTarget() : nullptr;
            if (!OTHER || OTHER == window || !TARGET || !TARGET->floating() || OTHER->m_workspace != window->m_workspace || !sameBox(TARGET->position(), other.box))
                continue;
            const CBox BOX = other.box;
            if (std::abs((before ? FAR(BOX) : NEAR(BOX)) - from) <= 2)
                candidates.push_back({.snapped = &other, .target = TARGET, .before = before, .gap = 0});
            else if (const double GAP = before ? NEAR(BOX) - from : from - FAR(BOX); GAP >= 0 && GAP <= GAP_MAX)
                candidates.push_back({.snapped = &other, .target = TARGET, .before = !before, .gap = GAP});
        }
        // the windows along it: across from the dragged one, and from those,
        // and so on
        std::vector<std::pair<CBox, bool>> along{{was, before}};
        for (bool grew = true; grew;) {
            grew = false;
            for (auto& c : candidates) {
                if (c.along || std::ranges::none_of(along, [&](const auto& a) { return a.second != c.before && BESIDE(a.first, c.snapped->box); }))
                    continue;
                c.along = grew = true;
                along.emplace_back(c.snapped->box, c.before);
            }
        }
        for (const auto& c : candidates) {
            if (!c.along)
                continue;
            const CBox     BOX = c.snapped->box;
            const Vector2D MIN = c.target->minSize().value_or(Vector2D{MIN_WINDOW_SIZE, MIN_WINDOW_SIZE});
            const double   LEAST = vertical ? MIN.x : MIN.y;
            // its edge on the line: the dragged one's, or across the gap
            const double LINE = c.before == before ? to : before ? to + c.gap : to - c.gap;
            CBox         next = BOX;
            if (c.before)
                (vertical ? next.w : next.h) = std::max(LINE - NEAR(BOX), LEAST);
            else {
                const double END = FAR(BOX);
                const double AT  = std::min(LINE, END - LEAST);
                (vertical ? next.x : next.y) = AT;
                (vertical ? next.w : next.h) = END - AT;
            }
            if (sameBox(next, BOX))
                continue;
            g_layoutManager->setTargetGeom(next, c.target);
            if (const auto OTHER = c.snapped->window.lock()) {
                OTHER->positionAnimation()->warp();
                OTHER->sizeAnimation()->warp();
            }
            c.snapped->box = c.target->position();
        }
    }

    // A snapped window resized stays snapped, in its new shape (a drag away
    // still gives it back the size it had before), and the lines it shares
    // with the windows snapped beside it move with its edges.
    void resizeBeside(const SP<Layout::ITarget>& target, const PHLWINDOW& window) {
        auto* snapped = snappedOf(window);
        if (!snapped || !target->floating())
            return;
        const CBox WAS = snapped->box;
        const CBox NOW = target->position();
        snapped->box   = NOW;
        const auto MOVED = [](double was, double now) { return std::abs(now - was) >= 0.5; };
        if (MOVED(WAS.x, NOW.x))
            moveLine(window, WAS, true, false, WAS.x, NOW.x);
        if (MOVED(WAS.x + WAS.w, NOW.x + NOW.w))
            moveLine(window, WAS, true, true, WAS.x + WAS.w, NOW.x + NOW.w);
        if (MOVED(WAS.y, NOW.y))
            moveLine(window, WAS, false, false, WAS.y, NOW.y);
        if (MOVED(WAS.y + WAS.h, NOW.y + NOW.h))
            moveLine(window, WAS, false, true, WAS.y + WAS.h, NOW.y + NOW.h);
    }

    // ─── The line between stacked windows ─────────────────────────────────
    // Under a snapped window, the one snapped below it has its title bar,
    // which takes a press for a move, and Hyprland finds a window's edges
    // from its body: the line between the two was the pixel or two of gap.
    // The gap and the top of the bar below are the line: a press there
    // resizes the window above at its bottom edge (moveLine takes the one
    // below along), and the pointer shows it.

    PHLWINDOWREF g_lineHeld;          // the window above, while the line is held
    bool         g_lineShown = false; // the pointer's shape is the line's

    // The line is the two windows' own: a layer's surface or menu over it
    // (Mission Control, Spotlight, a notification), or another window, takes
    // a press there as it would anywhere else.
    bool lineUncovered(const Vector2D& pointer, const PHLWINDOW& above, const PHLWINDOW& below) {
        if (const auto MONITOR = State::monitorState()->query().vec(pointer).run()) {
            Vector2D coords;
            PHLLS    found;
            if (Desktop::viewState()->hitTest().layerPopupSurfaceAt(pointer, MONITOR, &coords, &found))
                return false;
            for (const auto LAYER : {ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, ZWLR_LAYER_SHELL_V1_LAYER_TOP})
                if (Desktop::viewState()->hitTest().layerSurfaceAt(pointer, &MONITOR->m_layerSurfaceLayers[LAYER], &coords, &found))
                    return false;
        }
        const auto AT =
            Desktop::viewState()->hitTest().windowAt(pointer, Desktop::View::ALLOW_FLOATING | Desktop::View::RESERVED_EXTENTS | Desktop::View::INPUT_EXTENTS);
        return !AT || AT == above || AT == below;
    }

    // the snapped window whose bottom edge is the line under the pointer
    PHLWINDOW aboveLine(const Vector2D& pointer) {
        // the line reaches this far into the bar below, and the body above
        constexpr double INTO_BAR  = 8;
        constexpr double INTO_BODY = 3;
        constexpr double GAP_MAX   = 64;
        const auto       placed    = [](const SSnapped& s) {
            const auto WINDOW = s.window.lock();
            const auto TARGET = WINDOW ? WINDOW->layoutTarget() : nullptr;
            return WINDOW && WINDOW->m_workspace && WINDOW->m_workspace->isVisible() && TARGET && TARGET->floating() && sameBox(TARGET->position(), s.box) ? WINDOW
                                                                                                                                                               : nullptr;
        };
        for (const auto& upper : g_snapped) {
            const auto ABOVE = placed(upper);
            if (!ABOVE)
                continue;
            const CBox BODY = ABOVE->getWindowMainSurfaceBox();
            for (const auto& lower : g_snapped) {
                const auto BELOW = placed(lower);
                if (!BELOW || BELOW == ABOVE || BELOW->m_workspace != ABOVE->m_workspace)
                    continue;
                const CBox   WITH_BAR = BELOW->getWindowBoxUnified(Desktop::View::RESERVED_EXTENTS);
                const double GAP      = WITH_BAR.y - (BODY.y + BODY.h);
                if (GAP < 0 || GAP > GAP_MAX || pointer.x < std::max(BODY.x, WITH_BAR.x) || pointer.x > std::min(BODY.x + BODY.w, WITH_BAR.x + WITH_BAR.w))
                    continue;
                if (pointer.y >= BODY.y + BODY.h - INTO_BODY && pointer.y <= WITH_BAR.y + INTO_BAR)
                    return lineUncovered(pointer, ABOVE, BELOW) ? ABOVE : nullptr;
            }
        }
        return nullptr;
    }

    void showLine(const Vector2D& pointer) {
        const bool ON = !g_layoutManager->dragController()->target() && !g_pSessionLockManager->isSessionLocked() && aboveLine(pointer);
        if (ON)
            Pointer::Cursor::overrideController->setOverride("ns-resize", Pointer::Cursor::CURSOR_OVERRIDE_WINDOW_EDGE);
        else if (g_lineShown)
            Pointer::Cursor::overrideController->unsetOverride(Pointer::Cursor::CURSOR_OVERRIDE_WINDOW_EDGE);
        g_lineShown = ON;
    }

    void holdLine(const IPointer::SButtonEvent& e, Event::SCallbackInfo& info) {
        if (e.button != BTN_LEFT)
            return;
        if (e.state == WL_POINTER_BUTTON_STATE_RELEASED) {
            if (!g_lineHeld)
                return;
            // (the press never reached Hyprland, so neither does this)
            g_lineHeld.reset();
            if (g_layoutManager->dragController()->target())
                g_layoutManager->endDragTarget();
            info.cancelled = true;
            return;
        }
        if (g_layoutManager->dragController()->target() || g_pSessionLockManager->isSessionLocked())
            return;
        const auto ABOVE = aboveLine(g_pInputManager->getMouseCoordsInternal());
        if (!ABOVE)
            return;
        g_lineHeld = ABOVE;
        g_layoutManager->beginDragTarget(ABOVE->layoutTarget(), MBIND_RESIZE, Layout::CORNER_BOTTOM);
        info.cancelled = true;
    }

    // A window's side taken by its border resizes that side alone, as the
    // pointer's shape there says, and a corner both. Hyprland takes the
    // corner of the window's quarter the pointer is in: along the gap
    // between two snapped halves, a drag meant to widen one gave both
    // another height. A resize bind (Super and a drag inside the window)
    // keeps Hyprland's corners.
    using FDragBegin = void (*)(CDragStateController*, SP<Layout::ITarget>, eMouseBindMode, std::optional<Layout::eRectCorner>, bool);

    void hkDragBegin(CDragStateController* self, SP<Layout::ITarget> target, eMouseBindMode mode, std::optional<Layout::eRectCorner> edge, bool exclusiveDeviceGrab) {
        if (mode == MBIND_RESIZE && !edge && g_pInputManager) {
            switch (g_pInputManager.get()->*field(SBorderIcon{})) {
                case BORDERICON_UP: edge = Layout::CORNER_TOP; break;
                case BORDERICON_DOWN: edge = Layout::CORNER_BOTTOM; break;
                case BORDERICON_LEFT: edge = Layout::CORNER_LEFT; break;
                case BORDERICON_RIGHT: edge = Layout::CORNER_RIGHT; break;
                case BORDERICON_UP_LEFT: edge = Layout::CORNER_TOPLEFT; break;
                case BORDERICON_UP_RIGHT: edge = Layout::CORNER_TOPRIGHT; break;
                case BORDERICON_DOWN_LEFT: edge = Layout::CORNER_BOTTOMLEFT; break;
                case BORDERICON_DOWN_RIGHT: edge = Layout::CORNER_BOTTOMRIGHT; break;
                default: break;
            }
        }
        reinterpret_cast<FDragBegin>(g_beginHook->m_original)(self, std::move(target), mode, edge, exclusiveDeviceGrab);
    }

    void hkMouseMove(CDragStateController* self, const Vector2D& pointer) {
        using FMouseMove = void (*)(CDragStateController*, const Vector2D&);
        if (!takenAway(self, pointer))
            return;
        reinterpret_cast<FMouseMove>(g_moveHook->m_original)(self, pointer);

        const auto TARGET = self->target();
        const auto WINDOW = TARGET ? TARGET->window() : nullptr;
        if (WINDOW && self->mode() == MBIND_RESIZE)
            resizeBeside(TARGET, WINDOW);
        // a pinned window is on every desktop, and has nowhere to go on one
        if (!WINDOW || self->mode() != MBIND_MOVE || !self->dragThresholdReached() || g_untile.active || WINDOW->onSpecialWorkspace() || WINDOW->m_pinned)
            return leave();
        const auto MONITOR = State::monitorState()->query().vec(pointer).run();
        if (!MONITOR || MONITOR->m_activeSpecialWorkspace)
            return leave();
        // Only on the desktop the window is on, which is the one its middle is
        // over: it goes where that desktop's tiling has it. Not over a window
        // filling the screen, which a tiled one would go under.
        const auto WORKSPACE = MONITOR->m_activeWorkspace;
        if (!WORKSPACE || !TARGET->space() || TARGET->space()->workspace() != WORKSPACE || Fullscreen::controller()->hasFullscreen(WORKSPACE))
            return leave();

        const auto ZONE  = zoneAt(MONITOR, pointer);
        const auto PLACE = placeFor(ZONE, WORKSPACE, WINDOW, pointer);
        if (!PLACE)
            return leave();
        if (ZONE == g_preview.zone && MONITOR == g_preview.monitor.lock() && PLACE->outer == g_preview.to)
            return;

        // out of the window, or on from where it is (still fading included)
        float      alpha = 0.F;
        const bool ON    = showing() && WINDOW == g_preview.window.lock() && MONITOR == g_preview.monitor.lock();
        const CBox FROM  = ON ? shapeNow(alpha) : outerOf(goalBox(WINDOW), WINDOW);
        damage();
        g_preview = SPreview{.zone = ZONE, .window = WINDOW, .monitor = MONITOR, .from = FROM, .to = PLACE->outer, .fromAlpha = alpha, .since = Time::steadyNow()};
        damage();
    }

    // The tile a window joins, while it does: the layout finds it where it
    // looks for the tile to split (dwindle: the window under the point it is
    // given, or under the pointer). Once, and only as dwindle asks.
    constexpr uint16_t DWINDLE_ASKS = Desktop::View::RESERVED_EXTENTS | Desktop::View::INPUT_EXTENTS | Desktop::View::SKIP_FULLSCREEN_PRIORITY;
    struct {
        PHLWINDOWREF window;
        bool         active = false;
    } g_split;

    // Into the tiling of its desktop beside `beside` on `side` (dwindle's
    // preselect), found at `focal`; the first tile when there's none.
    void tile(const SP<Layout::ITarget>& target, const PHLWINDOW& beside, const char* side, const Vector2D& focal) {
        const auto SPACE     = target->space();
        const auto ALGORITHM = SPACE ? SPACE->algorithm() : nullptr;
        if (!ALGORITHM)
            return;
        if (beside && side)
            (void)SPACE->layoutMsg(std::format("preselect {}", side));
        target->setWasTiling(true);
        ALGORITHM->removeTarget(target);
        target->setFloating(false);
        g_split = {.window = beside, .active = true};
        ALGORITHM->moveTarget(target, focal);
        g_split = {};
        target->setWasTiling(false);
        // the side asked for is used up with the split, unless the config
        // keeps it, or there was nothing to split (too big to tile: floated)
        static auto PPERMANENT = CConfigValue<Config::INTEGER>("dwindle:permanent_direction_override");
        if (beside && side && (*PPERMANENT || target->floating()))
            (void)SPACE->layoutMsg("preselect none");
        SPACE->recalculate();
    }

    // The window put where `zone` says; `before` is the size it had.
    void snap(eZone zone, const SP<Layout::ITarget>& target, const Vector2D& pointer, const Vector2D& before) {
        const auto WINDOW    = target->window();
        const auto SPACE     = target->space();
        const auto WORKSPACE = SPACE ? SPACE->workspace() : nullptr;
        const auto PLACE     = placeFor(zone, WORKSPACE, WINDOW, pointer);
        if (!WINDOW || !PLACE)
            return;

        if (PLACE->tiled) {
            if (target->floating())
                target->rememberFloatingSize(before);
            forget(WINDOW);
            tile(target, PLACE->beside.lock(), PLACE->side, PLACE->focal);
            return;
        }

        // floating, at its half, quarter or all of the desktop
        if (!target->floating())
            g_layoutManager->changeFloatingMode(target);
        const auto SNAPPED = snappedOf(WINDOW);
        const auto SIZE    = SNAPPED ? SNAPPED->size : before;
        const auto BOX     = innerOf(PLACE->outer, WINDOW);
        forget(WINDOW);
        g_snapped.emplace_back(SSnapped{.window = WINDOW, .box = BOX, .size = SIZE});
        g_layoutManager->setTargetGeom(BOX, target);

        // the other half free, to fill
        if (zone != ZONE_LEFT && zone != ZONE_RIGHT)
            return;
        const auto MONITOR = WORKSPACE->m_monitor.lock();
        if (!MONITOR)
            return;
        const auto OTHER = zoneIn(zone == ZONE_LEFT ? ZONE_RIGHT : ZONE_LEFT, SPACE->workArea());
        // not when windows snapped there have it (two quarters, the other
        // half): Snap Assist's pictures would lie over them, and a click on
        // either window would pick one to fill the half instead
        const bool TAKEN = std::ranges::any_of(g_snapped, [&](const SSnapped& s) {
            const auto THERE  = s.window.lock();
            const auto TARGET = THERE ? THERE->layoutTarget() : nullptr;
            return THERE && THERE != WINDOW && THERE->m_workspace == WINDOW->m_workspace && TARGET && TARGET->floating() && sameBox(TARGET->position(), s.box) &&
                OTHER.containsPoint(s.box.middle());
        });
        if (TAKEN)
            return;
        g_pEventManager->postEvent(SHyprIPCEvent{
            .event = "kiwisnapped",
            .data  = std::format("{:x},{},{},{},{},{},{}", reinterpret_cast<uintptr_t>(WINDOW.get()), zone == ZONE_LEFT ? "left" : "right", MONITOR->m_name,
                                 std::lround(OTHER.x), std::lround(OTHER.y), std::lround(OTHER.w), std::lround(OTHER.h)),
        });
    }

    // A floating window let go with its bar out of reach (under the bar at
    // the top, below the screen, all but off its side) comes back so it can
    // be taken again, as on macOS.
    constexpr double KEEP_IN_REACH = 64.0;

    void keepInReach(const SP<Layout::ITarget>& target) {
        const auto WINDOW  = target->window();
        const auto SPACE   = target->space();
        const auto MONITOR = WINDOW ? WINDOW->m_monitor.lock() : nullptr;
        if (!validMapped(WINDOW) || !target->floating() || WINDOW->m_pinned || !SPACE || !MONITOR || Fullscreen::controller()->isFullscreen(WINDOW))
            return;
        const CBox INNER = goalBox(WINDOW);
        const CBox OUTER = outerOf(INNER, WINDOW);
        const CBox AREA  = SPACE->workArea(true);
        const double BAR = std::max(INNER.y - OUTER.y, 24.0);
        double       y   = std::min(OUTER.y, MONITOR->m_position.y + MONITOR->m_size.y - BAR);
        y                = std::max(y, AREA.y);
        // across: as much of its bar on some display, or back towards its own
        double seen = 0;
        for (const auto& m : State::monitorState()->monitors()) {
            if (y < m->m_position.y || y >= m->m_position.y + m->m_size.y)
                continue;
            seen += std::max(0.0, std::min(OUTER.x + OUTER.w, m->m_position.x + m->m_size.x) - std::max(OUTER.x, m->m_position.x));
        }
        double x = OUTER.x;
        if (seen < std::min(KEEP_IN_REACH, OUTER.w))
            x = std::clamp(x, MONITOR->m_position.x - OUTER.w + KEEP_IN_REACH, MONITOR->m_position.x + MONITOR->m_size.x - KEEP_IN_REACH);
        if (std::abs(x - OUTER.x) < 1 && std::abs(y - OUTER.y) < 1)
            return;
        g_layoutManager->setTargetGeom(INNER.copy().translate(Vector2D{x - OUTER.x, y - OUTER.y}).round(), target);
    }

    // As Hyprland ends it, then where the edge says: once the drop is done
    // with, and only for a drop. A key ends a drag too (Escape, to leave it
    // where it is), and so does the window closing.
    void hkDragEnd(CDragStateController* self) {
        using FDragEnd     = void (*)(CDragStateController*);
        const auto ZONE    = g_preview.zone;
        const auto TARGET  = self->target();
        const bool MOVING  = self->mode() == MBIND_MOVE;
        const bool KEYED   = g_keyed;
        const auto POINTER = g_pInputManager->getMouseCoordsInternal();
        g_untile           = {};
        leave();

        reinterpret_cast<FDragEnd>(g_endHook->m_original)(self);

        // (dropped into a group, it is the group's)
        if (!MOVING || !TARGET || !TARGET->window() || TARGET->window()->m_group)
            return;
        g_pEventLoopManager->doLater([ZONE = KEYED ? ZONE_NONE : ZONE, WEAK = WP<Layout::ITarget>{TARGET}, POINTER] {
            const auto TARGET = WEAK.lock();
            if (!TARGET || !validMapped(TARGET->window()) || TARGET->window()->m_group)
                return;
            if (ZONE == ZONE_NONE)
                return keepInReach(TARGET);
            // floating, its own size; dragged with a modifier out of the
            // tiling, Hyprland has put it back there and knows its size
            const auto BEFORE = TARGET->floating() ? TARGET->position().size() : TARGET->lastFloatingSize();
            snap(ZONE, TARGET, POINTER, BEFORE);
        });
    }

    // ─── Minimized and back ───────────────────────────────────────────────────

    struct SAway {
        PHLWINDOWREF window;
        CBox         outer; // its tile when it went
    };
    std::vector<SAway> g_away;

    // which side of `box` a part of it at `part` is on
    const char* sideOf(const CBox& part, const CBox& box) {
        const auto   DELTA = part.middle() - box.middle();
        const double ACROSS = box.w > 0 ? std::abs(DELTA.x) / box.w : 0, DOWN = box.h > 0 ? std::abs(DELTA.y) / box.h : 0;
        if (ACROSS >= DOWN)
            return DELTA.x < 0 ? "l" : "r";
        return DELTA.y < 0 ? "u" : "d";
    }

    // Before the layout places a window moved to another workspace: a tiled
    // one going to be minimized is remembered where it was; one coming back
    // is told to go there.
    void moving(const PHLWINDOW& window, const PHLWORKSPACE& to) {
        std::erase_if(g_away, [](const auto& a) { return a.window.expired(); });
        const auto MINIMIZED = Kiwi::Genie::minimizedWorkspace();
        if (!window || !to || MINIMIZED.empty() || window->m_isFloating)
            return;
        // (the window's workspace is already the one it goes to: its box is
        // still where it was)
        if (to->m_name == MINIMIZED) {
            std::erase_if(g_away, [&](const auto& a) { return a.window == window; });
            g_away.emplace_back(SAway{.window = window, .outer = outerOf(goalBox(window), window)});
            return;
        }
        const auto IT = std::ranges::find_if(g_away, [&](const auto& a) { return a.window == window; });
        if (IT == g_away.end() || to->m_isSpecialWorkspace)
            return;
        const CBox OUTER = IT->outer;
        g_away.erase(IT);

        // No tiling to go back into: where it was, floating, once the move
        // is done with (Hyprland places a floating window from where it was
        // on the way), before the frame that pictures it coming back.
        if (!anyTiled(to, window)) {
            const auto INNER = innerOf(OUTER, window);
            g_pEventLoopManager->doLater([WEAK = PHLWINDOWREF{window}, INNER] {
                const auto WINDOW = WEAK.lock();
                const auto TARGET = WINDOW ? WINDOW->layoutTarget() : nullptr;
                if (!validMapped(WINDOW) || WINDOW->m_isFloating || WINDOW->onSpecialWorkspace() || !TARGET || !TARGET->space())
                    return;
                const auto KEPT = TARGET->lastFloatingSize();
                g_layoutManager->changeFloatingMode(TARGET);
                forget(WINDOW);
                g_snapped.emplace_back(SSnapped{.window = WINDOW, .box = INNER, .size = KEPT.x > 5 && KEPT.y > 5 ? KEPT : INNER.size()});
                g_layoutManager->setTargetGeom(INNER, TARGET);
            });
            return;
        }
        // beside the tile that took its place, on the side it was
        const auto BESIDE = tiledAt(to, OUTER.middle(), window);
        if (!BESIDE || !to->m_space)
            return;
        (void)to->m_space->layoutMsg(std::format("preselect {}", sideOf(OUTER, outerOf(goalBox(BESIDE), BESIDE))));
        g_split = {.window = BESIDE, .active = true};
        // used by the layout in this move, or not at all
        g_pEventLoopManager->doLater([] {
            if (!g_split.active)
                return;
            g_split = {};
        });
    }

    // ─── Asked for ────────────────────────────────────────────────────────────

    std::string take(std::string_view request) {
        request.remove_prefix(std::string_view{"kiwi-snap"}.size());
        const auto WORDS = Kiwi::split(request, ' ');
        if (WORDS.size() != 2 && WORDS.size() != 3)
            return "usage: kiwi-snap 0x<address> left|right|top|top-left|top-right|bottom-left|bottom-right [<x>,<y>,<w>,<h>]";
        const auto WINDOW = Kiwi::windowFrom(WORDS[0]);
        if (!validMapped(WINDOW) || !WINDOW->m_workspace || WINDOW->onSpecialWorkspace() || WINDOW->m_pinned || Fullscreen::controller()->isFullscreen(WINDOW))
            return "no such window on a desktop";
        const auto IT = std::ranges::find_if(ZONE_NAMES, [&](const auto& z) { return WORDS[1] == z.second; });
        if (IT == ZONE_NAMES.end())
            return "no such place";
        const auto TARGET = WINDOW->layoutTarget();
        if (!TARGET || !TARGET->space())
            return "no layout for it";
        const auto BEFORE = TARGET->floating() ? TARGET->position().size() : TARGET->lastFloatingSize();
        // From where the shell shows it (Snap Assist's picture of it): it
        // grows out of that rather than coming from where it was.
        if (WORDS.size() == 3) {
            const auto FROM = Kiwi::split(WORDS[2], ',');
            std::array<double, 4> box{};
            for (size_t i = 0; i < box.size(); i++) {
                if (FROM.size() != box.size() || !Kiwi::parse(FROM[i], box[i]) || (i >= 2 && box[i] < 1))
                    return "bad box";
            }
            WINDOW->positionAnimation()->setValueAndWarp({box[0], box[1]});
            WINDOW->sizeAnimation()->setValueAndWarp({box[2], box[3]});
        }
        snap(IT->first, TARGET, TARGET->position().middle(), BEFORE);
        Desktop::windowState()->raise(WINDOW);
        Desktop::focusState()->fullWindowFocus(WINDOW, Desktop::FOCUS_REASON_DESKTOP_STATE_CHANGE);
        return "ok";
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

namespace {
    // A window dragged by its title bar is let go wherever the pointer is,
    // over a panel too. hyprbars (and title-bar plugins written like it)
    // takes a release over a layer surface for the layer's and ignores it:
    // let go over the bar at the top edge, to fill the screen, the window
    // stayed on the pointer until the next click. While a window is dragged
    // no layer is under the pointer — macOS's panels don't answer it either
    // — so the release is the title bar's, and ends the drag as it began.
    using FLayerSurfaceAt = SP<CWLSurfaceResource> (*)(const Desktop::CViewHitTester*, const Vector2D&, std::vector<PHLLSREF>*, Vector2D*, PHLLS*, bool);

    SP<CWLSurfaceResource> hkLayerSurfaceAt(const Desktop::CViewHitTester* self, const Vector2D& pos, std::vector<PHLLSREF>* layers, Vector2D* coords, PHLLS* found,
                                            bool aboveLockscreen) {
        if (!aboveLockscreen && g_layoutManager->dragController()->target()) {
            if (found)
                *found = nullptr;
            return nullptr;
        }
        return reinterpret_cast<FLayerSurfaceAt>(g_layerHook->m_original)(self, pos, layers, coords, found, aboveLockscreen);
    }

    CFunctionHook* hookLayerSurfaceAt(HANDLE handle) {
        for (const auto& fn : HyprlandAPI::findFunctionsByName(handle, "layerSurfaceAt")) {
            if (!fn.demangled.starts_with("Desktop::CViewHitTester::layerSurfaceAt("))
                continue;
            const auto HOOK = HyprlandAPI::createFunctionHook(handle, fn.address, reinterpret_cast<void*>(&hkLayerSurfaceAt));
            return HOOK && HOOK->hook() ? HOOK : nullptr;
        }
        return nullptr;
    }
}

namespace Kiwi::Snap {
    bool init(HANDLE handle) {
        g_moveHook   = hook(handle, "mouseMove", MOUSE_MOVE, reinterpret_cast<void*>(&hkMouseMove));
        g_endHook    = hook(handle, "dragEnd", DRAG_END, reinterpret_cast<void*>(&hkDragEnd));
        g_updateHook = hook(handle, "updateDragWindow", UPDATE_DRAG_WINDOW, reinterpret_cast<void*>(&hkUpdateDragWindow));
        if (!g_moveHook || !g_endHook || !g_updateHook) {
            for (auto* h : {g_moveHook, g_endHook, g_updateHook}) {
                if (h)
                    h->unhook();
            }
            g_moveHook = g_endHook = g_updateHook = nullptr;
            return false;
        }
        // (without it, only a title-bar plugin that ends its drags itself does)
        g_layerHook = hookLayerSurfaceAt(handle);
        // (without it, a window's sides resize as its corners do)
        g_beginHook = hook(handle, "dragBegin", DRAG_BEGIN, reinterpret_cast<void*>(&hkDragBegin));
        g_command = HyprlandAPI::registerHyprCtlCommand(handle,
                                                        SHyprCtlCommand{
                                                            .name  = "kiwi-snap",
                                                            .exact = false,
                                                            .fn    = [](eHyprCtlOutputFormat, std::string request) { return take(request); },
                                                        });
        // the shape's next frame while it comes or goes
        g_stageListener = Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
            if (stage == RENDER_POST && showing() && progress() < 1.F)
                damage();
        });
        // (told before the keybinds are, which end the drag)
        g_keyListener = Event::bus()->m_events.input.keyboard.key.listen([](IKeyboard::SKeyEvent, Event::SCallbackInfo&) {
            if (g_keyed || !g_layoutManager->dragController()->target())
                return;
            g_keyed = true;
            g_pEventLoopManager->doLater([] { g_keyed = false; });
        });
        // (told before the layout of the workspace it goes to has it)
        g_moveListener = Event::bus()->m_events.window.moveToWorkspace.listen([](PHLWINDOW window, PHLWORKSPACE workspace) { moving(window, workspace); });
        g_pointerListener = Event::bus()->m_events.input.mouse.move.listen([](Vector2D pointer, Event::SCallbackInfo&) { showLine(pointer); });
        g_buttonListener  = Event::bus()->m_events.input.mouse.button.listen([](IPointer::SButtonEvent e, Event::SCallbackInfo& info) { holdLine(e, info); });
        return true;
    }

    std::optional<PHLWINDOW> splitting(const Vector2D&, uint16_t properties) {
        if (!g_split.active || properties != DWINDLE_ASKS)
            return std::nullopt;
        const auto WINDOW = g_split.window.lock();
        g_split           = {};
        return WINDOW;
    }

    std::optional<Vector2D> sizeBefore(const PHLWINDOW& window) {
        const auto* SNAPPED = snappedOf(window);
        const auto  TARGET  = window->layoutTarget();
        if (!SNAPPED || !TARGET || !sameBox(TARGET->position(), SNAPPED->box))
            return std::nullopt;
        return SNAPPED->size;
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
        g_keyListener.reset();
        g_moveListener.reset();
        g_pointerListener.reset();
        g_buttonListener.reset();
        if (g_lineShown)
            Pointer::Cursor::overrideController->unsetOverride(Pointer::Cursor::CURSOR_OVERRIDE_WINDOW_EDGE);
        g_lineShown = false;
        g_lineHeld.reset();
        g_command.reset();
        g_snapped.clear();
        g_away.clear();
        g_untile = {};
        g_split  = {};
        g_moveHook = g_endHook = g_updateHook = g_layerHook = g_beginHook = nullptr;
    }
}
