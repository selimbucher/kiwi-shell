import { logger } from "../../log"
const log = logger("appswitcher")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, createBinding, onCleanup } from "ags"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { playSound } from "../sound"
import { captureWindowToTexture, freshClientSize, getCachedTexture, reservePreviewSize } from "./clientCachingService"
import { isValidClient, isMinimized, restoreClient, focusClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage, iconFileForEntry } from "../appIcon"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { livePreviews, LiveTiles, PreviewPane } from "../services/previews"
import { applyBinds, registerBindSetup, closeWindow, clientSelector, type BindOp } from "../../hypr"
import { shortcut, combo, heldModifierKey, type Shortcut } from "../../shortcuts"
import { globalShortcut } from "../services/globalShortcuts"
import { isOpen as missionControlOpen } from "../MissionControl/MissionControl"

export const [isVisible, setVisibility] = createState(false)
export const [selectedAddress, setSelectedAddress] = createState<string | null>(null)
export const [displayedClients, setDisplayedClients] = createState<any[]>([])

const hyprland = Hyprland.get_default()

// ─── MRU tracking ─────────────────────────────────────────────────────────────
let mruAddresses: string[] = []

hyprland.connect("notify::focused-client", () => {
    const client = hyprland.get_focused_client()
    if (client && isValidClient(client)) {
        const addr = client.get_address()
        mruAddresses = [addr, ...mruAddresses.filter(a => a !== addr)]
        if (mruAddresses.length > 50) mruAddresses.length = 50
    }
})

// ─── App switcher keybinds (shortcuts.app_switcher, default Alt+Tab) ─────────
// Registered on startup and after every config reload (reloads wipe dynamic
// binds); a bind of the Hyprland config on these keys is gone by then
// (shortcuts.ts). The modifier release binds must live in the root submap: a
// bind matches the submap active at key PRESS, and the modifier goes down
// before the submap is entered (isVisible no-ops the stray fires).

let registered: Shortcut | null = null

const openAndStep = (step: 1 | -1) => {
    if (!isVisible()) {
        // under Mission Control it would be chosen from blind
        if (missionControlOpen.get()) return
        showAppSwitcher()
    }
    stepSelection(step)
}
const NEXT = globalShortcut("apps-next", "App switcher: open, or the next window", "press", () => openAndStep(1))
// Shift with the shortcut goes backwards, as on a Mac; opened that way the
// selection starts at the last window
const PREVIOUS = globalShortcut("apps-previous", "App switcher: open, or the previous window", "press", () => openAndStep(-1))
const CONFIRM = globalShortcut("apps-confirm", "App switcher: switch to the selected window",
    "release", executeSelectedAndClose)
const CLOSE = globalShortcut("apps-close", "App switcher: close", "release", hideAppSwitcher)

// what a registration on `s` binds, root and submap, for unbinding
function appSwitcherUnbinds(s: Shortcut): BindOp[] {
    const release = `${s.mods[0]} + ${heldModifierKey(s)}`
    return [
        { unbind: combo(s) },
        { unbind: combo(s, "SHIFT") },
        { unbind: release },
        { submap: "app_switcher", ops: [
            { unbind: combo(s) },
            { unbind: combo(s, "SHIFT") },
            { unbind: release },
            { unbind: `${s.mods[0]} + left` },
            { unbind: `${s.mods[0]} + right` },
            { unbind: "escape" },
            { unbind: `${s.mods[0]} + escape` },
        ] },
    ]
}

