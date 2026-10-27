import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"
import { createState } from "ags"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { logger } from "../log"
import { listDir, readNumber, readText } from "./sysfs"

const log = logger("brightness")

// Both lights are read straight from sysfs and set through logind, which
// lets the session's user set them without write access to the files: a
// call from the shell itself, where brightnessctl (which asks logind the
// same) was a process for every step of a slider drag or a held key.
// brightnessctl where logind can't be asked; it is always told the device,
// or it takes the first one it finds, which need not be the one read here.
// With neither, the levels still show, they just can't be changed from the
// shell.

type Light = { cls: "backlight" | "leds", name: string, max: number }

function light(cls: Light["cls"], name: string): Light | null {
    const max = readNumber(`/sys/class/${cls}/${name}/max_brightness`)
    return max !== null && max > 0 ? { cls, name, max } : null
}

const hasBrightnessctl = GLib.find_program_in_path("brightnessctl") !== null

const systemBus = (() => {
    try { return Gio.DBus.system } catch { return null }
})()

let hasLogind = (() => {
    try {
        const [has] = systemBus!.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "NameHasOwner", new GLib.Variant("(s)", ["org.freedesktop.login1"]), new GLib.VariantType("(b)"),
            Gio.DBusCallFlags.NONE, 1000, null).deepUnpack() as [boolean]
        return has
    } catch {
        return false
    }
})()

const canSet = () => hasLogind || hasBrightnessctl

// The screen's level is the light's square root, near enough what the eye
// sees: its steps (the keys' sixteen, the slider) look even, as a Mac's do.
// Even steps of the light itself are all at the bright end, and the dim end
// was a step or two.
// A keyboard backlight's few levels are taken as they are.
const CURVE = 2

function level(l: Light): number | null {
    const raw = readNumber(`/sys/class/${l.cls}/${l.name}/brightness`)
    if (raw === null) return null
    const light = Math.max(0, Math.min(1, raw / l.max))
    return l.cls === "backlight" ? Math.pow(light, 1 / CURVE) : light
}

// the light for a level; any level above nothing is at least the faintest
function rawFor(l: Light, value: number): number {
    const at = Math.max(0, Math.min(1, value))
    const raw = Math.round((l.cls === "backlight" ? Math.pow(at, CURVE) : at) * l.max)
    return at > 0 ? Math.max(1, raw) : 0
}

// a slider drag sends dozens of these, so a failure is reported once rather
// than for every step
let setFailed = false
function failed(how: string, l: Light, e: unknown) {
    if (setFailed) return
    setFailed = true
    log.warn(`${how} could not set ${l.name}:`, e)
}

function withBrightnessctl(l: Light, raw: number) {
    if (hasBrightnessctl)
        execAsync(["brightnessctl", "-q", "-d", l.name, "set", String(raw)]).catch(e => failed("brightnessctl", l, e))
}

function setLevel(l: Light, value: number) {
    const raw = rawFor(l, value)
    if (!hasLogind || !systemBus) return withBrightnessctl(l, raw)
    systemBus.call("org.freedesktop.login1", "/org/freedesktop/login1/session/auto", "org.freedesktop.login1.Session",
        "SetBrightness", new GLib.Variant("(ssu)", [l.cls, l.name, raw]), null, Gio.DBusCallFlags.NONE, -1, null,
        (bus, result) => {
            try {
                bus!.call_finish(result)
            } catch (e) {
                // not this session's to set (no seat, an inactive one):
                // brightnessctl from here on
                log.warn(`logind could not set ${l.name}, using brightnessctl:`, e)
                hasLogind = false
                withBrightnessctl(l, raw)
            }
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
export const brightnessWritable = brightnessAvailable && canSet()

if (screen && !canSet())
    log.info(`neither logind nor brightnessctl: ${screen.name} is shown but can't be set`)

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
    if (kbd && canSet()) setLevel(kbd, percent)
}
