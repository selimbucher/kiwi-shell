import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, createMemo, createState, onCleanup, With, type Accessor } from "ags"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import Mpris from "gi://AstalMpris"
import Hyprland from "gi://AstalHyprland"

import { conf } from "../../config"
import { giconForEntry } from "../../appIcon"
import { loadThumbnail } from "../../services/wallpaper"
import { addActivitySource, collapse, opened, PRIORITY, type Activity } from "../model"
import { focusClient, isMinimized, restoreClient } from "../../Dock/dock-state"

// ─── Now Playing ──────────────────────────────────────────────────────────────
// iOS's: the cover on the leading side, bars on the trailing one, and a
// click opens the controls. It shows while something plays. Paused, it
// stays a little while for a quick resume, then goes, as on iOS (macOS's Now
// Playing menu item stays until the app quits). With several players going,
// the one that started last.

const mpris = Mpris.get_default()

// how long a paused player stays
const LINGER_MS = 10_000

// playerctld stands in for whichever player is current, so it's every
// player twice
const PROXY = "org.mpris.MediaPlayer2.playerctld"

const playing = (p: Mpris.Player) => p.playback_status === Mpris.PlaybackStatus.PLAYING
const named = (p: Mpris.Player) => p.bus_name !== PROXY && !!p.title?.trim()

// when each player last started playing, by bus name
const startedAt = new Map<string, number>()
const watched = new Map<Mpris.Player, number[]>()

const [current, setCurrent] = createState<Mpris.Player | null>(null)
let lingerTimer = 0

// A player is taken up once it plays something with a name, and kept while
// it's there: between two songs a browser says the title is empty for a moment.
function choose() {
    const players = mpris.get_players().filter(p => p.bus_name !== PROXY)
    for (const p of players)
        if (playing(p) && !startedAt.has(p.bus_name)) startedAt.set(p.bus_name, GLib.get_monotonic_time())
    for (const p of players) if (!playing(p)) startedAt.delete(p.bus_name)

    const latest = players.filter(p => playing(p) && (named(p) || p === current()))
        .sort((a, b) => startedAt.get(b.bus_name)! - startedAt.get(a.bus_name)!)[0] ?? null
    if (latest) {
        stopLinger()
        if (latest !== current()) setCurrent(latest)
        return
    }
    const last = current()
    if (!last || !players.includes(last)) {
        stopLinger()
        return setCurrent(null)
    }
    // paused: it stays a while, and as long as its card is open
    if (!lingerTimer) lingerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER_MS, () => {
        lingerTimer = 0
        if (opened()?.id === idOf(last)) return GLib.SOURCE_REMOVE
        if (current() === last && !playing(last)) setCurrent(null)
        return GLib.SOURCE_REMOVE
    })
}

function stopLinger() {
    if (lingerTimer) GLib.source_remove(lingerTimer)
    lingerTimer = 0
}

// a card closed on a paused player lets it go
opened.subscribe(() => {
    const last = current()
    if (!opened() && last && !playing(last) && !lingerTimer) setCurrent(null)
})

function watch() {
    const players = mpris.get_players()
    for (const [p, ids] of watched) {
        if (players.includes(p)) continue
        ids.forEach(id => p.disconnect(id))
        watched.delete(p)
    }
    for (const p of players) {
        if (watched.has(p)) continue
        watched.set(p, [
            p.connect("notify::playback-status", choose),
            p.connect("notify::title", choose),
        ])
    }
    choose()
}

mpris.connect("notify::players", watch)
watch()

const idOf = (p: Mpris.Player) => `media:${p.bus_name}`

// ─── Not over its own app ─────────────────────────────────────────────────────
// iOS shows an app's activity only while the app isn't open: playing in the
// window in front, it's already in view. Here that's the player's window
// having the focus, told by the process behind the player's bus name (asked
// once per player) and the focused window's. A browser is one app whatever
// tab plays, as Safari is on iOS: which tab is showing isn't anything MPRIS
// says. Minimized, the window keeps Hyprland's focus until another takes it,
// but it's out of view: so the focused window's workspace is watched too.

const hyprland = Hyprland.get_default()
const [focusedPid, setFocusedPid] = createState(0)
let focusWatch: { client: Hyprland.Client; id: number } | null = null

function lookAtFocus() {
    const client = hyprland.get_focused_client()
    if (focusWatch?.client !== client) {
        focusWatch?.client.disconnect(focusWatch.id)
        focusWatch = client ? { client, id: client.connect("notify::workspace", lookAtFocus) } : null
    }
    setFocusedPid(client && !isMinimized(client) ? client.get_pid() : 0)
}

hyprland.connect("notify::focused-client", lookAtFocus)
lookAtFocus()

const [playerPids, setPlayerPids] = createState(new Map<string, number>())

