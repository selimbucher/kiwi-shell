import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"
import { createState } from "ags"
import GLib from "gi://GLib"
import { logger } from "../log"
import { listDir, readNumber, readText } from "./sysfs"

const log = logger("brightness")

// Both lights are read straight from sysfs and set through brightnessctl,
// which goes through logind and so needs no write access to the files. The
// device is always named to it: left to itself it takes the first one it
// finds, which need not be the one read here. Without brightnessctl the
// levels still show, they just can't be changed from the shell.

type Light = { cls: "backlight" | "leds", name: string, max: number }

function light(cls: Light["cls"], name: string): Light | null {
    const max = readNumber(`/sys/class/${cls}/${name}/max_brightness`)
    return max !== null && max > 0 ? { cls, name, max } : null
}

const hasBrightnessctl = GLib.find_program_in_path("brightnessctl") !== null

function level(l: Light): number | null {
    const raw = readNumber(`/sys/class/${l.cls}/${l.name}/brightness`)
    return raw === null ? null : Math.max(0, Math.min(1, raw / l.max))
}

let setFailed = false

function setLevel(l: Light, percent: number) {
    const raw = Math.round(Math.max(0, Math.min(1, percent)) * l.max)
    execAsync(["brightnessctl", "-q", "-d", l.name, "set", String(raw)]).catch(e => {
        // a slider drag sends dozens of these, so a missing permission is
        // reported once rather than for every step
        if (setFailed) return
        setFailed = true
        log.warn(`brightnessctl could not set ${l.name}:`, e)
    })
}

// ─── Screen brightness ────────────────────────────────────────────────────────

// When a panel has more than one interface the kernel's advice is firmware
// over platform over raw (sysfs-class-backlight). An external monitor driven
// over DDC/CI (ddcci*) comes last, since the brightness keys and the slider
// mean the built-in panel.
function findBacklight(): Light | null {
    const rank = (name: string) => {
        const type = ["firmware", "platform", "raw"].indexOf(
            readText(`/sys/class/backlight/${name}/type`) ?? "")
        return (name.startsWith("ddcci") ? 10 : 0) + (type < 0 ? 3 : type)
    }
    const names = listDir("/sys/class/backlight").sort((a, b) =>
        rank(a) - rank(b) || a.localeCompare(b))
    for (const name of names) {
        const l = light("backlight", name)
        if (l) return l
    }
    return null
}

const screen = findBacklight()
export const brightnessAvailable = screen !== null
export const brightnessWritable = brightnessAvailable && hasBrightnessctl

if (screen && !hasBrightnessctl)
    log.info(`brightnessctl not found — ${screen.name} is shown but can't be set`)

// @ts-ignore
export const [brightness, setBrightness] = createState(screen ? level(screen) ?? 0 : 0)

// A write to brightness raises a change on it. A change the firmware makes on
// its own (brightness keys it handles itself) is announced on
// actual_brightness instead.
if (screen) {
    const refresh = () => {
        const value = level(screen)
        if (value !== null) setBrightness(value)
    }
    monitorFile(`/sys/class/backlight/${screen.name}/brightness`, refresh)
    monitorFile(`/sys/class/backlight/${screen.name}/actual_brightness`, refresh)
}

export function setBrightnessLevel(percent: number) {
    if (screen && brightnessWritable) setLevel(screen, percent)
}

// ─── Keyboard brightness ──────────────────────────────────────────────────────

// LED names read device:color:function, and a keyboard backlight's function
// is kbd_backlight whoever made it (asus::, tpacpi::, dell::, apple::,
// chromeos::…); the LED core appends _1, _2 when two claim the same name.
// The laptop's own keyboard goes before one that came with an input device
// (inputN::), which may be a keyboard plugged in for now.
function findKbdBacklight(): Light | null {
    const names = listDir("/sys/class/leds")
        .filter(name => /(^|:)kbd_backlight(_\d+)?$/.test(name))
        .sort((a, b) =>
            Number(/^input\d+:/.test(a)) - Number(/^input\d+:/.test(b)) || a.localeCompare(b))
    for (const name of names) {
        const l = light("leds", name)
        if (l) return l
    }
    return null
}

const kbd = findKbdBacklight()
export const kbdAvailable = kbd !== null

// @ts-ignore
export const [kbdBrightness, setKbdBrightness] = createState(kbd ? level(kbd) ?? 0 : 0)

// re-read the level, for the brightness keys: on some keyboards the firmware
// changes it itself and only passes the key on, with no change on the file
export function refreshKbdBrightness() {
    if (!kbd) return
    const value = level(kbd)
    if (value !== null) setKbdBrightness(value)
}

// A write to brightness raises a change on it, from the shell or anyone else.
// A change the keyboard's firmware makes (Fn keys handled by the EC, as on
// ThinkPads and Chromebooks) is announced on brightness_hw_changed, which
// exists only where the driver reports such changes and the kernel was built
// to pass them on (and can't be read until the first one, hence the test for
// the file rather than a read).
if (kbd) {
    const dir = `/sys/class/leds/${kbd.name}`
    monitorFile(`${dir}/brightness`, refreshKbdBrightness)
    if (GLib.file_test(`${dir}/brightness_hw_changed`, GLib.FileTest.EXISTS))
        monitorFile(`${dir}/brightness_hw_changed`, refreshKbdBrightness)
}

export function setKbdBrightnessLevel(percent: number) {
    if (kbd && hasBrightnessctl) setLevel(kbd, percent)
}
