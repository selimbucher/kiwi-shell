// Genie: a window being minimized is drawn pouring into its dock icon.
//
//     hyprctl kiwi-genie <address> <namespace> <x>,<y>,<w>,<h>
//
// The shell asks just before it moves the window away. The plugin takes a
// picture of the window as it is on screen, the same snapshot Hyprland takes
// for its close animation, and for the next half second draws that picture
// bent into the icon: the rectangle x, y, w, h in logical pixels from the
// top-left of the layer surface called <namespace>, which is where the shell
// knows its icon to be. The window itself is gone by then; only the picture
// is drawn, and dropped once it has arrived.
//
// It is drawn after the windows and before the layers above them, so the
// dock stays on top and the window disappears into it rather than over it.
// The reply is "ok" once the picture is taken; anything else means the shell
// should just move the window, which is what it does without the plugin.

#include "kiwi.hpp"

#include <plugins/PluginAPI.hpp>
#include <desktop/state/WindowState.hpp>
#include <desktop/view/LayerSurface.hpp>
#include <desktop/view/Window.hpp>
#include <event/EventBus.hpp>
#include <helpers/time/Time.hpp>
#include <output/Monitor.hpp>
#include <render/Framebuffer.hpp>
#include <render/OpenGL.hpp>
#include <render/Renderer.hpp>
#include <render/Shader.hpp>
#include <render/pass/PassElement.hpp>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <string>
#include <vector>

namespace {
    using Render::GL::g_pHyprOpenGL;

