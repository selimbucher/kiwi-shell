// Fingers: how far they really went on the trackpad.
//
// Hyprland hands a swipe over as libinput's accelerated deltas, the ones the
// pointer moves by: the quicker the fingers, the further the same stretch of
// trackpad counts, several times as far for a quick swipe as for a slow one
// (and decelerated at a crawl). A gesture that follows the fingers wants
// their own travel instead, which libinput has as well (its unaccelerated
// deltas, what GNOME's and niri's gestures go by) but Hyprland doesn't pass
// on. So it is worked back here from the accelerated one.
//
// libinput accelerates a touchpad's every delta by one factor (its
// filter-touchpad.c, the same since 1.11), which depends on the user's speed
// setting and on how fast the fingers go: that delta's own distance over the
// time since the delta before, averaged with the speed before it. The
// accelerated distance is the fingers' distance times the factor at their
// speed, which only grows with the speed: there is one speed that gives it,
// found by halving, and the delta is divided by the factor at that speed.
// Off by a little at most (the times come in whole milliseconds), where the
// accelerated deltas are off by up to five times.
//
// With the flat profile the factor is the same at any speed, and a custom
// profile (a curve of the user's) is taken as it comes.

#include "kiwi.hpp"

#include <devices/IPointer.hpp>
#include <managers/input/InputManager.hpp>

#include <aquamarine/input/Input.hpp>
#include <libinput.h>

#include <algorithm>
#include <cmath>

namespace {
    // libinput's touchpad acceleration (filter-touchpad.c)
    constexpr double SLOWDOWN  = 0.2968; // TP_MAGIC_SLOWDOWN: every touchpad delta, accelerated or not
    constexpr double BASELINE  = 0.9;    // the profile's plateau, which the unaccelerated deltas get too
    constexpr double THRESHOLD = 130.0;  // mm/s: faster than this, accelerated
    // deltas are normalized to a 1000 dpi device: this many to a millimetre
    constexpr double UNITS_PER_MM = 1000.0 / 25.4;
    // the unaccelerated deltas, against the device's normalized ones
    constexpr double UNACCELERATED = BASELINE * SLOWDOWN;

    enum class eProfile {
        ADAPTIVE,
        FLAT,
        AS_IT_COMES, // custom, none, or no touchpad found
    };

    struct {
        eProfile profile     = eProfile::AS_IT_COMES;
        double   speedFactor = 1.0; // the adaptive profile's, from the speed setting
        double   flatFactor  = 1.0;
        // the swipe so far: the fingers' last speed (mm/s), and when
        double   lastSpeed = -1.0;
        uint32_t lastMs    = 0;
    } g_touchpad;

    // touchpad_accel_profile_linear: the factor at `speed` mm/s
    double adaptive(double speed) {
        double factor = BASELINE;
        if (speed < 7.0)
            factor = std::min(BASELINE, 0.1 * speed + 0.3);
        else if (speed >= THRESHOLD) {
            speed  = std::min(speed, THRESHOLD * 4.0);
            factor = 0.0025 * (speed / THRESHOLD) * (speed - THRESHOLD) + BASELINE;
        }
        return factor * g_touchpad.speedFactor * SLOWDOWN;
    }

    // calculate_acceleration_simpsons: between the speed before and this one
    double between(double speed, double last) {
        return (adaptive(speed) + adaptive(last) + 4.0 * adaptive((speed + last) / 2.0)) / 6.0;
    }

    // The touchpad's libinput device: the first that does gestures. (Two
    // touchpads set differently, the swipe could be either's.)
    libinput_device* touchpad() {
        if (!g_pInputManager)
            return nullptr;
        for (const auto& pointer : g_pInputManager->m_pointers) {
            if (!pointer || !pointer->m_isTouchpad || pointer->isVirtual())
                continue;
            const auto AQ     = pointer->aq();
            const auto DEVICE = AQ ? AQ->getLibinputHandle() : nullptr;
            if (DEVICE && libinput_device_has_capability(DEVICE, LIBINPUT_DEVICE_CAP_GESTURE))
                return DEVICE;
        }
        return nullptr;
    }
}

namespace Kiwi::Fingers {
    void begin() {
        g_touchpad.lastSpeed = -1.0;
        g_touchpad.profile   = eProfile::AS_IT_COMES;
        const auto DEVICE    = touchpad();
        if (!DEVICE || !libinput_device_config_accel_is_available(DEVICE))
            return;
        const double SPEED = std::clamp(libinput_device_config_accel_get_speed(DEVICE), -1.0, 1.0);
        switch (libinput_device_config_accel_get_profile(DEVICE)) {
            case LIBINPUT_CONFIG_ACCEL_PROFILE_ADAPTIVE:
                g_touchpad.profile = eProfile::ADAPTIVE;
                // speed_factor(): 1 at the default speed of 0
                g_touchpad.speedFactor = std::pow(SPEED + 1.0, 2.38) * 0.95 + 0.05;
                break;
            case LIBINPUT_CONFIG_ACCEL_PROFILE_FLAT:
                g_touchpad.profile    = eProfile::FLAT;
                g_touchpad.flatFactor = std::max(0.005, 1.0 + SPEED) * SLOWDOWN;
                break;
            default: break;
        }
    }

    Vector2D travel(const Vector2D& delta, uint32_t timeMs) {
        const double DISTANCE = delta.size();
        if (DISTANCE <= 0.0)
            return {};

        double factor = UNACCELERATED; // as it comes
        if (g_touchpad.profile == eProfile::FLAT)
            factor = g_touchpad.flatFactor;
        else if (g_touchpad.profile == eProfile::ADAPTIVE) {
            if (g_touchpad.lastSpeed < 0.0) {
                // The first: the deltas before it went to Hyprland's telling
                // which gesture this is, so there's no time since the last.
                // Taken as on the plateau, a steady swipe.
                factor               = BASELINE * g_touchpad.speedFactor * SLOWDOWN;
                g_touchpad.lastSpeed = THRESHOLD / 2.0;
            } else {
                // DISTANCE = speed * dt * UNITS_PER_MM * between(speed, last), for the speed
                const double DT     = (timeMs > g_touchpad.lastMs ? timeMs - g_touchpad.lastMs : 1) / 1000.0;
                const double WANTED = DISTANCE / (DT * UNITS_PER_MM);
                double       lo = 0.0, hi = 4000.0;
                for (int i = 0; i < 40; ++i) {
                    const double MID = (lo + hi) / 2.0;
                    (MID * between(MID, g_touchpad.lastSpeed) < WANTED ? lo : hi) = MID;
                }
                const double SPEED   = (lo + hi) / 2.0;
                factor               = between(SPEED, g_touchpad.lastSpeed);
                g_touchpad.lastSpeed = SPEED;
            }
        }
        g_touchpad.lastMs = timeMs;
        return delta * (UNACCELERATED / factor);
    }
}
