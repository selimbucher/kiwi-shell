import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, createMemo, createState, onCleanup, With, type Accessor } from "ags"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import Mpris from "gi://AstalMpris"
import AstalCava from "gi://AstalCava"
import Hyprland from "gi://AstalHyprland"

import { conf } from "../../config"
import { giconForEntry } from "../../appIcon"
import { loadThumbnail } from "../../services/wallpaper"
import { coverFile, fetchedCover, isWebCover } from "../../services/covers"
import { screenSeen } from "../../services/screen"
import { easeOutCubic } from "../../MissionControl/motion"
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
// the process behind each player's bus name (below: not over its own app)
const [playerPids, setPlayerPids] = createState(new Map<string, number>())

// A name's process is asked again once it has gone: a player that quits and
// comes back (Spotify restarted) is another process under the same name.
function forgetPids(players: Mpris.Player[]) {
    const gone = [...playerPids().keys()].filter(name => !players.some(p => p.bus_name === name))
    if (!gone.length) return
    const pids = new Map(playerPids())
    for (const name of gone) pids.delete(name)
    setPlayerPids(pids)
}

const [current, setCurrent] = createState<Mpris.Player | null>(null)
let lingerTimer = 0

// A player is taken up once it plays something with a name, and kept while
// it's there: between two songs a browser says the title is empty for a moment.
function choose() {
    const players = mpris.get_players().filter(p => p.bus_name !== PROXY)
    for (const p of players)
        if (playing(p) && !startedAt.has(p.bus_name)) startedAt.set(p.bus_name, GLib.get_monotonic_time())
    // a player gone while playing starts afresh when it's back
    for (const name of startedAt.keys())
        if (!players.some(p => p.bus_name === name && playing(p))) startedAt.delete(name)

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
        // its position only while its card shows it (Expanded): asked every
        // second, it woke the player and the shell all day (kiwi's patch to
        // AstalMpris, patches/astal-mpris-poll-position.patch)
        p.poll_position = false
        watched.set(p, [
            p.connect("notify::playback-status", choose),
            p.connect("notify::title", choose),
        ])
    }
    forgetPids(players)
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

function windowOf(player: Mpris.Player): Hyprland.Client | undefined {
    const pid = playerPids().get(player.bus_name)
    return pid ? hyprland.get_clients()
        .filter(c => c.get_pid() === pid)
        .sort((a, b) => a.focus_history_id - b.focus_history_id)[0] : undefined
}

