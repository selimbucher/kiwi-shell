import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { createState, type Accessor } from "ags"
import AstalWp from "gi://AstalWp"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"

import { logger } from "../../../log"
import { capturing } from "../../AppSwitcher/clientCachingService"
import { listDir, readText } from "../../sysfs"
import { entryFromCmdline } from "../../appIcon"

const log = logger("island")

// ─── Privacy dots ─────────────────────────────────────────────────────────────
// iOS's and macOS's: orange while an app records the microphone, green while
// one films with the camera; macOS adds a screen icon while the screen is
// recorded or shared, purple here. Apps are seen through PipeWire, the way
// GNOME and KDE see them, and a camera opened directly (/dev/video*, as
// Chromium and Zoom do) by the kernel's word that its device was opened
// (below). Screen sharing comes from Hyprland too, which knows about every
// capture, PipeWire or not.

const wp = AstalWp.get_default()
const hyprland = Hyprland.get_default()

export type Use = { app: string; muted?: boolean }
export type Privacy = { mic: Use[]; camera: Use[]; screen: Use[] }

const [privacy, setPrivacy] = createState<Privacy>({ mic: [], camera: [], screen: [] })
export { privacy }

// A PipeWire property of the node. AstalWp has it on the node itself (there's
// no `wp` field to reach through: with one, every lookup came back empty, and
// a stream that only meters or records the speakers lit the microphone dot).
const prop = (node: AstalWp.Node, key: string): string | null => {
    try {
        return node.get_pw_property(key) ?? null
    } catch {
        return null
    }
}

// what an app unknown by name is called
const SOMEONE = "An app"

const appOf = (stream: AstalWp.Node) =>
    prop(stream, "application.name") || stream.description || stream.name || SOMEONE

// A stream that only watches a sound's level (pavucontrol's meters) or
// records what plays (a screen recorder's audio) hears no microphone. Any
// other does, whatever it is linked to: a filter in between (noise
// suppression) is no microphone itself, and a dot too many is the safe
// mistake.
function hearsMicrophone(stream: AstalWp.Stream): boolean {
    if (prop(stream, "stream.monitor") === "true") return false
    if (prop(stream, "stream.capture.sink") === "true") return false
    return !wp.audio.get_speakers()?.some(s => s.serial === stream.target_serial)
}

// a camera is a video source that belongs to a device; Hyprland's portal
// makes video sources of its own for every screen it shares
const isCamera = (source: AstalWp.Node) =>
    !!prop(source, "device.id") || !!prop(source, "device.api")

const running = (node: AstalWp.Node) => node.state === AstalWp.NodeState.RUNNING

// Hyprland: how many screen captures run now. It names no app, and it
// counts a screenshot too, which is over within a frame or two: a capture
// counts once it has gone on for a second. kiwi itself never captures for
// longer, so any is someone else's.
const CAST_AFTER_MS = 1000
let casts = 0
let castsSince = 0
let castTimer = 0
const casting = () => casts > 0 && GLib.get_monotonic_time() - castsSince >= CAST_AFTER_MS * 1000

// The microphone a stream hears: the one it was sent to, or the default for
// one that follows it (no target, as most apps do).
const micOf = (stream: AstalWp.Stream) =>
    (stream.target_serial >= 0 ? wp.audio.get_microphones()?.find(m => m.serial === stream.target_serial) : undefined)
        ?? wp.audio.defaultMicrophone

