import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { Accessor, createState, createComputed, createBinding, onCleanup } from "ags"
import AstalWp from "gi://AstalWp"
import { timeout } from "ags/time"
import { exec } from "ags/process"
import { readFile } from "ags/file"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

import { volumeIcon, brightnessIcon, keyboardBrightnessIcon, Icon } from "../iconNames"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { dockOverlap, DOCK_SLIDE_DURATION, DOCK_SLIDE_OUT_DURATION, dockSlideDistance } from "../Dock/dock-state"
import { brightness, setBrightnessLevel, kbdBrightness, kbdAvailable, brightnessAvailable } from "../brightness"
import { systemTabOpen } from "../Bar/SystemMenu/SystemMenu"
import { watchIndicatorKeys } from "../inputWatcher"
import { popupGdkMonitor, destroyWindow } from "../monitors"

const fadeTimeout = 2500

const wp = AstalWp.get_default()
const volumeBinding = createBinding(wp.audio.defaultSpeaker, 'volume');
const muteBinding = createBinding(wp.audio.defaultSpeaker, 'mute')
const max_brightness = brightnessAvailable ? parseInt(exec("brightnessctl max")) : 1
const min_brightness = 10;

let waiting = true;

if (kbdAvailable) {
  kbdBrightness.subscribe(() => showIndicator('keyboardBrightness'))
}

watchIndicatorKeys((type) => showIndicator(type))

export function showIndicator(type: string){
  setIndicatorType(type)
  setVisibility(true);
  resetIndicatorTimeout() 
}

const [indicatorType, setIndicatorType] = createState('brightness')
const indicatorValue = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return get(volumeBinding);
    case 'brightness':
      return get(brightness);
    case 'keyboardBrightness':
      return get(kbdBrightness);
    default:
      return 0;
  }
})

const indicatorIcon = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return volumeIcon(get(volumeBinding), get(muteBinding));
    case 'brightness':
      return brightnessIcon(get(brightness));
    case 'keyboardBrightness':
      return keyboardBrightnessIcon(get(kbdBrightness))
    default:
      return 'question-round-symbolic';
  }
})

const isSensitive = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return true
    case 'brightness':
      return brightnessAvailable;
    default:
      return false;
  }
})

const [isVisible, setVisibility] = createState(false)

let timer;

function resetIndicatorTimeout() {
  if (timer) {
    timer.cancel();
  }
  timer = timeout(fadeTimeout, () => setVisibility(false));
}


// ─── Where it sits ────────────────────────────────────────────────────────────
// Above the bottom edge, or above the dock while it overlays that edge
// (auto-hide). The surface moves by its layer margin rather than a CSS margin:
// a CSS margin is part of the surface, so the surface resized with the dock,
// and while its fade-in still ran Hyprland animated that resize and stretched
// the pane.
//
// It rides the dock rather than running its own animation between the two
// resting places: same distance, same curve, same length, so the two move as
// one and it simply stops at its gap once the dock has passed it.

const EDGE_GAP = 20
const DOCK_GAP = 8

// the margin while the dock is out, and the one while it is away
function margins(): { withDock: number, alone: number } {
  if (conf().indicator_bar_position === "left") return { withDock: 0, alone: 0 }
  const overlap = dockOverlap()
  return { withDock: (overlap > 0 ? overlap : bandGuess()) + DOCK_GAP, alone: EDGE_GAP }
}

// dockOverlap is 0 while the dock is away, so the height it had is kept to
// animate towards
let lastBand = 0
function bandGuess(): number {
  return lastBand
}

// CSS `ease`, cubic-bezier(0.25, 0.1, 0.25, 1): the curve of the dock's slide
function ease(x: number): number {
  const bezier = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  let lo = 0, hi = 1, t = x
  for (let i = 0; i < 20; i++) {
    t = (lo + hi) / 2
    if (bezier(t, 0.25, 0.25) < x) lo = t
    else hi = t
  }
  return bezier(t, 0.1, 1)
}

