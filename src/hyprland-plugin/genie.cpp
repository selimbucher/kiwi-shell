// Genie: a minimized window pours into its dock icon, and a restored one
// pours back out of it.
//
//     hyprctl kiwi-genie watch <workspace>
//     hyprctl kiwi-genie <address> <namespace> <x>,<y>,<w>,<h>
//     hyprctl kiwi-genie <address> none
//
// The shell says once which workspace minimized windows are kept in. From
// then on, whatever moves a window there — the dock, a minimize button in the
// window's own title bar, a keybind — the plugin takes a picture of the
// window on its way out, the same snapshot Hyprland takes for its close
// animation, and posts
//
//     kiwigenie>>minimize,<address>
//
// on the event socket. A window moved back out of it onto a workspace on
// screen is kept hidden and pictured where it lands, and posts
//
//     kiwigenie>>restore,<address>
//
// The shell answers with where that window's icon is: x, y, w, h in logical
// pixels from the top-left of the layer surface called <namespace>, which is
// where the shell knows its icons to be. Until the answer comes the picture
// holds still — a minimized window stays where it was, a restored one stays
// hidden — so the round trip never shows; then the picture runs into the
// icon, or out of it, and the real window takes its place. "none" means there
// is no icon to go to: the window just goes, or just appears. So does one the
// shell doesn't answer for in time.
//
// The picture is drawn after the windows and before the layers above them,
// so the dock stays on top and the window disappears into it.

#include "kiwi.hpp"
#include "requests.hpp"

#include <plugins/PluginAPI.hpp>
#include <desktop/Workspace.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <desktop/view/Window.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <managers/EventManager.hpp>
#include <output/Monitor.hpp>
#include <render/Framebuffer.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/Shader.hpp>
#include <render/pass/PassElement.hpp>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <format>
#include <optional>
#include <string>
#include <vector>

namespace {
    using Kiwi::layerOn;
    using Kiwi::parse;
    using Kiwi::split;
    using Kiwi::windowFrom;
    using Render::GL::g_pHyprOpenGL;
    using Desktop::View::CWindow;
    using Desktop::View::WINDOW_ALPHA_MOVE_FROM_WORKSPACE;
    using Desktop::View::WINDOW_ALPHA_MOVE_TO_WORKSPACE;

    constexpr auto DURATION = std::chrono::milliseconds{450};
    // how long a picture waits for the shell to say where the icon is
    constexpr auto HOLD = std::chrono::milliseconds{250};

    // The shape: the window's bottom drops to the icon first while its sides
    // bend in towards it, then the top follows it down the funnel.
    constexpr float BEND_END   = 0.45F;
    constexpr float FALL_START = 0.2F;

    float smooth(float t) {
        t = std::clamp(t, 0.F, 1.F);
        return t * t * (3.F - 2.F * t);
    }

    // where the shape is at a moment, from 0, the window as it is, to 1, gone
    // into the icon; positions are in the monitor's pixels, from its top-left
    struct SShape {
        float bend = 0, top = 0, bottom = 0;
    };

    SShape shapeAt(float progress, const CBox& window, const CBox& icon) {
        const float BEND = smooth(progress / BEND_END);
        const float FALL = smooth((progress - FALL_START) / (1.F - FALL_START));
        return {
            .bend   = BEND,
            .top    = static_cast<float>(window.y + (icon.y - window.y) * FALL),
            .bottom = static_cast<float>(window.y + window.h + (icon.y + icon.h - window.y - window.h) * BEND),
        };
    }

    const std::string VERTEX = R"#(#version 300 es
uniform mat3 proj;
in vec2 pos;
in vec2 texcoord;
out vec2 v_texcoord;

void main() {
    gl_Position = vec4(proj * vec3(pos, 1.0), 1.0);
    v_texcoord = texcoord;
}
)#";

    // Every pixel of the quad asks which pixel of the window lands on it. The
    // funnel stays where it is, from the window's top down to the icon.
    const std::string FRAGMENT = R"#(#version 300 es