async function registerAltTabBinds() {
    const s = shortcut("app_switcher")
    const entry = combo(s)
    const back = combo(s, "SHIFT")
    const release = `${s.mods[0]} + ${heldModifierKey(s)}`

    // applied atomically and in order. Submap definitions append on
    // redefinition, hence the unbinds inside it first.
    const ok = await applyBinds([
        // clear any previous incarnation of the scheme first
        ...appSwitcherUnbinds(s),
        // root: entry, and the modifier-release confirm (see comment above)
        { bind: entry, action: NEXT, description: "kiwi: apps open" },
        { bind: entry, action: { submap: "app_switcher" }, description: "kiwi: apps submap enter" },
        { bind: back, action: PREVIOUS, description: "kiwi: apps open backwards" },
        { bind: back, action: { submap: "app_switcher" }, description: "kiwi: apps submap enter" },
        { bind: release, action: CONFIRM, description: "kiwi: apps confirm",
            flags: { release: true, transparent: true } },
        { bind: release, action: { submap: "reset" }, description: "kiwi: apps submap reset",
            flags: { release: true, transparent: true } },
        // submap: cycling while held, escape failsafes
        { submap: "app_switcher", ops: [
            { bind: entry, action: NEXT, description: "kiwi: apps cycle",
                flags: { repeating: true } },
            { bind: back, action: PREVIOUS, description: "kiwi: apps cycle back",
                flags: { repeating: true } },
            // the arrows move the selection too while the modifier is held
            { bind: `${s.mods[0]} + left`, action: PREVIOUS, description: "kiwi: apps cycle back",
                flags: { repeating: true } },
            { bind: `${s.mods[0]} + right`, action: NEXT, description: "kiwi: apps cycle",
                flags: { repeating: true } },
            { bind: "escape", action: CLOSE, description: "kiwi: apps close",
                flags: { release: true } },
            { bind: "escape", action: { submap: "reset" }, description: "kiwi: apps submap reset",
                flags: { release: true } },
            { bind: `${s.mods[0]} + escape`, action: CLOSE, description: "kiwi: apps close",
                flags: { release: true } },
            { bind: `${s.mods[0]} + escape`, action: { submap: "reset" }, description: "kiwi: apps submap reset",
                flags: { release: true } },
        ] },
    ], "app switcher binds")
    if (ok) {
        registered = s
        log.info(`registered app switcher binds on ${entry} (root + app_switcher submap)`)
    }
}

registerBindSetup("appswitcher", registerAltTabBinds,
    () => registered ? appSwitcherUnbinds(registered) : [])

// ─── Opening and cycling ──────────────────────────────────────────────────────
function showAppSwitcher() {
    const clients = hyprland.get_clients().filter(isValidClient)

    const sortedClients = [...clients].sort((a, b) => {
        const posA = mruAddresses.indexOf(a.get_address())
        const posB = mruAddresses.indexOf(b.get_address())
        return (posA === -1 ? 9999 : posA) - (posB === -1 ? 9999 : posB)
    })

    setDisplayedClients(sortedClients)
    setSelectedAddress(sortedClients.length > 0 ? sortedClients[0].get_address() : null)
    setVisibility(true)
}

function hideAppSwitcher() {
    setVisibility(false)
}

// The compositor draws the tiles for as long as it is told to. Opening again
// with the same windows lays nothing out anew, so the tiles are sent from
// here too, once the surface is up.
isVisible.subscribe(() => {
    if (isVisible()) live.shown()
    else live.hidden()
})

function stepSelection(step: 1 | -1) {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx + step + clients.length) % clients.length].get_address())
}

function executeSelectedAndClose() {
    // the root-submap alt-release bind fires this on every plain Alt
    // release — only act when the switcher is actually open
    if (!isVisible()) return
    const clients = displayedClients()
    const selected = clients.find(c => c.get_address() === selectedAddress())
    if (selected) {
        // focusing a minimized window would pull the special workspace into
        // view — bring the window to the current workspace instead
        if (isMinimized(selected)) restoreClient(selected)
        else focusClient(selected)
    }
    setVisibility(false)
}