function showApp(player: Mpris.Player) {
    const window = windowOf(player)
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

        /** Out of nothing, briefly: a cover that arrived after its place showed. */
        fadeIn() {
            this.set_opacity(0)
            let start = 0
            this.add_tick_callback((_w, clock) => {
                const now = clock.get_frame_time()
                if (!start) start = now
                const t = Math.min(1, (now - start) / (COVER_FADE_MS * 1000))
                this.set_opacity(easeOutCubic(t))
                return t < 1 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
            })
        }

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

// Covers decoded, the last few: one coming back (an alert gone, the card
// closed) is a new widget, and decoded again it got its picture halfway
// through fading in, or after.
const decoded = new Map<string, Gdk.Texture>()
const DECODED_KEEP = 12

function decodedCover(file: string, size: number, then: (texture: Gdk.Texture | null) => void): Gdk.Texture | null {
    const key = `${size}:${file}`
    const known = decoded.get(key)
    if (known) {
        decoded.delete(key)
        decoded.set(key, known)
        return known
    }
    // decoded off the main loop, at the size it is shown
    void loadThumbnail(file, size, size, false).then(texture => {
        if (!texture) return then(null)
        decoded.set(key, texture)
        for (const old of decoded.keys()) if (decoded.size > DECODED_KEEP) decoded.delete(old)
        then(texture)
    })
    return null
}

// The cover: AstalMpris's file, a browser's own, or one on the web, which
// kiwi fetches (gvfs is off, services/covers.ts). A new one is fetched and
// decoded before it shows: the old one stays till then, and a place that had
// none yet stays empty, the cover fading in. The app's icon only for a song
// without a cover at all; it flashed in while a new one came.
const NO_COVER = "none"
const COVER_FADE_MS = 180

function Cover({ player, size }: { player: Mpris.Player; size: number }) {
    // the player's own URL, not AstalMpris's copy of it (cover_art): it copies
    // a web one through gvfs, and with that off the copy fails and keeps the
    // one before, the cover stuck on an old song
    const source = createBinding(player, "art_url").as(url => String(url || ""))
    // null while the first one comes
    const [art, setArt] = createState<Gdk.Texture | typeof NO_COVER | null>(null)
    let wanted = ""
    const show = (asked: string, file: string) => {
        if (!file) return setArt(NO_COVER)
        const now = decodedCover(file, size, texture => { if (wanted === asked) setArt(texture ?? NO_COVER) })
        if (now) setArt(now)
    }
    const look = () => {
        const asked = wanted = source()
        if (!asked) return setArt(NO_COVER)
        if (!isWebCover(asked)) return show(asked, asked.startsWith("file://") ? GLib.filename_from_uri(asked)[0] ?? "" : asked)
        const fetched = fetchedCover(asked)
        if (fetched) return show(asked, fetched)
        void coverFile(asked).then(file => { if (wanted === asked) show(asked, file ?? "") })
    }
    onCleanup(source.subscribe(look))
    look()
    let before: Gdk.Texture | typeof NO_COVER | null = null
    return (
        <box class="island-cover" overflow={Gtk.Overflow.HIDDEN} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER}
            hexpand={false} vexpand={false}>
            <With value={art}>
                {(now: Gdk.Texture | typeof NO_COVER | null) => {
                    const waited = before === null
                    before = now
                    if (now === NO_COVER) return <Gtk.Image class="island-cover-none" gicon={giconForEntry(`${player.entry ?? ""}.desktop`)}
                        pixelSize={size} /> as Gtk.Widget
                    const widget = new CoverArt()
                    widget.size = size
                    widget.texture = now
                    if (now && waited) widget.fadeIn()
                    return widget
                }}
            </With>
        </box>
    )
}

// ─── The bars ─────────────────────────────────────────────────────────────────
// iOS's waveform follows the music: four bars, bass to treble, from cava
// (AstalCava) listening to what the speakers play. It listens only while
// bars are on screen and their player plays; switched off, cava stops
// listening altogether, its thread and timer gone. Paused, the bars settle
// into a row of dots. Nor does it listen while nothing is seen: the session
// locked, the displays switched off (services/screen.ts). Its stream is a
// capture of the speakers, which the privacy dots leave out (privacy.tsx).

const BAR_COUNT = 4
const BAR_WIDTH = 3
const BAR_GAP = 2
const BAR_HEIGHT = 14
// a bar at rest: a dot
const BAR_REST = 3
// how fast the bars settle when the music stops, per second
const SETTLE = 12

// made switched off: on, it would start listening at once
const cava = new AstalCava.Cava({ active: false, autosens: false, bars: BAR_COUNT, framerate: 30, stereo: false })

// How high the bars go is kiwi's, not cava's: cava's own sensitivity
// (autosens) starts from nothing each time it starts listening and climbs
// until the bars overshoot, every bar at the top for a second or so whenever
// they came. Here the top is the loudest of late: it follows a louder bar at
// once and lets go over a couple of seconds, so a quiet song fills the bars
// too, and it is kept from one time the bars listen to the next. Raw, music
// comes in at about 0.2 to 0.6; silence isn't made loud.
const LOUD_START = 0.75
const LOUD_HALF_LIFE = 60 // frames: 2 s
const LOUD_DECAY = Math.pow(0.5, 1 / LOUD_HALF_LIFE)
const LOUD_FLOOR = 0.05
let loud = LOUD_START