function askPid(busName: string) {
    if (playerPids().has(busName)) return
    Gio.DBus.session.call(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID",
        new GLib.Variant("(s)", [busName]), new GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, null,
        (connection, result) => {
            try {
                const [pid] = connection!.call_finish(result).deepUnpack() as [number]
                setPlayerPids(new Map(playerPids()).set(busName, pid))
            } catch {
                // a player gone already, or a bus that won't say: shown as usual
            }
        },
    )
}

const askCurrent = () => { const p = current(); if (p) askPid(p.bus_name) }
current.subscribe(askCurrent)
askCurrent()

// ─── The app ──────────────────────────────────────────────────────────────────
// The player's own window, brought forward (out of the dock if minimized):
// the one of its process that had the focus last. MPRIS's Raise is only
// what's left without one: a browser can't bring itself forward on Wayland,
// so it says it can and does nothing.

function showApp(player: Mpris.Player) {
    const pid = playerPids().get(player.bus_name)
    const window = pid ? hyprland.get_clients()
        .filter(c => c.get_pid() === pid)
        .sort((a, b) => a.focus_history_id - b.focus_history_id)[0] : undefined
    if (window) {
        if (isMinimized(window)) restoreClient(window)
        else focusClient(window)
    } else if (player.can_raise) {
        player.raise()
    }
    collapse()
}

// ─── Views ────────────────────────────────────────────────────────────────────

// A cover is square at any size, whatever shape the art is (a video's is
// wide): the art fills it, its middle shown, as Apple's covers do.
const CoverArt = GObject.registerClass(
    { GTypeName: "KiwiIslandCoverArt" },
    class CoverArt extends Gtk.Widget {
        size = 20
        texture: Gdk.Texture | null = null

        vfunc_measure(): [number, number, number, number] {
            return [this.size, this.size, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            const texture = this.texture
            if (!texture) return
            const w = this.get_width(), h = this.get_height()
            const scale = Math.max(w / texture.get_width(), h / texture.get_height())
            const dw = texture.get_width() * scale, dh = texture.get_height() * scale
            snapshot.push_clip(new Graphene.Rect().init(0, 0, w, h))
            snapshot.append_texture(texture, new Graphene.Rect().init((w - dw) / 2, (h - dh) / 2, dw, dh))
            snapshot.pop()
        }
    },
)

function Cover({ player, size }: { player: Mpris.Player; size: number }) {
    const cover = createBinding(player, "cover_art").as(c => String(c ?? ""))
    return (
        <box class="island-cover" overflow={Gtk.Overflow.HIDDEN} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER}
            hexpand={false} vexpand={false}>
            <With value={cover}>
                {(file: string) => {
                    if (!file) return <Gtk.Image class="island-cover-none" gicon={giconForEntry(`${player.entry ?? ""}.desktop`)}
                        pixelSize={size} /> as Gtk.Widget
                    const art = new CoverArt()
                    art.size = size
                    // decoded off the main loop, at the size it is shown
                    void loadThumbnail(file, size, size, false).then(texture => {
                        art.texture = texture
                        art.queue_draw()
                    })
                    return art
                }}
            </With>
        </box>
    )
}

// iOS's waveform: bars that move while it plays, at rest when paused. The
// motion is the island's own (CSS, style/island.scss), not the sound's.
function Bars({ player }: { player: Mpris.Player }) {
    const playing = createBinding(player, "playback_status").as(s => s === Mpris.PlaybackStatus.PLAYING)
    return (
        <box class={playing(p => p ? "island-bars playing" : "island-bars")} valign={Gtk.Align.CENTER}>
            {[0.55, 1, 0.7, 0.85].map(h => <box class="bar" valign={Gtk.Align.CENTER} heightRequest={Math.round(14 * h)} />)}
        </box>
    )
}

// ─── Play, pause, back, forward ───────────────────────────────────────────────
// Apple's transport symbols (SF Symbols' backward.fill, play.fill, pause.fill,
// forward.fill), drawn here rather than taken from the icon theme, which draws
// them every which way: WhiteSur's 24 px pause sits in its icon's top-left
// corner. Filled, the corners rounded by a stroke of the same colour.

type Glyph = "back" | "play" | "pause" | "forward"

// in a unit square, the way the symbols sit in theirs
const SHAPES: Record<Glyph, [number, number][][]> = {
    play: [[[0.24, 0.15], [0.24, 0.85], [0.84, 0.5]]],
    pause: [
        [[0.24, 0.15], [0.39, 0.15], [0.39, 0.85], [0.24, 0.85]],
        [[0.61, 0.15], [0.76, 0.15], [0.76, 0.85], [0.61, 0.85]],
    ],
    forward: [
        [[0.07, 0.24], [0.07, 0.76], [0.5, 0.5]],
        [[0.5, 0.24], [0.5, 0.76], [0.93, 0.5]],
    ],
    back: [
        [[0.93, 0.24], [0.93, 0.76], [0.5, 0.5]],
        [[0.5, 0.24], [0.5, 0.76], [0.07, 0.5]],
    ],
}