function update() {
    const recorders = wp.audio.get_recorders() ?? []
    // muted: recording a microphone that is muted, so silence
    const mic = recorders.filter(hearsMicrophone).map(r => ({ app: appOf(r), muted: !!micOf(r)?.mute }))

    const sources = wp.video?.get_sources() ?? []
    const videoRecorders = wp.video?.get_recorders() ?? []
    const watching = (source: AstalWp.Node) =>
        videoRecorders.filter(r => r.target_serial === source.serial).map(r => ({ app: appOf(r) }))

    const camera = [...sources.filter(s => isCamera(s) && running(s)).flatMap(s => {
        const apps = watching(s)
        return apps.length ? apps : [{ app: SOMEONE }]
    }), ...directCamera]
    const shared = sources.filter(s => !isCamera(s) && running(s)).flatMap(watching)
    const screen = shared.length ? shared : casting() ? [{ app: SOMEONE }] : []

    const next = { mic: dedupe(mic), camera: dedupe(camera), screen: dedupe(screen) }
    if (JSON.stringify(next) !== JSON.stringify(privacy())) setPrivacy(next)
}

function dedupe(uses: Use[]): Use[] {
    const seen = new Set<string>()
    return uses.filter(u => !seen.has(u.app) && seen.add(u.app))
}

// ─── Cameras opened directly ──────────────────────────────────────────────────
// An app that opens a camera's device itself goes round PipeWire. The kernel
// says when a device file is opened or closed (inotify, through inotifywait,
// one for the cameras and one for cameras coming and going, which says
// nothing about any other device); then who has one open is read from /proc,
// the user's own processes. PipeWire, which has the cameras it streams open,
// is seen above.

let directCamera: Use[] = []
const SELF = Number(GLib.file_read_link("/proc/self"))
// an open is a burst of them, the app trying each device
const DEVICES_SETTLE_MS = 150

const cameraDevices = () => listDir("/dev").filter(name => /^video\d+$/.test(name)).map(name => `/dev/${name}`).sort()

// inotify watches only what may be read: a camera just plugged in is root's
// alone until udev has given it to the user, which a moment later it has
// (and one never given is one no app of the user's opens either)
const readable = (path: string) => {
    try {
        return Gio.File.new_for_path(path).query_info("access::can-read", Gio.FileQueryInfoFlags.NONE, null).get_attribute_boolean("access::can-read")
    } catch {
        return false
    }
}
// how long udev has to do that after a device file appears
const UDEV_SETTLE_MS = 1000

/** The apps with a camera's device open, by name. */
function openingCameras(devices: string[]): Use[] {
    const apps: Use[] = []
    for (const pid of listDir("/proc")) {
        if (!/^\d+$/.test(pid) || Number(pid) === SELF) continue
        const fds = listDir(`/proc/${pid}/fd`)
        let holds = false
        for (const fd of fds) {
            try {
                if (devices.includes(GLib.file_read_link(`/proc/${pid}/fd/${fd}`))) {
                    holds = true
                    break
                }
            } catch { /* closed meanwhile */ }
        }
        if (!holds) continue
        const cmdline = readText(`/proc/${pid}/cmdline`) ?? ""
        const program = GLib.path_get_basename(cmdline.split("\0")[0] || "").replace(/^\.(.+?)-wrapped$/, "$1")
        if (/^(pipewire|wireplumber)$/.test(program)) continue
        const entry = entryFromCmdline(cmdline)
        apps.push({ app: (entry && GioUnix.DesktopAppInfo.new(entry)?.get_name()) || program || SOMEONE })
    }
    return apps
}

let quitting = false

// one line per event from an inotifywait, for as long as it runs; `ended`
// when it stops on its own (a device it watched gone, one it can't read)
function inotifywait(args: string[], onEvent: () => void, ended: () => void): Gio.Subprocess | null {
    try {
        const proc = Gio.Subprocess.new(["inotifywait", "-m", "-q", ...args], Gio.SubprocessFlags.STDOUT_PIPE)
        proc.wait_async(null, () => {
            if (!quitting) ended()
        })
        const lines = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe()! })
        const next = () => lines.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            try {
                const [line] = lines.read_line_finish_utf8(result)
                if (line === null) return // ended
                onEvent()
                next()
            } catch { /* ended */ }
        })
        next()
        return proc
    } catch (e) {
        log.warn("privacy: no word of cameras opened directly (inotifywait):", e as Error)
        return null
    }
}

