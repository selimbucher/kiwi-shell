import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding } from "ags"
import AstalWp from "gi://AstalWp"
import { timeout } from "ags/time"
import { exec } from "ags/process"
import { Accessor } from "ags"

import { volumeIcon, brightnessIcon, keyboardBrightnessIcon } from "./iconNames"
import { primaryColor } from "./config"
import { brightness } from "./polls"
import { keyboardBrightness, max_keyboardBrightness, hasKbdBacklight } from "./polls"

import { conf } from "./config"

const fadeTimeout = 2500

const wp = AstalWp.get_default()
const volumeBinding = createBinding(wp.audio.defaultSpeaker, 'volume');
const muteBinding = createBinding(wp.audio.defaultSpeaker, 'mute')
const max_brightness = parseInt(exec("brightnessctl max"))
const min_brightness = 10;

const [indicatorType, setIndicatorType] = createState('brightness')
const indicatorValue = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return get(volumeBinding);
    case 'brightness':
      return percentageBrightness(get(brightness));
    case 'keyboardBrightness':
      return get(keyboardBrightness)/max_keyboardBrightness;
    default:
      return 0;
  }
})

const indicatorIcon = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return volumeIcon(get(volumeBinding), get(muteBinding));
    case 'brightness':
      return brightnessIcon(get(brightness), max_brightness);
    case 'keyboardBrightness':
      return keyboardBrightnessIcon(get(keyboardBrightness)/max_keyboardBrightness)
    default:
      return 'question-round-symbolic';
  }
})

const isSensitive = createComputed(get => {
  switch (get(indicatorType)) {
    case 'volume':
      return true
    case 'brightness':
      return true;
    default:
      return false;
  }
})


const [isVisible, setVisibility] = createState(false)

let timer;
export function showIndicator(type: string){
  setIndicatorType(type)
  setVisibility(true);
  resetIndicatorTimeout() 
}
function resetIndicatorTimeout() {
  if (timer) {
    timer.cancel();
  }
  timer = timeout(fadeTimeout, () => setVisibility(false));
}

let waiting = true;
timeout(500, () => {
  waiting = false
})

if (hasKbdBacklight) {
  keyboardBrightness.subscribe(() => {
    if (waiting) return;
    setIndicatorType('keyboardBrightness');
    setVisibility(true);
    resetIndicatorTimeout();
  });
}


export default function IndicatorBar(gdkmonitor: Gdk.Monitor) {

  return (
    <window
      css={primaryColor(hex => 
        `--primary: ${hex};`
      )}
      visible={isVisible}
      name="ags-indicator"
      class={conf.as(conf =>
        `IndicatorBar theme-${conf.theme}`
      )}
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.NORMAL}
      anchor={
        Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT
      }
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
      exec(`brightnessctl set ${absoluteBrightness(value)}`)
      return;
    default:
      return;
  }
}

function Indicator(){
  return (
    <centerbox class="indicator-bar">
      <box $type="center" class="indicator-box">
        <Gtk.Image
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
      />
      </box>
    </centerbox>
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