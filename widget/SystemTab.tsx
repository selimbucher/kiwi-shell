import { Gtk } from "ags/gtk4"
import { MediaPlayer } from "./Misc"
import { exec, execAsync } from "ags/process"
import { createState, createBinding, createComputed, With } from "ags"
import { createPoll } from "ags/time"


import AstalWp from "gi://AstalWp"
import AstalPowerProfiles from "gi://AstalPowerProfiles"

import { powerProfileIcon, volumeIcon, brightnessIcon } from "./iconNames"
import { brightness } from "./polls"

const [nightShift, setNightShift] = createState(false);

const max_brightness = parseInt(exec("brightnessctl max"))
const nightShiftTemp = 4000;


const hasBacklight = exec(`sh -c 'ls /sys/class/backlight/ | grep -q . && echo yes || echo no'`).trim() === 'yes';

const activePowerProfile = hasBacklight ? "power-saver" : "performance"
const defaultPowerProfile = "balanced"

const wp = AstalWp.get_default()
const mic = wp.audio.defaultMicrophone;
const powerprofiles = AstalPowerProfiles.get_default()


const speakerBinding = createBinding(wp.audio, "defaultSpeaker")
const micMutedBinding = createBinding(mic, "mute")
const powerProfileBinding = createBinding(powerprofiles, "activeProfile");

const accent = "#b38dff"

function powerProfileName(profile: string) {
  if (profile == "performance") {
    return "Performance"
  }
  if (profile == "balanced") {
    return "Balanced"
  }
  if (profile == "power-saver") {
    return "Power Saver"
  }
  return "Unkown Powerprofile"
}

export default function SystemTab({ visible }) {
  return (
    <box class="tab-content" visible={visible} orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box class="large-header">
        General Options
      </box>
      <Sliders />
      <OptionButtons />
      <MediaPlayer />
    </box>
  )
}

function PowerProfiles({setPpOpen}){
  return (
    <box
          orientation={Gtk.Orientation.VERTICAL}
          class="tiny-dropdown"
          spacing={4}
          marginTop={4}
          marginBottom={6}
          marginStart={8}
          marginEnd={8}
        >
          <button
            class="menu-item"
            onClicked={() => { execAsync("powerprofilesctl set power-saver"); setPpOpen(false) }}
          >
            Power Saver
          </button>
          <button
            class="menu-item"
            onClicked={() => { execAsync("powerprofilesctl set balanced"); setPpOpen(false) }}
          >
            Balanced
          </button>
          <button
            class="menu-item"
            onClicked={() => { execAsync("powerprofilesctl set performance"); setPpOpen(false) }}
          >
            Performance
          </button>
        </box>
  )
}

function OptionButtons(){
  const spacing = 6
  const [ppOpen, setPpOpen] = createState(false)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} class="option-buttons" spacing={spacing}>
      <box class="row dropdown" spacing={spacing}>
        {/* main option as its own button */}
        <button
        class={powerProfileBinding.as( p =>
          (p != defaultPowerProfile) ? 'option active' : 'option'
        )}
        hexpand={true}
          onClicked={() => {
            if (powerProfileBinding.get() == defaultPowerProfile) {
              execAsync(`powerprofilesctl set ${activePowerProfile}`);
            } else {
              execAsync(`powerprofilesctl set ${defaultPowerProfile}`);
            }
            setPpOpen(false)
          }}
        >
          <box>
            <Gtk.Image iconName={powerProfileBinding.as(powerProfileIcon)} pixelSize={17} class={powerProfileBinding.as(p => 'icon-'+p)}/>
            <label label={powerProfileBinding.as(powerProfileName)} />
          </box>
        </button>

        {/* separate arrow button (not nested) */}
        <button
          class="bar-button"
          onClicked={() => setPpOpen(v => !v)}
        >
          <Gtk.Image
            iconName={ppOpen(v => v ? "arrow-up-symbolic" : "arrow-down-tiny-symbolic")}
            pixelSize={16}
            hexpand={false}
          />
        </button>
      </box>

      <revealer
        reveal_child={ppOpen}
        transition_type={Gtk.RevealerTransitionType.SLIDE_DOWN}
      >
        <PowerProfiles setPpOpen={setPpOpen}/>
      </revealer>

      <box class="row" spacing={spacing}>
        <button
          class={nightShift.as(b => b ? 'option active' : 'option')}
          onClicked={() =>{
              if (nightShift.get()) {
                setNightShift(false);
                execAsync("killall hyprsunset")
              } else {
                setNightShift(true);
                execAsync(`hyprsunset -t ${nightShiftTemp}`)
              }

          }}
          >
          <box>
            <Gtk.Image iconName="night-light-symbolic" pixelSize={17}/>
            <label label="Night Shift" />
            <box hexpand={true} />
          </box>
        </button>
        <button
          class="option"
          onClicked={() => {
            mic.mute = !micMutedBinding.get()
          }}
        >
          <Gtk.Image iconName={micMutedBinding.as(b =>
            b ? "audio-input-microphone-muted-symbolic" : "audio-input-microphone-symbolic"
          )}
          
           pixelSize={17}/>
        </button>
         <button class="option">
          <Gtk.Image iconName="notifications-applet-symbolic" pixelSize={17}/>
        </button>
        <button class="option"
        onClicked={() => {
          console.log(wp.audio.recorders)
        }}
        >
          <Gtk.Image iconName="preferences-system-symbolic" pixelSize={17}/>
        </button>
      </box>
    </box>
  )
}

function Sliders() {
  return (
    <box class="sliders" orientation={Gtk.Orientation.VERTICAL}>
      <With value={speakerBinding}>
        {(spk) => {
          if (!spk) {
            return (
              <box class="slider-container">
                <button class="bar-button" sensitive={false}>
                  <Gtk.Image class="icon volumeIcon" pixelSize={16} iconName="audio-volume-muted-symbolic" />
                </button>
                <slider hexpand={true} draw_value={false} min={0} max={1} step={0.01} value={0} sensitive={false}/>
              </box>
            )
          }

          const volB = createBinding(spk, "volume")
          const muteB = createBinding(spk, "mute")

          return (
            <box class="slider-container">
              <button class="bar-button" onClicked={() => { spk.mute = !spk.mute }}>
                <Gtk.Image
                  class="icon volumeIcon"
                  pixelSize={16}
                  iconName={createComputed((get) => volumeIcon(get(volB), get(muteB)))}
                />
              </button>
              <slider
                hexpand={true}
                draw_value={false}
                min={0}
                max={1}
                step={0.01}
                value={volB}
                onChangeValue={(self) => {
                  spk.volume = self.value
                  spk.mute = false
                }}
              />
            </box>
          )
        }}
      </With>
      <box visible={hasBacklight} class="slider-container">
        <button class="bar-button">
          <Gtk.Image 
            class="icon brightnessIcon"
            pixelSize={16}
            iconName={
              createComputed(
                (get) => brightnessIcon(get(brightness), max_brightness)
              )}
          />
        </button>
        <slider
          hexpand={true}
          draw_value={false}
          min={10}
          max={max_brightness}
          step={1}
          value={brightness}
          onChangeValue={(self) => {
            exec(`brightnessctl set ${self.value}`)
          }}
        />
      </box>
    </box>
  )
}