let opens: Gio.Subprocess | null = null
let watching = ""
let settle = 0
// a watch that stopped on its own soon after it began is begun once more,
// and if that one stops too, left until the device files change
const SHORT_LIVED_MS = 10_000
let retried = ""
let failed = ""
let again = 0

function lookAtCameras() {
    if (settle) GLib.source_remove(settle)
    settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEVICES_SETTLE_MS, () => {
        settle = 0
        const now = dedupe(openingCameras(cameraDevices()))
        if (JSON.stringify(now) === JSON.stringify(directCamera)) return GLib.SOURCE_REMOVE
        directCamera = now
        log.debug(`cameras opened directly: ${now.map(u => u.app).join(", ") || "none"}`)
        update()
        return GLib.SOURCE_REMOVE
    })
}

// anew when the cameras change, a device file of another kind coming or going
// leaving them be
function watchCameras() {
    const devices = cameraDevices().filter(readable)
    const list = devices.join(" ")
    if (list === watching && (opens || !devices.length)) return
    if (list === failed) return
    watching = list
    opens?.force_exit()
    const began = GLib.get_monotonic_time()
    const proc: Gio.Subprocess | null = devices.length ? inotifywait(["-e", "open", "-e", "close", ...devices], lookAtCameras, () => {
        if (opens !== proc) return // replaced
        opens = null
        watching = ""
        if (GLib.get_monotonic_time() - began > SHORT_LIVED_MS * 1000) retried = ""
        if (retried === list) {
            failed = list
            return log.warn(`privacy: no word of cameras opened directly, the watch on ${list} keeps stopping`)
        }
        // once more in a moment, as the cameras are then
        retried = list
        if (again) GLib.source_remove(again)
        again = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UDEV_SETTLE_MS, () => {
            again = 0
            watchCameras()
            return GLib.SOURCE_REMOVE
        })
    }) : null
    opens = proc
    lookAtCameras()
}

// a device file come or gone, once udev is done with it
let plugged = 0
const hotplug = inotifywait(["-e", "create", "-e", "delete", "--format", "%f", "/dev"], () => {
    if (plugged) GLib.source_remove(plugged)
    plugged = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UDEV_SETTLE_MS, () => {
        plugged = 0
        failed = retried = ""
        watchCameras()
        return GLib.SOURCE_REMOVE
    })
}, () => log.warn("privacy: no word of cameras coming and going (inotifywait stopped)"))
watchCameras()
app.connect("shutdown", () => {
    quitting = true
    opens?.force_exit()
    hotplug?.force_exit()
})

// ─── What to listen to ────────────────────────────────────────────────────────
// Nodes come and go, and a node's state and link change on their own, so
// every node in sight is watched and the set is renewed as it changes.

const watched = new Map<AstalWp.Node, number[]>()

function rewatch() {
    const nodes: AstalWp.Node[] = [
        ...(wp.audio.get_recorders() ?? []),
        ...(wp.audio.get_microphones() ?? []),
        // (an object of its own, not the one in the list)
        ...(wp.audio.defaultMicrophone ? [wp.audio.defaultMicrophone] : []),
        ...(wp.video?.get_sources() ?? []),
        ...(wp.video?.get_recorders() ?? []),
    ]
    for (const [node, ids] of watched) {
        if (nodes.includes(node)) continue
        ids.forEach(id => node.disconnect(id))
        watched.delete(node)
    }
    for (const node of nodes) {
        if (watched.has(node)) continue
        const ids = [node.connect("notify::state", update)]
        if (node instanceof AstalWp.Stream) ids.push(node.connect("notify::target-serial", update))
        if (node instanceof AstalWp.Endpoint) ids.push(node.connect("notify::mute", update))
        watched.set(node, ids)
    }
    update()
}

wp.audio.connect("notify::recorders", rewatch)
for (const signal of ["notify::sources", "notify::recorders"]) wp.video?.connect(signal, rewatch)
wp.audio.connect("notify::microphones", rewatch)
wp.audio.connect("notify::default-microphone", rewatch)
rewatch()