function followDock(self: Astal.Window) {
  let margin = EDGE_GAP
  let tick = 0
  const place = (px: number) => {
    margin = px
    Gtk4LayerShell.set_margin(self, Gtk4LayerShell.Edge.BOTTOM, Math.round(px))
  }
  const stop = () => {
    if (tick) self.remove_tick_callback(tick)
    tick = 0
  }

  const glide = () => {
    const overlap = dockOverlap()
    if (overlap > 0) lastBand = overlap
    const { withDock, alone } = margins()
    const shown = overlap > 0
    const to = shown ? withDock : alone
    stop()
    if (!self.get_mapped() || to === margin) return place(to)

    // It moves the pill's own distance at the pill's own pace, from the same
    // moment, and stops where it belongs — which it reaches first, having
    // less far to go. Its own distance eased over the same time would be the
    // same length at a different speed, and the two would read as two
    // animations; waiting for the pill to reach it would read as a delay.
    const distance = dockSlideDistance(conf().dock_icon_size)
    const duration = (shown ? DOCK_SLIDE_DURATION : DOCK_SLIDE_OUT_DURATION) * 1000
    let start = -1
    tick = self.add_tick_callback((_widget, clock) => {
      const now = clock.get_frame_time()
      if (start < 0) start = now
      const progress = Math.min(1, (now - start) / duration)
      const travelled = distance * ease(progress)
      place(shown
        ? Math.min(withDock, alone + travelled)
        : Math.max(alone, withDock - travelled))
      if (progress < 1 && (shown ? margin < withDock : margin > alone)) return GLib.SOURCE_CONTINUE
      tick = 0
      return GLib.SOURCE_REMOVE
    })
  }

  place(margins().alone)
  const unsubscribe = [dockOverlap.subscribe(glide), conf.subscribe(glide)]
  onCleanup(() => {
    stop()
    unsubscribe.forEach(u => u())
  })
}

export default function IndicatorBar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {

  return (
    <window
      namespace={LAYER.panel}
      css={conf(c => `--primary: ${c.primary_color};`)}
      $={ self => {
        onCleanup(() => destroyWindow(self))
        followDock(self)
        timeout(1000, () => {
          waiting = false
        })
      }}
      visible={isVisible}
      name="ags-indicator"
      class={createComputed(get => {
        const c = get(conf)
        return `IndicatorBar ${get(themeClasses)} ${c.indicator_bar_position}`
      })}
      gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={conf.as(conf =>
        conf.indicator_bar_position == "left" ? Astal.WindowAnchor.LEFT : Astal.WindowAnchor.BOTTOM
      )}
      application={app}
      layer={Astal.Layer.TOP}
    >
      <Indicator />
    </window>
  )
}

function indicatorChange(value: number) {
  switch (indicatorType.get()) {
    case 'volume':
      wp.audio.defaultSpeaker.volume = value;
      return;
    case 'brightness':
      setBrightnessLevel(value)
      return;
    default:
      return;
  }
}

function Indicator(){
  return (
    <box class="indicator-bar">
      <box class="indicator-box"
        orientation={conf(conf =>
          conf.indicator_bar_position == "left" ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL
        )}
      >
        <Icon
          class={indicatorIcon.as((icon) => 'indicator-icon '+icon)}
          iconName={indicatorIcon}
          pixelSize={16}
        />
        <slider
          class={indicatorType}
          draw_value={false}
          min={0}
          max={1}
          step={0.01}
          value={indicatorValue}
          onChangeValue={(self) => {
            resetIndicatorTimeout()
            indicatorChange(self.value)
          }}
          sensitive={isSensitive}
          orientation={conf(conf =>
            conf.indicator_bar_position == "left" ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL
          )}
          inverted={conf(conf =>
            conf.indicator_bar_position == "left"
          )}
        />
      </box>
    </box>
  )
}

function absoluteBrightness(percentage: number) {
  const range = max_brightness - min_brightness;
  return min_brightness + (percentage*range)
}

function percentageBrightness(absoluteValue: number) {
  const range = max_brightness - min_brightness;
  return (absoluteValue - min_brightness) / range
}