const listening = new Set<{ hear(levels: number[]): void }>()

cava.connect("notify::values", () => {
    const values = cava.get_values() ?? []
    loud = Math.max(LOUD_FLOOR, loud * LOUD_DECAY, ...values)
    const levels = Array.from({ length: BAR_COUNT }, (_, i) => Math.max(0, Math.min(1, (values[i] ?? 0) / loud)))
    for (const bars of listening) bars.hear(levels)
})

function listen(bars: { hear(levels: number[]): void }, on: boolean) {
    if (on) listening.add(bars)
    else listening.delete(bars)
    hearIfSeen()
}

// (bars on screen, but the screen locked or off: cava stops all the same)
function hearIfSeen() {
    const active = listening.size > 0 && screenSeen.get()
    if (cava.active !== active) cava.active = active
}
screenSeen.subscribe(hearIfSeen)

const MusicBars = GObject.registerClass(
    { GTypeName: "KiwiIslandMusicBars" },
    class MusicBars extends Gtk.Widget {
        // how high each bar is shown, 0 (a dot) to 1
        private levels = new Array<number>(BAR_COUNT).fill(0)
        private playing = false
        private settling = 0
        private lastTick = 0

        setPlaying(playing: boolean) {
            if (playing === this.playing) return
            this.playing = playing
            this.update()
        }

        // listening while mapped and playing; settling down otherwise
        private update() {
            const on = this.playing && this.get_mapped()
            listen(this, on)
            if (!on && !this.settling && this.levels.some(l => l > 0)) {
                this.lastTick = 0
                this.settling = this.add_tick_callback((_w, clock) => this.settle(clock.get_frame_time()))
            }
        }

        // drawn again only when a bar moves: silence, as between two
        // songs, draws nothing
        hear(levels: number[]) {
            let moved = false
            for (let i = 0; i < BAR_COUNT; i++) {
                const level = levels[i]
                if (Math.abs(level - this.levels[i]) * (BAR_HEIGHT - BAR_REST) < 0.25) continue
                this.levels[i] = level
                moved = true
            }
            if (moved) this.queue_draw()
        }

        private settle(now: number): boolean {
            const dt = this.lastTick ? (now - this.lastTick) / 1e6 : 0
            this.lastTick = now
            const keep = Math.exp(-SETTLE * dt)
            this.levels = this.levels.map(l => l * keep < 0.01 ? 0 : l * keep)
            this.queue_draw()
            if (this.levels.some(l => l > 0)) return GLib.SOURCE_CONTINUE
            this.settling = 0
            return GLib.SOURCE_REMOVE
        }

        vfunc_map(): void {
            super.vfunc_map()
            this.update()
        }

        vfunc_unmap(): void {
            listen(this, false)
            if (this.settling) this.remove_tick_callback(this.settling)
            this.settling = 0
            super.vfunc_unmap()
        }

        vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
            const size = orientation === Gtk.Orientation.HORIZONTAL ? BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP : BAR_HEIGHT
            return [size, size, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            const color = this.get_color()
            const middle = this.get_height() / 2
            const radius = new Graphene.Size().init(BAR_WIDTH / 2, BAR_WIDTH / 2)
            this.levels.forEach((level, i) => {
                const h = BAR_REST + (BAR_HEIGHT - BAR_REST) * level
                const rect = new Graphene.Rect().init(i * (BAR_WIDTH + BAR_GAP), middle - h / 2, BAR_WIDTH, h)
                snapshot.push_rounded_clip(new Gsk.RoundedRect().init(rect, radius, radius, radius, radius))
                snapshot.append_color(color, rect)
                snapshot.pop()
            })
        }
    },
)