    constexpr auto DURATION = std::chrono::milliseconds{500};

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
    // window's bottom edge drops to the icon first while its sides bend in
    // towards it, then the top follows it down the funnel.
    //
    // All positions are in the monitor's pixels, from its top-left.
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
uniform float progress;
layout(location = 0) out vec4 fragColor;

float ease(float t) {
    return t * t * (3.0 - 2.0 * t);
}

void main() {
    vec2 p = quadPos + v_texcoord * quadSize;

    float bend = ease(clamp(progress / 0.45, 0.0, 1.0));
    float fall = ease(clamp((progress - 0.2) / 0.8, 0.0, 1.0));

    float top    = mix(windowPos.y, iconPos.y, fall);
    float bottom = mix(windowPos.y + windowSize.y, iconPos.y + iconSize.y, bend);
    if (p.y < top || p.y > bottom)
        discard;

    // the funnel stays where it is, from the window's top down to the icon
    float along = clamp((p.y - windowPos.y) / max(iconPos.y - windowPos.y, 1.0), 0.0, 1.0);
    float squeeze = bend * ease(along);
    float left  = mix(windowPos.x, iconPos.x, squeeze);
    float right = mix(windowPos.x + windowSize.x, iconPos.x + iconSize.x, squeeze);
    if (p.x < left - 1.0 || p.x > right + 1.0)
        discard;

    vec2 uv = vec2((p.x - left) / max(right - left, 1.0), (p.y - top) / max(bottom - top, 1.0));
    vec2 source = windowPos + clamp(uv, 0.0, 1.0) * windowSize;
    // a pixel's worth of soft edge, so the curved sides don't stair-step
    float edge = clamp(p.x - left + 0.5, 0.0, 1.0) * clamp(right - p.x + 0.5, 0.0, 1.0);
    fragColor = texture(tex, source / snapshotSize) * edge;
}
)#";

    // one window on its way into the dock, in its monitor's pixels
    struct SGenie {
        PHLWINDOWREF               source;
        PHLMONITORREF              monitor;
        SP<Render::IFramebuffer>   snapshot;
        CBox                       window, icon;
        Time::steady_tp            start;
    };

    float progressOf(const SGenie& genie) {
        const auto ELAPSED = std::chrono::duration<float>(Time::steadyNow() - genie.start);
        return std::clamp(ELAPSED.count() / std::chrono::duration<float>(DURATION).count(), 0.F, 1.F);
    }

    // everything the genie can cover in the frame, in the monitor's pixels
    CBox extentOf(const SGenie& genie) {
        const double LEFT   = std::min(genie.window.x, genie.icon.x);
        const double TOP    = std::min(genie.window.y, genie.icon.y);
        const double RIGHT  = std::max(genie.window.x + genie.window.w, genie.icon.x + genie.icon.w);
        const double BOTTOM = std::max(genie.window.y + genie.window.h, genie.icon.y + genie.icon.h);
        return CBox{LEFT, TOP, RIGHT - LEFT, BOTTOM - TOP}.round();
    }

    class CGeniePassElement : public IPassElement {
      public:
        CGeniePassElement(SP<CShader> shader, const SGenie& genie) : m_shader(std::move(shader)), m_genie(genie), m_progress(progressOf(genie)) {}

        std::vector<UP<IPassElement>> draw() override {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            const auto TEXTURE = m_genie.snapshot ? m_genie.snapshot->getTexture() : nullptr;
            if (!MONITOR || !TEXTURE || g_pHyprRenderer->m_renderData.damage.empty())
                return {};

            const CBox QUAD = extentOf(m_genie);

            glActiveTexture(GL_TEXTURE0);
            TEXTURE->bind();
            TEXTURE->setTexParameter(GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            TEXTURE->setTexParameter(GL_TEXTURE_MAG_FILTER, GL_LINEAR);

            g_pHyprOpenGL->blend(true);
            const auto SHADER  = g_pHyprOpenGL->useShader(m_shader);
            const auto PROGRAM = SHADER->program();
            SHADER->setUniformMatrix3fv(SHADER_PROJ, 1, GL_TRUE, g_pHyprRenderer->projectBoxToTarget(QUAD).getMatrix());
            SHADER->setUniformInt(SHADER_TEX, 0);

            const auto SET = [PROGRAM](const char* name, const Vector2D& value) { glUniform2f(glGetUniformLocation(PROGRAM, name), value.x, value.y); };
            SET("quadPos", QUAD.pos());
            SET("quadSize", QUAD.size());
            SET("snapshotSize", m_genie.snapshot->m_size);
            SET("windowPos", m_genie.window.pos());
            SET("windowSize", m_genie.window.size());
            SET("iconPos", m_genie.icon.pos());
            SET("iconSize", m_genie.icon.size());
            glUniform1f(glGetUniformLocation(PROGRAM, "progress"), m_progress);

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
            const auto MONITOR = m_genie.monitor.lock();
            if (!MONITOR)
                return {};
            // the pass wants it unscaled
            return extentOf(m_genie).scale(1.0 / MONITOR->m_scale).round();
        }

      private:
        SP<CShader> m_shader;
        SGenie      m_genie;
        float       m_progress = 0;
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

            m_preListener   = Event::bus()->m_events.render.pre.listen([this](PHLMONITOR monitor) { m_rendering = monitor; });
            m_stageListener = Event::bus()->m_events.render.stage.listen([this](eRenderStage stage) {
                if (stage == RENDER_POST_WINDOWS)
                    render();
                // damage from here on is the next frame's
                else if (stage == RENDER_POST)
                    advance(m_rendering.lock());
            });
            // Hyprland fades a window out of the workspace it leaves, which
            // would show it twice: where it was, and in the genie
            m_moveListener = Event::bus()->m_events.window.moveToWorkspace.listen([this](PHLWINDOW window, PHLWORKSPACE) {
                if (std::ranges::any_of(m_genies, [&](const SGenie& genie) { return genie.source == window; }))
                    window->alpha(Desktop::View::WINDOW_ALPHA_MOVE_TO_WORKSPACE)->setValueAndWarp(0.F);
            });
            return true;
        }

        void exit() {
            m_stageListener.reset();
            m_preListener.reset();
            m_moveListener.reset();
            m_command.reset();
            m_genies.clear();
            m_shader.reset();
        }

      private:
        std::vector<SGenie> m_genies;
        PHLMONITORREF       m_rendering;
        SP<CShader>         m_shader;
        bool                m_shaderFailed = false;
        SP<SHyprCtlCommand> m_command;
        CHyprSignalListener m_stageListener;
        CHyprSignalListener m_preListener;
        CHyprSignalListener m_moveListener;

        template <typename T>
        static bool parse(std::string_view text, T& out, int base = 10) {
            const auto END    = text.data() + text.size();
            const auto RESULT = [&] {
                if constexpr (std::is_integral_v<T>)
                    return std::from_chars(text.data(), END, out, base);
                else
                    return std::from_chars(text.data(), END, out);
            }();
            return RESULT.ec == std::errc{} && RESULT.ptr == END;
        }

        static std::vector<std::string_view> split(std::string_view text, char by) {
            std::vector<std::string_view> parts;
            while (!text.empty()) {
                const auto AT = text.find(by);
                if (AT == std::string_view::npos) {
                    parts.emplace_back(text);
                    break;
                }
                if (AT > 0)
                    parts.emplace_back(text.substr(0, AT));
                text.remove_prefix(AT + 1);
            }
            return parts;
        }

        static PHLWINDOW windowFrom(std::string_view address) {
            uintptr_t handle = 0;
            if (address.starts_with("0x"))
                address.remove_prefix(2);
            if (!parse(address, handle, 16))
                return nullptr;
            for (const auto& window : Desktop::windowState()->windows()) {
                if (reinterpret_cast<uintptr_t>(window.get()) == handle)
                    return window;
            }
            return nullptr;
        }

        static PHLLS layerOn(const PHLMONITOR& monitor, std::string_view name) {
            for (const auto& level : monitor->m_layerSurfaceLayers) {
                for (const auto& layer : level) {
                    const auto LAYER = layer.lock();
                    if (LAYER && LAYER->m_layerSurface && LAYER->m_namespace == name && LAYER->m_mapped)
                        return LAYER;
                }
            }
            return nullptr;
        }

        // "kiwi-genie <address> <namespace> <x>,<y>,<w>,<h>"
        std::string take(std::string_view request) {
            request.remove_prefix(std::string_view{"kiwi-genie"}.size());
            const auto WORDS = split(request, ' ');
            if (WORDS.size() != 3)
                return "usage: kiwi-genie <address> <namespace> <x>,<y>,<w>,<h>";

            const auto WINDOW = windowFrom(WORDS[0]);
            if (!WINDOW || !WINDOW->m_isMapped)
                return "no such window";
            const auto MONITOR = WINDOW->m_monitor.lock();
            if (!MONITOR)
                return "the window is on no monitor";
            const auto LAYER = layerOn(MONITOR, WORDS[1]);
            if (!LAYER)
                return "no such layer on the window's monitor";

            const auto FIELDS = split(WORDS[2], ',');
            double     icon[4];
            if (FIELDS.size() != 4)
                return "the icon is <x>,<y>,<w>,<h>";
            for (size_t i = 0; i < 4; ++i) {
                if (!parse(FIELDS[i], icon[i]))
                    return "the icon's x, y, width and height must be numbers";
            }

            // the snapshot is the whole monitor, with the window where it is
            auto snapshot = g_pHyprRenderer->makeSnapshotFB(WINDOW);
            if (!snapshot)
                return "the window is not on screen";

            const auto TO_MONITOR = [&MONITOR](CBox box) { return box.translate(-MONITOR->m_position).scale(MONITOR->m_scale).round(); };
            const CBox ICON       = CBox{icon[0], icon[1], icon[2], icon[3]}.translate(LAYER->m_geometry.pos());

            m_genies.emplace_back(SGenie{
                .source   = WINDOW,
                .monitor  = MONITOR,
                .snapshot = std::move(snapshot),
                .window   = TO_MONITOR(WINDOW->getFullWindowBoundingBox()),
                .icon     = TO_MONITOR(ICON),
                .start    = Time::steadyNow(),
            });
            damage(m_genies.back());
            return "ok";
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
            m_shader = shader;
            return true;
        }

        void render() {
            const auto MONITOR = g_pHyprRenderer->m_renderData.pMonitor.lock();
            if (m_genies.empty() || !MONITOR || !ensureShader())
                return;
            for (const auto& genie : m_genies) {
                if (genie.monitor == MONITOR)
                    g_pHyprRenderer->m_renderPass.add(makeUnique<CGeniePassElement>(m_shader, genie));
            }
        }

        // Once a frame is drawn, each genie asks for the next one; one that
        // has arrived asks once more, for a frame without it.
        void advance(const PHLMONITOR& monitor) {
            if (!monitor)
                return;
            for (const auto& genie : m_genies) {
                if (genie.monitor == monitor)
                    damage(genie);
            }
            std::erase_if(m_genies, [&](const SGenie& genie) { return genie.monitor == monitor && progressOf(genie) >= 1.F; });
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
        g_kiwiGenie.reset();
    }
}
