import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import AstalWp from "gi://AstalWp"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

import { logger } from "../../../log"

const log = logger("island")

// ─── Privacy dots ─────────────────────────────────────────────────────────────
// iOS's and macOS's: orange while an app records the microphone, green while
// one films with the camera; macOS adds a screen icon while the screen is
// recorded or shared, purple here. Apps are only seen through PipeWire, the
// way GNOME and KDE see them: an app that opens the camera itself
// (/dev/video*, as Chromium and Zoom do) goes unnoticed, as Linux tells no
// one about it. Screen sharing comes from Hyprland too, which knows about
// every capture, PipeWire or not.

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

function update() {
    const recorders = wp.audio.get_recorders() ?? []
    // muted: recording the default microphone while it's muted, so silence
    const mic = recorders.filter(hearsMicrophone).map(r => {
        const def = wp.audio.defaultMicrophone
        return { app: appOf(r), muted: !!def?.mute && r.target_serial === def.serial }
    })

    const sources = wp.video?.get_sources() ?? []
    const videoRecorders = wp.video?.get_recorders() ?? []
    const watching = (source: AstalWp.Node) =>
        videoRecorders.filter(r => r.target_serial === source.serial).map(r => ({ app: appOf(r) }))

    const camera = sources.filter(s => isCamera(s) && running(s)).flatMap(s => {
        const apps = watching(s)
        return apps.length ? apps : [{ app: SOMEONE }]
    })
    const shared = sources.filter(s => !isCamera(s) && running(s)).flatMap(watching)
    const screen = shared.length ? shared : casting() ? [{ app: SOMEONE }] : []

    const next = { mic: dedupe(mic), camera: dedupe(camera), screen: dedupe(screen) }
    if (JSON.stringify(next) !== JSON.stringify(privacy())) setPrivacy(next)
}

function dedupe(uses: Use[]): Use[] {
    const seen = new Set<string>()
    return uses.filter(u => !seen.has(u.app) && seen.add(u.app))
}

// ─── What to listen to ────────────────────────────────────────────────────────
// Nodes come and go, and a node's state and link change on their own, so
// every node in sight is watched and the set is renewed as it changes.

const watched = new Map<AstalWp.Node, number[]>()

function rewatch() {
    const nodes: AstalWp.Node[] = [
        ...(wp.audio.get_recorders() ?? []),
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
        if (node === wp.audio.defaultMicrophone) ids.push(node.connect("notify::mute", update))
        watched.set(node, ids)
    }
    update()
}

wp.audio.connect("notify::recorders", rewatch)
for (const signal of ["notify::sources", "notify::recorders"]) wp.video?.connect(signal, rewatch)
wp.audio.connect("notify::default-microphone", rewatch)
rewatch()

hyprland.connect("event", (_h: unknown, event: string, data: string) => {
    if (event !== "screencast") return
    const [state] = data.split(",")
    const before = casts
    casts = Math.max(0, casts + (state === "1" ? 1 : -1))
    log.debug(`screencast ${data}, ${casts} running`)
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

const KINDS = [
    { key: "camera", dot: "camera", title: "Camera" },
    { key: "mic", dot: "mic", title: "Microphone" },
    { key: "screen", dot: "screen", title: "Screen" },
] as const

export const anyPrivacy = privacy(p => p.mic.length + p.camera.length + p.screen.length > 0)

/** The dots, at the island's trailing end. */
export function PrivacyDots() {
    return (
        <box class="island-privacy" valign={Gtk.Align.CENTER} visible={anyPrivacy}>
            {KINDS.map(k => <box class={`dot ${k.dot}`} valign={Gtk.Align.CENTER}
                visible={privacy(p => p[k.key].length > 0)} />)}
        </box>
    )
}

/** macOS's list at the top of Control Center: what uses which. */
export function PrivacyCard() {
    return (
        <box class="island-card island-privacy-card" orientation={Gtk.Orientation.VERTICAL}>
            {KINDS.map(k => (
                <box class="use" visible={privacy(p => p[k.key].length > 0)}>
                    <box class={`dot ${k.dot}`} valign={Gtk.Align.CENTER} />
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
