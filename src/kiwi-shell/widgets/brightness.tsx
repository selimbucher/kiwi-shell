import { monitorFile, readFile } from "ags/file"
import { exec, execAsync } from "ags/process"
import { createState } from "ags"

const iface = exec("sh -c 'ls -w1 /sys/class/backlight | head -1'").trim()
const max = Number(exec("brightnessctl max"))
const brightnessFile = `/sys/class/backlight/${iface}/brightness`

const getCurrent = () => Number(readFile(brightnessFile).trim()) / max

// @ts-ignore
export const [brightness, setBrightness] = createState(getCurrent())

monitorFile(brightnessFile, () => {
    setBrightness(getCurrent())
})

export function setBrightnessLevel(percent: number) {
    const clamped = Math.max(0, Math.min(1, percent))
    execAsync(`brightnessctl set ${Math.round(clamped * 100)}% -q`)
}