precision highp float;
in vec2 v_texcoord;
uniform sampler2D tex;
uniform vec2 quadPos;
uniform vec2 quadSize;
uniform vec2 snapshotSize;
uniform vec2 windowPos;
uniform vec2 windowSize;
uniform vec2 iconPos;
uniform vec2 iconSize;
uniform float bend;
uniform float top;
uniform float bottom;
layout(location = 0) out vec4 fragColor;

float smooth01(float t) {
    t = clamp(t, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

void main() {
    vec2 p = quadPos + v_texcoord * quadSize;
    if (p.y < top || p.y > bottom || bottom - top < 0.5)
        discard;

    float along   = clamp((p.y - windowPos.y) / max(iconPos.y - windowPos.y, 1.0), 0.0, 1.0);
    float squeeze = bend * smooth01(along);
    float left    = mix(windowPos.x, iconPos.x, squeeze);
    float right   = mix(windowPos.x + windowSize.x, iconPos.x + iconSize.x, squeeze);
    if (p.x < left - 1.0 || p.x > right + 1.0)
        discard;

    vec2 uv     = clamp(vec2((p.x - left) / max(right - left, 1.0), (p.y - top) / (bottom - top)), 0.0, 1.0);
    vec2 source = windowPos + uv * windowSize;
    // a pixel's worth of soft edge, so the curved sides don't stair-step
    float edge = clamp(p.x - left + 0.5, 0.0, 1.0) * clamp(right - p.x + 0.5, 0.0, 1.0);
    fragColor  = texture(tex, source / snapshotSize) * edge;
}
)#";

    // one window on its way into the dock or out of it, in its monitor's
    // pixels
    struct SGenie {
        PHLWINDOWREF                   window;
        PHLMONITORREF                  monitor;
        bool                           restore = false;
        SP<Render::IFramebuffer>       snapshot; // a restored window is pictured in the frame after its move
        CBox                           from;     // the window, where it is on screen
        std::optional<CBox>            icon;     // until the shell says, the picture holds still
        Time::steady_tp                since;    // held since, then running since
    };

    // how far along a running genie is, from 0 (the window) to 1 (the icon)
    float progressOf(const SGenie& genie) {
        if (!genie.icon)
            return genie.restore ? 1.F : 0.F;
        const float T = std::chrono::duration<float>(Time::steadyNow() - genie.since).count() / std::chrono::duration<float>(DURATION).count();
        const float CLAMPED = std::clamp(T, 0.F, 1.F);
        return genie.restore ? 1.F - CLAMPED : CLAMPED;
    }

    bool finished(const SGenie& genie) {
        const auto ELAPSED = Time::steadyNow() - genie.since;
        return genie.icon ? ELAPSED >= DURATION : ELAPSED >= HOLD;
    }

    // everything the genie can cover, in the monitor's pixels
    CBox extentOf(const SGenie& genie) {
        const CBox ICON   = genie.icon.value_or(genie.from);
        const double LEFT   = std::min(genie.from.x, ICON.x);
        const double TOP    = std::min(genie.from.y, ICON.y);
        const double RIGHT  = std::max(genie.from.x + genie.from.w, ICON.x + ICON.w);
        const double BOTTOM = std::max(genie.from.y + genie.from.h, ICON.y + ICON.h);
        return CBox{LEFT, TOP, RIGHT - LEFT, BOTTOM - TOP}.round();
    }

    // where the shader's own inputs are, looked up once it is compiled
    struct SUniforms {
        GLint quadPos = -1, quadSize = -1, snapshotSize = -1, windowPos = -1, windowSize = -1, iconPos = -1, iconSize = -1, bend = -1, top = -1, bottom = -1;

        explicit SUniforms(GLuint program = 0) {
            if (!program)
                return;
            const auto AT = [program](const char* name) { return glGetUniformLocation(program, name); };
            quadPos      = AT("quadPos");
            quadSize     = AT("quadSize");
            snapshotSize = AT("snapshotSize");
            windowPos    = AT("windowPos");
            windowSize   = AT("windowSize");
            iconPos      = AT("iconPos");
            iconSize     = AT("iconSize");
            bend         = AT("bend");
            top          = AT("top");
            bottom       = AT("bottom");
        }
    };

    class CGeniePassElement : public IPassElement {
      public:
        CGeniePassElement(SP<CShader> shader, const SUniforms& uniforms, const SGenie& genie) :
            m_shader(std::move(shader)), m_uniforms(uniforms), m_snapshot(genie.snapshot), m_window(genie.from), m_icon(genie.icon.value_or(genie.from)), m_quad(extentOf(genie)),
            m_scale(genie.monitor ? genie.monitor->m_scale : 1.0), m_shape(shapeAt(progressOf(genie), m_window, m_icon)) {}

        std::vector<UP<IPassElement>> draw() override {
            const auto TEXTURE = m_snapshot ? m_snapshot->getTexture() : nullptr;
            if (!TEXTURE || g_pHyprRenderer->m_renderData.damage.empty() || m_shape.bottom - m_shape.top < 0.5F)
                return {};

            glActiveTexture(GL_TEXTURE0);
            TEXTURE->bind();
            TEXTURE->setTexParameter(GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            TEXTURE->setTexParameter(GL_TEXTURE_MAG_FILTER, GL_LINEAR);

            g_pHyprOpenGL->blend(true);
            const auto SHADER = g_pHyprOpenGL->useShader(m_shader);
            SHADER->setUniformMatrix3fv(SHADER_PROJ, 1, GL_TRUE, g_pHyprRenderer->projectBoxToTarget(m_quad).getMatrix());
            SHADER->setUniformInt(SHADER_TEX, 0);

            const auto PAIR = [](GLint at, const Vector2D& value) { glUniform2f(at, value.x, value.y); };
            PAIR(m_uniforms.quadPos, m_quad.pos());
            PAIR(m_uniforms.quadSize, m_quad.size());
            PAIR(m_uniforms.snapshotSize, m_snapshot->m_size);
            PAIR(m_uniforms.windowPos, m_window.pos());
            PAIR(m_uniforms.windowSize, m_window.size());
            PAIR(m_uniforms.iconPos, m_icon.pos());
            PAIR(m_uniforms.iconSize, m_icon.size());
            glUniform1f(m_uniforms.bend, m_shape.bend);
            glUniform1f(m_uniforms.top, m_shape.top);
            glUniform1f(m_uniforms.bottom, m_shape.bottom);

            glBindVertexArray(SHADER->getUniformLocation(SHADER_SHADER_VAO));
            g_pHyprRenderer->m_renderData.damage.forEachRect([](const auto& RECT) {
                g_pHyprOpenGL->scissor(&RECT, g_pHyprRenderer->m_renderData.transformDamage);
                glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
            });
            g_pHyprOpenGL->scissor(nullptr);
            glBindVertexArray(0);
            TEXTURE->unbind();
            return {};
        }

        bool needsLiveBlur() override {
            return false;
        }

        bool needsPrecomputeBlur() override {
            return false;
        }

        const char* passName() override {
            return "CKiwiGeniePassElement";
        }

        ePassElementType type() override {
            return EK_CUSTOM;
        }

        std::optional<CBox> boundingBox() override {
            // the pass wants it unscaled
            return m_quad.copy().scale(1.0 / m_scale).round();
        }

      private:
        SP<CShader>                    m_shader;
        SUniforms                      m_uniforms;
        SP<Render::IFramebuffer>       m_snapshot;
        CBox                           m_window, m_icon, m_quad;
        double                         m_scale = 1;
        SShape                         m_shape;
    };

    class CKiwiGenie {
      public:
        bool init(HANDLE handle) {
            m_command = HyprlandAPI::registerHyprCtlCommand(handle,
                                                            SHyprCtlCommand{
                                                                .name  = "kiwi-genie",
                                                                .exact = false,
                                                                .fn    = [this](eHyprCtlOutputFormat, std::string request) { return take(request); },
                                                            });
            if (!m_command)
                return false;

            m_preListener = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) {
                m_rendering = monitor;
                pictureRestored(monitor);
            });
            m_stageListener = Event::bus()->m_events.render.stage.listen([this](eRenderStage stage) {
                if (stage == RENDER_POST_WINDOWS)
                    render();
                // damage from here on is the next frame's
                else if (stage == RENDER_POST)
                    advance(m_rendering.lock());
            });
            m_moveListener = Event::bus()->m_events.window.moveToWorkspace.listen([this](PHLWINDOW window, PHLWORKSPACE workspace) { moved(window, workspace); });
            return true;
        }

        void exit() {
            for (auto& genie : m_genies)
                show(genie);
            m_genies.clear();
            m_stageListener.reset();
            m_preListener.reset();
            m_moveListener.reset();
            m_command.reset();
            m_shader.reset();
        }

      private:
        std::string               m_watched;
        std::vector<PHLWINDOWREF> m_inside; // the windows in the watched workspace
        std::vector<SGenie>       m_genies;
        PHLMONITORREF             m_rendering;
        SP<CShader>               m_shader;
        SUniforms                 m_uniforms;
        bool                      m_shaderFailed = false;
        SP<SHyprCtlCommand>       m_command;
        CHyprSignalListener       m_stageListener;
        CHyprSignalListener       m_preListener;
        CHyprSignalListener       m_moveListener;

        static CBox onMonitor(const PHLMONITOR& monitor, CBox box) {
            return box.translate(-monitor->m_position).scale(monitor->m_scale).round();
        }

        SGenie* genieOf(const PHLWINDOW& window) {
            const auto IT = std::ranges::find_if(m_genies, [&](const SGenie& genie) { return genie.window == window; });
            return IT == m_genies.end() ? nullptr : &*IT;
        }

        // "watch <workspace>", "<address> <namespace> <x>,<y>,<w>,<h>" or "<address> none"
        std::string take(std::string_view request) {
            request.remove_prefix(std::string_view{"kiwi-genie"}.size());
            const auto WORDS = split(request, ' ');

            if (WORDS.size() == 2 && WORDS[0] == "watch") {
                m_watched = std::string{WORDS[1]};
                m_inside.clear();
                for (const auto& window : Desktop::windowState()->windows()) {
                    if (window->m_isMapped && window->m_workspace && window->m_workspace->m_name == m_watched)
                        m_inside.emplace_back(window);
                }
                return "ok";
            }

            if (WORDS.size() < 2 || WORDS.size() > 3)
                return "usage: kiwi-genie watch <workspace> | <address> <namespace> <x>,<y>,<w>,<h> | <address> none";

            const auto WINDOW = windowFrom(WORDS[0]);
            auto*      genie  = WINDOW ? genieOf(WINDOW) : nullptr;
            // gone by now, or not ours to animate; either way nothing to do
            if (!genie || genie->icon)
                return "ok";

            if (WORDS[1] == "none") {
                genie->since = Time::steadyNow() - HOLD;
                return "ok";
            }
            if (WORDS.size() != 3)
                return "the icon is <namespace> <x>,<y>,<w>,<h>";

            const auto MONITOR = genie->monitor.lock();
            const auto LAYER   = MONITOR ? layerOn(MONITOR, WORDS[1]) : nullptr;
            const auto FIELDS  = split(WORDS[2], ',');
            double     icon[4];
            if (FIELDS.size() != 4)
                return "the icon is <x>,<y>,<w>,<h>";
            for (size_t i = 0; i < 4; ++i) {
                if (!parse(FIELDS[i], icon[i]))
                    return "the icon's x, y, width and height must be numbers";
            }
            if (!LAYER) {
                genie->since = Time::steadyNow() - HOLD;
                return "no such layer on the window's monitor";
            }

            genie->icon  = onMonitor(MONITOR, CBox{icon[0], icon[1], icon[2], icon[3]}.translate(LAYER->m_geometry.pos()));
            genie->since = Time::steadyNow();
            damage(*genie);
            return "ok";
        }

        void post(const char* kind, const PHLWINDOW& window) {
            g_pEventManager->postEvent(SHyprIPCEvent{.event = "kiwigenie", .data = std::format("{},{:x}", kind, reinterpret_cast<uintptr_t>(window.get()))});
        }

        void moved(const PHLWINDOW& window, const PHLWORKSPACE& workspace) {
            if (m_watched.empty() || !workspace)
                return;

            const bool INTO = workspace->m_name == m_watched;
            const bool OUT  = std::ranges::find(m_inside, window) != m_inside.end();
            std::erase_if(m_inside, [&](const PHLWINDOWREF& ref) { return ref.expired() || ref == window; });
            if (INTO)
                m_inside.emplace_back(window);

            // moved again mid-flight: the last move wins
            if (auto* genie = genieOf(window)) {
                show(*genie);
                std::erase_if(m_genies, [&](const SGenie& other) { return other.window == window; });
            }

            const auto MONITOR = window->m_monitor.lock();
            if (!MONITOR)
                return;

            // Leaving a workspace on screen, Hyprland is fading the window out
            // and still draws it, so this is the last chance to picture it;
            // the fade itself is cut, or the window would show twice.
            if (INTO && window->m_monitorMovedFrom != -1) {
                auto snapshot = pictureLeaving(window);
                if (!snapshot)
                    return;
                window->alpha(WINDOW_ALPHA_MOVE_TO_WORKSPACE)->setValueAndWarp(0.F);
                m_genies.emplace_back(SGenie{
                    .window   = window,
                    .monitor  = MONITOR,
                    .snapshot = std::move(snapshot),
                    .from     = onMonitor(MONITOR, window->getFullWindowBoundingBox()),
                    .since    = Time::steadyNow(),
                });
                post("minimize", window);
                damage(m_genies.back());
                return;
            }

            // Coming back onto a workspace on screen: the layout places the
            // window after this, so it is pictured before the next frame
            // (pictureRestored) and hidden until the genie has put it back.
            if (OUT && !INTO && workspace->isVisible()) {
                m_genies.emplace_back(SGenie{.window = window, .monitor = MONITOR, .restore = true, .since = Time::steadyNow()});
                post("restore", window);
                g_pHyprRenderer->damageMonitor(MONITOR);
            }
        }

        // By the time Hyprland says a window moved, it is already on the
        // hidden workspace, and a snapshot is only taken of a window on one
        // being drawn. For the length of the picture the workspace is drawn
        // the way Hyprland draws one it is sliding in, held where it would
        // be on screen, then put back as it was.
        static SP<Render::IFramebuffer> pictureLeaving(const PHLWINDOW& window) {
            const auto WORKSPACE = window->m_workspace;
            if (!WORKSPACE)
                return nullptr;
            auto& offset = WORKSPACE->m_renderOffset;
            if (offset->isBeingAnimated())
                return nullptr; // sliding somewhere already; not ours to hold

            const bool     FORCED = WORKSPACE->m_forceRendering;
            const Vector2D OFFSET = offset->value();
            WORKSPACE->m_forceRendering = true;
            *offset                     = Vector2D{};
            offset->warp(false);

            auto snapshot = g_pHyprRenderer->makeSnapshotFB(window);

            *offset = OFFSET;
            offset->warp(false);
            WORKSPACE->m_forceRendering = FORCED;
            return snapshot;
        }

        // A restored window is pictured where it is going, before its first
        // frame back: it is put there at once rather than sliding (it is
        // hidden anyway), pictured, and hidden until its genie is done.
        void pictureRestored(const PHLMONITOR& monitor) {
            for (auto& genie : m_genies) {
                if (!genie.restore || genie.snapshot || genie.monitor != monitor)
                    continue;
                const auto WINDOW = genie.window.lock();
                if (!WINDOW || !WINDOW->m_isMapped)
                    continue;

                WINDOW->positionAnimation()->warp();
                WINDOW->sizeAnimation()->warp();
                WINDOW->alpha(WINDOW_ALPHA_MOVE_FROM_WORKSPACE)->setValueAndWarp(1.F);
                genie.snapshot = g_pHyprRenderer->makeSnapshotFB(WINDOW);
                genie.from     = onMonitor(monitor, WINDOW->getFullWindowBoundingBox());
                if (genie.snapshot)
                    WINDOW->alpha(WINDOW_ALPHA_MOVE_FROM_WORKSPACE)->setValueAndWarp(0.F);
                else
                    genie.since = Time::steadyNow() - DURATION - HOLD; // just appears
            }
        }

        // the real window back, for a restore; a minimized one is gone already
        void show(SGenie& genie) {
            const auto WINDOW = genie.window.lock();
            if (!genie.restore || !WINDOW)
                return;
            WINDOW->alpha(WINDOW_ALPHA_MOVE_FROM_WORKSPACE)->setValueAndWarp(1.F);
            g_pHyprRenderer->damageWindow(WINDOW);
        }

        void damage(const SGenie& genie) {
            const auto MONITOR = genie.monitor.lock();
            if (MONITOR)
                g_pHyprRenderer->damageBox(extentOf(genie).scale(1.0 / MONITOR->m_scale).translate(MONITOR->m_position));
        }

        bool ensureShader() {
            if (m_shader)
                return true;
            if (m_shaderFailed)
                return false;
            // dynamic: a shader that won't compile is logged, not fatal
            auto shader = makeShared<CShader>();
            if (!shader->createProgram(VERTEX, FRAGMENT, true)) {
                m_shaderFailed = true;
                return false;
            }
            m_shader   = shader;
            m_uniforms = SUniforms{shader->program()};
            return true;
        }

        void render() {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (m_genies.empty() || !MONITOR || !ensureShader())
                return;
            for (const auto& genie : m_genies) {
                // a restored window waiting for its icon stays hidden
                if (genie.monitor == MONITOR && genie.snapshot && (genie.icon || !genie.restore))
                    g_pHyprRenderer->m_renderPass.add(makeUnique<CGeniePassElement>(m_shader, m_uniforms, genie));
            }
        }

        // Once a frame is drawn, each genie asks for the next one. One that
        // has arrived, or waited too long for its icon, is dropped — and a
        // restored window shown — and asks once more, for a frame without it.
        void advance(const PHLMONITOR& monitor) {
            if (!monitor)
                return;
            for (auto& genie : m_genies) {
                if (genie.monitor != monitor)
                    continue;
                damage(genie);
                if (finished(genie))
                    show(genie);
            }
            std::erase_if(m_genies, [&](const SGenie& genie) { return genie.monitor.expired() || (genie.monitor == monitor && finished(genie)); });
        }
    };

    UP<CKiwiGenie> g_kiwiGenie;
}

namespace Kiwi::Genie {
    bool init(HANDLE handle) {
        g_kiwiGenie = makeUnique<CKiwiGenie>();
        if (!g_kiwiGenie->init(handle)) {
            g_kiwiGenie.reset();
            return false;
        }
        return true;
    }

    void exit() {
        if (g_kiwiGenie)
            g_kiwiGenie->exit();
        g_kiwiGenie.reset();
    }
}