const MediaGlyph = GObject.registerClass(
    { GTypeName: "KiwiMediaGlyph" },
    class MediaGlyph extends Gtk.Widget {
        size = 16
        private _glyph: Glyph = "play"

        get glyph(): Glyph {
            return this._glyph
        }

        set glyph(glyph: Glyph) {
            if (glyph === this._glyph) return
            this._glyph = glyph
            this.queue_draw()
        }

        vfunc_measure(): [number, number, number, number] {
            return [this.size, this.size, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            const s = this.size
            const x0 = (this.get_width() - s) / 2, y0 = (this.get_height() - s) / 2
            const builder = new Gsk.PathBuilder()
            for (const shape of SHAPES[this._glyph]) {
                shape.forEach(([x, y], i) => i === 0
                    ? builder.move_to(x0 + x * s, y0 + y * s)
                    : builder.line_to(x0 + x * s, y0 + y * s))
                builder.close()
            }
            const path = builder.to_path()
            const color = this.get_color()
            snapshot.append_fill(path, Gsk.FillRule.WINDING, color)
            const stroke = new Gsk.Stroke(s * 0.1)
            stroke.set_line_join(Gsk.LineJoin.ROUND)
            snapshot.append_stroke(path, stroke, color)
        }
    },
)

function glyph(kind: Glyph | Accessor<Glyph>, size: number): Gtk.Widget {
    const widget = new MediaGlyph({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
    widget.size = size
    if (typeof kind === "string") widget.glyph = kind
    else {
        widget.glyph = kind()
        const stop = kind.subscribe(() => { widget.glyph = kind() })
        onCleanup(stop)
    }
    return widget
}

/** Back, play or pause, forward: in the card, and in the island pointed at. */
function Controls({ player, size }: { player: Mpris.Player; size: number }) {
    const status = createBinding(player, "playback_status")
    const playPause = status(s => s === Mpris.PlaybackStatus.PLAYING ? "pause" : "play") as Accessor<Glyph>
    return (
        <box class="island-controls" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <button sensitive={createBinding(player, "can_go_previous")}
                onClicked={() => player.previous()}>
                {glyph("back", size)}
            </button>
            <button class="play" onClicked={() => player.play_pause()}>
                {glyph(playPause, Math.round(size * 0.9))}
            </button>
            <button sensitive={createBinding(player, "can_go_next")}
                onClicked={() => player.next()}>
                {glyph("forward", size)}
            </button>
        </box>
    )
}

function time(seconds: number): string {
    if (!(seconds > 0) || seconds > 1e9) return "0:00"
    const s = Math.floor(seconds)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function Expanded({ player }: { player: Mpris.Player }) {
    const title = createBinding(player, "title").as(t => String(t ?? ""))
    const artist = createBinding(player, "artist").as(a => String(a ?? ""))
    const position = createBinding(player, "position")
    const length = createBinding(player, "length")
    const left = createComputed(get => Math.max(0, get(length) - get(position)))

    return (
        <box class="island-card island-media" orientation={Gtk.Orientation.VERTICAL}>
            <box class="head">
                <button class="cover-button" tooltipText="Show the app"
                    onClicked={() => showApp(player)}>
                    <Cover player={player} size={52} />
                </button>
                <box class="titles" orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                    <label class="title" label={title} xalign={0} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} hexpand />
                    <label class="artist" label={artist} xalign={0} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} hexpand />
                </box>
                <Bars player={player} />
            </box>
            <box class="progress" orientation={Gtk.Orientation.VERTICAL} visible={length(l => l > 0)}>
                <slider hexpand min={0} max={length} value={position}
                    sensitive={createBinding(player, "can_seek")}
                    onChangeValue={self => player.set_position(self.value)} />
                <box class="times">
                    <label class="time" label={position(time)} hexpand xalign={0} />
                    <label class="time" label={left(l => `-${time(l)}`)} hexpand xalign={1} />
                </box>
            </box>
            <box class="controls" halign={Gtk.Align.CENTER}>
                <Controls player={player} size={22} />
            </box>
        </box>
    )
}

// which player is shown, if any: none while its app has the focus
const shownPlayer = createMemo(() => {
    const player = current()
    if (!player) return null
    const pid = playerPids().get(player.bus_name)
    return pid && pid === focusedPid() ? null : player
})

const activity = createComputed(get => {
    const player = get(shownPlayer)
    if (!player || !get(conf).island.now_playing) return null
    return {
        id: idOf(player),
        priority: PRIORITY.media,
        leading: () => <Cover player={player} size={20} /> as Gtk.Widget,
        trailing: () => <Bars player={player} /> as Gtk.Widget,
        pointed: () => <Controls player={player} size={14} /> as Gtk.Widget,
        minimal: () => <Cover player={player} size={20} /> as Gtk.Widget,
        expanded: () => <Expanded player={player} /> as Gtk.Widget,
    } satisfies Activity
})

addActivitySource(activity)