function Bars({ player }: { player: Mpris.Player }) {
    const bars = new MusicBars({ cssClasses: ["island-bars"], valign: Gtk.Align.CENTER })
    const playing = () => bars.setPlaying(player.playback_status === Mpris.PlaybackStatus.PLAYING)
    const id = player.connect("notify::playback-status", playing)
    playing()
    onCleanup(() => {
        player.disconnect(id)
        bars.setPlaying(false)
    })
    return bars
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

/** Back, play or pause, forward: in the card. */
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
    // the position kept up while the card is open (watch)
    player.poll_position = true
    onCleanup(() => { player.poll_position = false })
    const title = createBinding(player, "title").as(t => String(t ?? ""))
    const artist = createBinding(player, "artist").as(a => String(a ?? ""))
    const position = createBinding(player, "position")
    const length = createBinding(player, "length")
    // Where the knob is taken, while the pointer has it and until the player
    // is there: the knob and the time show that rather than the player's
    // position, which comes once a second and pulled the knob back from
    // under the pointer. It is gone to once, as it is let go — every step of
    // a drag was a seek, and Spotify skipped back and forth through them.
    const [aim, setAim] = createState<number | null>(null)
    const shown = createComputed(get => get(aim) ?? get(position))
    const left = createComputed(get => Math.max(0, get(length) - get(shown)))
    let holding = false
    let landing = 0
    const land = () => {
        if (landing) GLib.source_remove(landing)
        landing = 0
        setAim(null)
    }
    onCleanup(() => { if (landing) GLib.source_remove(landing) })
    // the player there: the aim gives way to its position
    onCleanup(position.subscribe(() => {
        const a = aim.peek()
        if (!holding && a !== null && Math.abs(position.peek() - a) < 1.5) land()
    }))
    const seek = (to: number) => {
        player.set_position(to)
        if (landing) GLib.source_remove(landing)
        // (or it never says, a player without position updates)
        landing = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            landing = 0
            setAim(null)
            return GLib.SOURCE_REMOVE
        })
    }

    return (
        <box class="island-card island-media" orientation={Gtk.Orientation.VERTICAL}>
            <box class="head">
                <button class="cover-button" tooltipText="Show the app" onClicked={() => showApp(player)}>
                    <Cover player={player} size={52} />
                </button>
                <box class="titles" orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                    <label class="title" label={title} xalign={0} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} hexpand />
                    <label class="artist" label={artist} xalign={0} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} hexpand />
                </box>
                <Bars player={player} />
            </box>
            <box class="progress" orientation={Gtk.Orientation.VERTICAL} visible={length(l => l > 0)}>
                <slider hexpand min={0} max={length} value={shown}
                    sensitive={createBinding(player, "can_seek")}
                    // (the value given: the slider's own is the one before it,
                    // the first of the two times the signal comes)
                    onChangeValue={(_self: Gtk.Widget, _scroll: Gtk.ScrollType, value: number) => {
                        value = Math.min(length.peek(), Math.max(0, value))
                        setAim(value)
                        if (!holding) seek(value)
                    }}
                    $={(self) => {
                        // the pointer or a finger on it, seen before the slider does
                        const hand = new Gtk.EventControllerLegacy({ propagationPhase: Gtk.PropagationPhase.CAPTURE })
                        hand.connect("event", (_c, event: Gdk.Event) => {
                            const type = event.get_event_type()
                            if (type === Gdk.EventType.BUTTON_PRESS || type === Gdk.EventType.TOUCH_BEGIN) {
                                holding = true
                                setAim(self.value)
                            } else if (type === Gdk.EventType.BUTTON_RELEASE || type === Gdk.EventType.TOUCH_END || type === Gdk.EventType.TOUCH_CANCEL) {
                                if (!holding) return false
                                holding = false
                                const to = aim.peek()
                                if (to !== null) seek(to)
                            }
                            return false
                        })
                        self.add_controller(hand)
                    }} />
                <box class="times">
                    <label class="time" label={shown(time)} hexpand xalign={0} />
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
        minimal: () => <Cover player={player} size={20} /> as Gtk.Widget,
        expanded: () => <Expanded player={player} /> as Gtk.Widget,
    } satisfies Activity
})

addActivitySource(activity)
