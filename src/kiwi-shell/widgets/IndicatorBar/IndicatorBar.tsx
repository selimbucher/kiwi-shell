import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { Accessor, createState, createComputed, createBinding, onCleanup } from "ags"
import AstalWp from "gi://AstalWp"
import { timeout } from "ags/time"
import { exec } from "ags/process"
import { readFile } from "ags/file"

import { volumeIcon, brightnessIcon, keyboardBrightnessIcon, Icon } from "../iconNames"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { dockOverlap } from "../Dock/dock-state"
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


export default function IndicatorBar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {

  return (
    <window
      namespace={LAYER.panel}
      css={createComputed(get =>
        `--primary: ${get(conf).primary_color}; --indicator-bottom: ${20 + get(dockOverlap)}px;`
      )}
      $={ self => {
        onCleanup(() => destroyWindow(self))
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