// closing from the ✕ keeps the switcher open on the remaining windows — the
// compositor's client-removed event lands too late for the UI, so the list
// updates eagerly here
function closeClientFromSwitcher(client: any) {
    const address = client.get_address()
    closeWindow(clientSelector(client))
    const remaining = displayedClients().filter(c => c.get_address() !== address)
    if (remaining.length === 0) {
        hideAppSwitcher()
        return
    }
    if (selectedAddress() === address) {
        const clients = displayedClients()
        const idx = clients.findIndex(c => c.get_address() === address)
        setSelectedAddress(remaining[Math.min(idx, remaining.length - 1)].get_address())
    }
    setDisplayedClients(remaining)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function AppSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return [
        <window
            namespace={LAYER.switcher}
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-app-switcher"
            class={themeClasses(t => `AppSwitcher ${t}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => {
                live.window = self
                onCleanup(() => {
                    live.hidden()
                    if (live.window === self) live.window = null
                    destroyWindow(self)
                })
            }}
        >
            <Windows gdkmonitor={gdkmonitor} />
        </window>,
        <SwitcherClose gdkmonitor={gdkmonitor} />,
    ]
}

// ─── The × that closes a window ───────────────────────────────────────────────
// On the top-left corner of the window's picture while the pointer is on it,
// as macOS has it in Mission Control. The compositor draws the picture over
// the switcher and would hide anything the switcher put there, so the × is
// in a window of its own one layer up: over the same free part of the display
// as the switcher, which is centred in it, and taking the pointer only on the
// × (Mission Control's has the same reason: MissionControl.tsx, CloseButton).

// where the picture's top-left corner is, on the switcher's surface
type CloseTarget = { address: string; x: number; y: number }
const [closeTarget, setCloseTarget] = createState<CloseTarget | null>(null)
const hoveringClose: { tile: CloseTarget | null; button: boolean } = { tile: null, button: false }
let closeLinger = 0
// a moment after the pointer has left the picture: on its way to the ×
const CLOSE_LINGER_MS = 80
const CLOSE_FADE_MS = 160
const CLOSE_SIZE = 20
const CLOSE_PAD = 3

function settleClose() {
    if (closeLinger) GLib.source_remove(closeLinger)
    closeLinger = 0
    const wanted = () => !isVisible() ? null : hoveringClose.button ? closeTarget.get() : hoveringClose.tile
    const apply = () => {
        const want = wanted(), now = closeTarget.get()
        if (want?.address !== now?.address || want?.x !== now?.x || want?.y !== now?.y) setCloseTarget(want)
    }
    if (wanted()) return apply()
    closeLinger = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_LINGER_MS, () => {
        closeLinger = 0
        apply()
        return GLib.SOURCE_REMOVE
    })
}

isVisible.subscribe(() => {
    if (isVisible()) return
    hoveringClose.tile = null
    hoveringClose.button = false
    settleClose()
})

/** The pointer on a window's picture, or off it (`picture` null). */
function pointAtPicture(address: string, picture: Gtk.Widget | null) {
    const window = live.window
    if (picture && window) {
        const [ok, b] = picture.compute_bounds(window)
        const [dx, dy] = window.get_surface_transform()
        hoveringClose.tile = ok ? { address, x: b.get_x() + dx, y: b.get_y() + dy } : null
    } else if (hoveringClose.tile?.address === address) {
        hoveringClose.tile = null
    }
    settleClose()
}

function SwitcherClose({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    const button = (
        <button class="switcher-close" focusable={false} valign={Gtk.Align.START} halign={Gtk.Align.START}
            marginTop={CLOSE_PAD} marginBottom={CLOSE_PAD} marginStart={CLOSE_PAD} marginEnd={CLOSE_PAD}
            onClicked={() => {
                const address = closeTarget.get()?.address
                const client = displayedClients().find(c => c.get_address() === address)
                hoveringClose.tile = null
                hoveringClose.button = false
                settleClose()
                if (client) closeClientFromSwitcher(client)
            }}>
            <Gtk.Image iconName="window-close-symbolic" pixelSize={11} />
        </button>
    ) as Gtk.Button
    const fixed = new Gtk.Fixed({ hexpand: true, vexpand: true })
    fixed.put(button, 0, 0)
    let twin: Gtk.Window | null = null
    let shown: CloseTarget | null = null
    let fade = 0

    // only the × takes the pointer, and nothing while it is gone
    const region = (rect: number[] | null) => {
        const surface = twin?.get_surface()
        if (!surface) return
        const r = new Cairo.Region()
        if (rect) {
            const box = new Cairo.RectangleInt()
            ;[box.x, box.y, box.width, box.height] = rect
            r.unionRectangle(box)
        }
        surface.set_input_region(r)
    }

    // the switcher's place on its surface is the twin's, down by half of
    // what the twin is taller (both centred in the same free part)
    const place = (t: CloseTarget) => {
        const switcher = live.window
        if (!twin || !switcher) return
        const [dx, dy] = twin.get_surface_transform()
        const below = Math.round((twin.get_height() - switcher.get_height()) / 2)
        const size = CLOSE_SIZE + 2 * CLOSE_PAD
        const x = Math.round(t.x - size / 2), y = Math.round(t.y + below - size / 2)
        fixed.move(button, x - dx, y - dy)
        region([x, y, size, size])
    }

    const fadeTo = (to: number, then?: () => void) => {
        if (fade) button.remove_tick_callback(fade)
        const from = button.get_opacity()
        let start = -1
        fade = button.add_tick_callback((_w, clock) => {
            const now = clock.get_frame_time() / 1000
            if (start < 0) start = now
            const t = Math.min(1, (now - start) / CLOSE_FADE_MS)
            button.set_opacity(from + (to - from) * (1 - Math.pow(1 - t, 3)))
            if (t < 1) return GLib.SOURCE_CONTINUE
            fade = 0
            then?.()
            return GLib.SOURCE_REMOVE
        })
    }

    const follow = () => {
        const want = closeTarget.get()
        if (want) {
            const anew = !shown || shown.address !== want.address
            shown = want
            place(want)
            button.set_visible(true)
            if (anew) button.set_opacity(0)
            fadeTo(1)
            return
        }
        if (!shown) return
        fadeTo(0, () => {
            shown = null
            button.set_visible(false)
            region(null)
        })
    }

    return (
        <window
            namespace={LAYER.switcherClose}
            name="ags-app-switcher-close"
            class={themeClasses(t => `AppSwitcherClose ${t}`)}
            visible={isVisible}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.NONE}
            $={(self) => {
                twin = self
                button.set_visible(false)
                // over the whole free area: it takes no pointer until the × shows
                self.connect("map", () => shown ? place(shown) : region(null))
                // gone with the switcher, not fading on a surface that no
                // longer draws, to come back where it was the next time
                self.connect("unmap", () => {
                    if (fade) button.remove_tick_callback(fade)
                    fade = 0
                    shown = null
                    hoveringClose.button = false
                    button.set_opacity(0)
                    button.set_visible(false)
                })
                // the pointer anywhere the window takes it, which is the ×
                // and the room round it, as the tile it is on gives it up
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", () => { hoveringClose.button = true; settleClose() })
                motion.connect("leave", () => { hoveringClose.button = false; settleClose() })
                self.add_controller(motion)
                const unsubscribe = closeTarget.subscribe(follow)
                onCleanup(() => {
                    unsubscribe()
                    if (twin === self) twin = null
                    destroyWindow(self)
                })
            }}
        >
            {fixed}
        </window>
    )
}

// ─── Where the tiles are ──────────────────────────────────────────────────────
// With kiwi-previews in the compositor the windows are drawn over the tiles
// (services/previews.ts), measured after every layout from the widget that
// holds the picture.

// the picture alone, its title under it: rounded all round
const live = new LiveTiles({
    set: "app-switcher", namespace: LAYER.switcher, motion: "live",
    radius: 6, squareTop: false,
})

// Uniform height, width hugs the window's aspect ratio — the tile IS the
// preview (narrow windows get narrow tiles, same as Windows Alt-Tab).
// Outside the clamps the tile can't hug: those windows are cover-zoomed to
// fill it instead of floating in letterbox space.
//
// The previews are as tall as a quarter of the display at most (layOut).
const HEIGHT_SHARE = 0.25
const MIN_HEIGHT = 140
const MAX_HEIGHT = 280
const TILE_GAP = 12
const MIN_TILE_ASPECT = 0.82
const MAX_TILE_ASPECT = 4.2

// a clamped tile zooms its frame to cover both the minimum width and the height
reservePreviewSize(Math.round(MAX_HEIGHT * MIN_TILE_ASPECT), MAX_HEIGHT)

function rawAspectWidth(w: number, h: number, height: number): number {
    return h > 0 ? Math.round(height * w / h) : Math.round(height * 1.6)
}

const clampTile = (w: number, height: number) =>
    Math.min(Math.round(height * MAX_TILE_ASPECT), Math.max(Math.round(height * MIN_TILE_ASPECT), w))

// tile width from the compositor's freshest size poll — capture pixel
// sizes are NOT used: a window hanging off a workspace edge yields a
// clipped capture, and sizing from it would warp the tile. Astal client
// geometry (stale after resizes) is only the fallback.
function rawPreviewWidth(client: any, height: number): number {
    // a minimized window's frame can predate its move to the scratchpad
    // workspace, whose layout may have resized it — size from the frame
    // on display instead
    if (isMinimized(client)) {
        const cached = getCachedTexture(client.get_address())
        if (cached) return rawAspectWidth(cached.get_width(), cached.get_height(), height)
    }
    const fresh = freshClientSize(client.get_address())
    return fresh
        ? rawAspectWidth(fresh[0], fresh[1], height)
        : rawAspectWidth(client.get_width(), client.get_height(), height)
}

function previewWidth(client: any, height: number): number {
    return clampTile(rawPreviewWidth(client, height), height)
}

// The windows in centred rows across `budget`. One row as long as the
// previews can still be ONE_ROW_SHARE of `tallest` tall, as macOS's switcher
// is a single row; past that, the fewest rows of even length at the tallest
// height that fits.
const ONE_ROW_SHARE = 0.8

function layOut(clients: any[], budget: number, tallest: number) {
    const widths = (height: number) => clients.map(client => previewWidth(client, height) + TILE_GAP)
    const fits = (rows: number, height: number) => {
        const all = widths(height)
        const total = all.reduce((a, b) => a + b, 0)
        return Math.max(...all) <= budget && total <= budget * rows - (rows - 1) * Math.max(...all)
    }
    // even rows: each takes windows until it has its share of the total width
    const split = (rows: number, height: number) => {
        const all = widths(height)
        const share = all.reduce((a, b) => a + b, 0) / rows
        const out: any[][] = [[]]
        let width = 0
        clients.forEach((client, i) => {
            if (out.length < rows && out[out.length - 1].length > 0 && width + all[i] / 2 > share * out.length) out.push([])
            out[out.length - 1].push(client)
            width += all[i]
        })
        return out
    }
    const tallestFitting = (rows: number, lowest: number) => {
        for (let height = tallest; height >= lowest; height -= 2)
            if (fits(rows, height)) return height
        return null
    }
    if (clients.length === 0) return { height: tallest, rows: [] as any[][] }
    const one = tallestFitting(1, Math.round(tallest * ONE_ROW_SHARE))
    if (one) return { height: one, rows: [clients] }
    for (let rows = 2; rows < clients.length; rows++) {
        const height = tallestFitting(rows, MIN_HEIGHT)
        if (height) return { height, rows: split(rows, height) }
    }
    return { height: MIN_HEIGHT, rows: clients.map(c => [c]) }
}

function Windows({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // previews wrap into centered rows instead of shrinking. Chunked by
    // hand: card widths are known upfront, and GtkFlowBox is a grid in
    // disguise — it stretches cards to uniform column widths.
    // Laid out as it opens, for the display it opens on (displayedClients
    // is set then): the display focused or a setting changed while it was
    // hidden rebuilt every picture for nothing.
    const layout = createComputed(get => {
        const monitor = popupGdkMonitor.peek() ?? gdkmonitor
        const { width, height } = monitor.get_geometry()
        // rows wrap well before the screen edge so the panel never reads
        // as a full-width band
        const tallest = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height * HEIGHT_SHARE)))
        return layOut(get(displayedClients), width * 0.88, tallest)
    })

    const pane = (
        <box
            class="app-switch-container app-switcher"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={TILE_GAP}
            // hug the rows — FILL (the default) would stretch the
            // panel to the full window width, erasing the edge gap
            halign={Gtk.Align.CENTER}
        >
            <For each={layout(l => l.rows.map(row => ({ row, height: l.height })))}>
                {({ row, height }) => (
                    <box spacing={TILE_GAP} halign={Gtk.Align.CENTER}>
                        {row.map(client => <WindowPreview client={client} height={height} />)}
                    </box>
                )}
            </For>
        </box>
    ) as Gtk.Box

    // the pane hangs in the box that tells when the tiles move, and holds off
    // drawing until the compositor has them
    const holder = new PreviewPane({ halign: Gtk.Align.CENTER })
    holder.append(pane)
    holder.onLayout = () => live.measure()
    live.pane = holder
    onCleanup(() => {
        if (live.pane === holder) live.pane = null
    })

    const menu = new Gtk.CenterBox({ cssClasses: ["app-switch-menu"] })
    menu.set_center_widget(holder)
    return menu
}

export function WindowPreview({ client, height }: { client: any, height: number }) {
    if (!client) return null

    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    // with kiwi-previews the compositor draws the window itself, live, and
    // nothing is captured
    createEffect(() => {
        if (!isVisible() || livePreviews()) return
        captureWindowToTexture(address).then(t => {
            if (t) setTexture(t)
        })
    })


    const titleBinding = createBinding(client, "title")

    const activate = () => {
        if (isMinimized(client)) restoreClient(client)
        else focusClient(client)
        setVisibility(false)
    }

    // the tile is a real button (click to switch, Windows style); the ✕
    // floats in a sibling overlay layer above it, so the two never fight
    // over clicks — no nested buttons, no gesture filtering
    // maxWidthChars=1 lets the ellipsized label shrink below its natural
    // width instead of clipping early
    const title = (
        <label
            class="preview-title"
            label={titleBinding}
            ellipsize={Pango.EllipsizeMode.END}
            maxWidthChars={1}
            hexpand
            xalign={0.5}
        />
    )
    // the picture, for the × on its corner (SwitcherClose)
    let picture: Gtk.Widget | null = null
    const tile = (
        <button class="app-preview" onclicked={activate}
            $={(self: Gtk.Widget) => {
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", () => pointAtPicture(address, picture))
                motion.connect("leave", () => pointAtPicture(address, null))
                self.add_controller(motion)
            }}>
            <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
            {/* the outline goes round the picture, not its title */}
            <box class="app-preview-frame">
            <overlay>
                {/* a Picture's natural width is the full screenshot size, so
                    it must sit in a scroll-less viewport with the tile size
                    requested */}
                <Gtk.ScrolledWindow
                    class="window-preview-container"
                    $={(self: Gtk.Widget) => {
                        picture = self
                        live.tiles.set(address, self)
                        // thumbnails of same-app windows look alike: the app's
                        // icon in the picture's corner says which app at a
                        // glance. The compositor draws the picture, so it
                        // draws the badge too (services/previews.ts)
                        const badge = iconFileForEntry(entryForClient(client))
                        if (badge) live.badges.set(address, badge)
                        onCleanup(() => {
                            if (live.tiles.get(address) === self) {
                                live.tiles.delete(address)
                                live.badges.delete(address)
                            }
                        })
                    }}
                    overflow={Gtk.Overflow.HIDDEN}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.NEVER}
                    heightRequest={height}
                    // texture() is only the re-evaluation trigger (captures
                    // land alongside size changes); the size itself always
                    // comes from compositor geometry
                    widthRequest={texture(() => previewWidth(client, height))}
                >
                    <Gtk.Picture
                        canShrink={true}
                        // the container width is derived from the same
                        // aspect, so CONTAIN fills it edge to edge; when a
                        // clamp kicked in the tile can't match the aspect —
                        // zoom-crop to fill instead of letterboxing
                        contentFit={texture(t => {
                            const raw = rawPreviewWidth(client, height)
                            if (raw !== clampTile(raw, height)) return Gtk.ContentFit.COVER
                            // a frame captured before a retile no longer
                            // matches the window's aspect — fill and crop
                            // until the settle-recapture replaces it,
                            // instead of flashing a letterbox
                            if (t && Math.abs(rawAspectWidth(t.get_width(), t.get_height(), height) - raw) > 8)
                                return Gtk.ContentFit.COVER
                            return Gtk.ContentFit.CONTAIN
                        })}
                        widthRequest={-1}
                        paintable={texture}
                    />
                </Gtk.ScrolledWindow>
                {/* until the window has a capture; with live previews the
                    compositor has drawn it before this is ever seen */}
                <box
                    $type="overlay"
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.CENTER}
                    visible={texture(t => !t && !livePreviews())}
                >
                    <AppIconImage entry={entryForClient(client)} pixelSize={64} cssClass="switcher-badge-icon" />
                </box>
            </overlay>
            </box>
            <box class="preview-title-below">{title}</box>
            </box>
        </button>
    ) as Gtk.Button

    createEffect(() => {
        if (selectedAddress() === address) {
            tile.add_css_class("chosen")
        } else {
            tile.remove_css_class("chosen")
        }
    })

    return <box class="preview-tile">{tile}</box>
}
