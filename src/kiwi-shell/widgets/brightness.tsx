import { monitorFile, readFile } from "ags/file"
import { exec, execAsync } from "ags/process"
import { createState } from "ags"
import { createPoll } from "ags/time"

// ─── Screen brightness ────────────────────────────────────────────────────────

const iface = exec("sh -c 'ls -w1 /sys/class/backlight | head -1'").trim()
export const brightnessAvailable = iface !== ""

const max = brightnessAvailable ? Number(exec("brightnessctl max")) : 1
const brightnessFile = `/sys/class/backlight/${iface}/brightness`

const getCurrent = () =>
    brightnessAvailable ? Number(readFile(brightnessFile).trim()) / max : 0

// @ts-ignore
export const [brightness, setBrightness] = createState(getCurrent())

if (brightnessAvailable) {
    monitorFile(brightnessFile, () => setBrightness(getCurrent()))
}

export function setBrightnessLevel(percent: number) {
    if (!brightnessAvailable) return
    const clamped = Math.max(0, Math.min(1, percent))
    execAsync(`brightnessctl set ${Math.round(clamped * 100)}% -q`)
}

// ─── Keyboard brightness ──────────────────────────────────────────────────────

const kbdIface = exec("sh -c 'ls -w1 /sys/class/leds | grep -i kbd | head -1'").trim()
export const kbdAvailable = kbdIface !== ""

const kbdMax = kbdAvailable ? Number(exec(`cat /sys/class/leds/${kbdIface}/max_brightness`)) : 1
const kbdFile = `/sys/class/leds/${kbdIface}/brightness`

const getKbdCurrent = () =>
    kbdAvailable ? Number(readFile(kbdFile).trim()) / kbdMax : 0

// @ts-ignore
export const kbdBrightness = kbdAvailable
    ? createPoll(getKbdCurrent(), 200, getKbdCurrent)
    : (() => 0)

export function setKbdBrightnessLevel(percent: number) {
    if (!kbdAvailable) return
    const clamped = Math.max(0, Math.min(1, percent))
    execAsync(`brightnessctl -d ${kbdIface} set ${Math.round(clamped * 100)}% -q`)
}