// kiwi's own window pictures are captures too (without its plugin it takes
// them itself: clientCachingService), announced alike: one of a window
// starting while kiwi is taking a picture is kiwi's, and not counted. Spamming
// the dock or Alt+Tab lit the dot.
let own = 0

hyprland.connect("event", (_h: unknown, event: string, data: string) => {
    if (event !== "screencast") return
    const [state, type] = data.split(",")
    const before = casts
    if (state === "1") {
        if (type === "window" && capturing()) own++
        else casts++
    } else if (type === "window" && own > 0) own--
    else casts = Math.max(0, casts - 1)
    log.debug(`screencast ${data}, ${casts} running, ${own} kiwi's own`)
    if (before === 0 && casts > 0) {
        castsSince = GLib.get_monotonic_time()
        if (castTimer) GLib.source_remove(castTimer)
        castTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAST_AFTER_MS, () => {
            castTimer = 0
            update()
            return GLib.SOURCE_REMOVE
        })
    }
    update()
})

// ─── Views ────────────────────────────────────────────────────────────────────

// iOS's dots are a phone's lack of room: the bar has room for what each is,
// in its colour, as the bar had the microphone before the island
const KINDS = [
    { key: "camera", tone: "camera", icon: "camera-video-symbolic", title: "Camera" },
    { key: "mic", tone: "mic", icon: "audio-input-microphone-symbolic", title: "Microphone" },
    { key: "screen", tone: "screen", icon: "screencast-recorded-symbolic", title: "Screen" },
] as const

export const anyPrivacy = privacy(p => p.mic.length + p.camera.length + p.screen.length > 0)

// the microphone with nothing but muted ones recording, as the bar had it
const MIC_MUTED = "audio-input-microphone-muted-symbolic"
const iconOf = (k: typeof KINDS[number], p: Privacy) =>
    k.key === "mic" && p.mic.length > 0 && p.mic.every(u => u.muted) ? MIC_MUTED : k.icon

/**
 * The icons, after a line parting them from what's before, or `centered` in
 * what holds them (a bubble, round at least). One coming while others show
 * opens a place for itself and fades in there; the others stay.
 */
export function PrivacyIcons({ parted }: { parted: boolean }) {
    return (
        <box class={parted ? "island-privacy" : "island-privacy bare"} valign={Gtk.Align.CENTER}
            halign={parted ? Gtk.Align.FILL : Gtk.Align.CENTER}>
            {parted ? <box class="parting" valign={Gtk.Align.CENTER} /> : <box visible={false} />}
            {KINDS.map(k => {
                const on = privacy(p => p[k.key].length > 0)
                return (
                    <revealer transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT} transitionDuration={200}
                        revealChild={on} valign={Gtk.Align.CENTER}>
                        <Gtk.Image class={on(o => o ? `kind ${k.tone} on` : `kind ${k.tone}`)}
                            iconName={privacy(p => iconOf(k, p))} pixelSize={14} valign={Gtk.Align.CENTER} />
                    </revealer>
                )
            })}
        </box>
    )
}

/** macOS's list at the top of Control Center: what uses which. */
export function PrivacyCard() {
    return (
        <box class="island-card island-privacy-card" orientation={Gtk.Orientation.VERTICAL}>
            {KINDS.map(k => (
                <box class="use" visible={privacy(p => p[k.key].length > 0)}>
                    <Gtk.Image class={`kind-icon ${k.tone}`} iconName={privacy(p => iconOf(k, p))} pixelSize={16} valign={Gtk.Align.CENTER} />
                    <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                        <label class="kind" label={k.title} xalign={0} />
                        <label class="apps" xalign={0} wrap
                            label={privacy(p => p[k.key].map(u => u.app + (u.muted ? " (muted)" : "")).join(", "))} />
                    </box>
                </box>
            ))}
        </box>
    )
}
