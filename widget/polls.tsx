import { createPoll } from "ags/time";
import { exec } from "ags/process";
import { readFile } from "ags/file";
import { createComputed } from "gnim";

export const brightness = createPoll(0, 200, () => {
  return parseInt(exec("brightnessctl get"))
})

const keyboardBrightnessPath = exec("sh -c 'echo /sys/class/leds/*kbd*/brightness'")
export const keyboardBrightness= createPoll(
  0, 200, (prev) => {
    return parseInt(readFile(keyboardBrightnessPath))
  }
)
export const max_keyboardBrightness = parseInt(readFile(exec("sh -c 'echo /sys/class/leds/*kbd*/max_brightness'")))