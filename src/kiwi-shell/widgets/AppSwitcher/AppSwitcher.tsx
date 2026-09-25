import { logger } from "../../log"
const log = logger("appswitcher")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, createBinding, onCleanup } from "ags"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { playSound } from "../sound"
import { captureWindowToTexture, freshClientSize, getCachedTexture, reservePreviewSize } from "./clientCachingService"
import { isValidClient, isMinimized, restoreClient, focusClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { livePreviews, clearPreviews, LiveTiles, PreviewPane } from "../services/previews"
import { applyBinds, currentBinds, registerBindSetup, isKiwiBind, describeBind, closeWindow, clientSelector, type BindOp } from "../../hypr"
import { shortcut, combo, heldModifierKey, type Shortcut } from "../../shortcuts"
import { globalShortcut } from "../services/globalShortcuts"

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
// binds). A foreign root bind on the shortcut or on its modifier's release
// means the user has their own alt-tab — leave the keyboard alone. The
// modifier release binds must live in the root submap: a bind matches the
// submap active at key PRESS, and the modifier goes down before the submap
// is entered (isVisible no-ops the stray fires).

let registered: Shortcut | null = null

const NEXT = globalShortcut("apps-next", "App switcher: open, or the next window", "press", () => {
    if (!isVisible()) showAppSwitcher()
    selectNextClient()
})
const CONFIRM = globalShortcut("apps-confirm", "App switcher: switch to the selected window",
    "release", executeSelectedAndClose)
const CLOSE = globalShortcut("apps-close", "App switcher: close", "release", hideAppSwitcher)

// what a registration on `s` binds, root and submap, for unbinding
function appSwitcherUnbinds(s: Shortcut): BindOp[] {
    const release = `${s.mods[0]} + ${heldModifierKey(s)}`
    return [
        { unbind: combo(s) },
        { unbind: release },
        { submap: "app_switcher", ops: [
            { unbind: combo(s) },
            { unbind: release },
            { unbind: "escape" },
            { unbind: `${s.mods[0]} + escape` },
        ] },
    ]
}

async function registerAltTabBinds() {
    const s = shortcut("app_switcher")
    const entry = combo(s)
    const release = `${s.mods[0]} + ${heldModifierKey(s)}`
    try {
        const binds = await currentBinds()
        const foreign = binds.find((b: any) =>
            (b.key === s.key || b.key === heldModifierKey(s)) &&
            b.modmask === s.modmask && b.submap === "" && !isKiwiBind(b))
        if (foreign) {
            log.warn("foreign app switcher bind found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
    } catch (e) {
        log.error("failed to query binds, skipping app switcher setup:", e)
        return
    }

    // applied atomically and in order. Submap definitions append on
    // redefinition, hence the unbinds inside it first.
    const ok = await applyBinds([
        // clear any previous incarnation of the scheme first
        ...appSwitcherUnbinds(s),
        // root: entry, and the modifier-release confirm (see comment above)
        { bind: entry, action: NEXT, description: "kiwi: apps open" },
        { bind: entry, action: { submap: "app_switcher" }, description: "kiwi: apps submap enter" },
        { bind: release, action: CONFIRM, description: "kiwi: apps confirm",
            flags: { release: true, transparent: true } },
        { bind: release, action: { submap: "reset" }, description: "kiwi: apps submap reset",
            flags: { release: true, transparent: true } },
        // submap: cycling while held, escape failsafes
        { submap: "app_switcher", ops: [
            { bind: entry, action: NEXT, description: "kiwi: apps cycle",
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

function selectNextClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx + 1) % clients.length].get_address())
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
    return (
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
                    clearPreviews()
                    if (live.window === self) live.window = null
                    destroyWindow(self)
                })
            }}
        >
            <Windows gdkmonitor={gdkmonitor} />
        </window>
    )
}

// ─── Where the tiles are ──────────────────────────────────────────────────────
// With kiwi-previews in the compositor the windows are drawn over the tiles
// (services/previews.ts), measured after every layout from the widget that
// holds the picture. Its top corners meet the title bar, so only the bottom
// ones are rounded.

const live = new LiveTiles({ namespace: LAYER.switcher, motion: "live", radius: 6, squareTop: true })

// Uniform height, width hugs the window's aspect ratio — the tile IS the
// preview (narrow windows get narrow tiles, same as Windows Alt-Tab).
// Outside the clamps the tile can't hug: those windows are cover-zoomed to
// fill it instead of floating in letterbox space.
const PREVIEW_HEIGHT = 170
const MIN_TILE_WIDTH = 140
const MAX_TILE_WIDTH = 720

// a clamped tile zooms its frame to cover both the minimum width and the height
reservePreviewSize(MIN_TILE_WIDTH, PREVIEW_HEIGHT)

function rawAspectWidth(w: number, h: number): number {
    return h > 0 ? Math.round(PREVIEW_HEIGHT * w / h) : 280
}

const clampTile = (w: number) =>
    Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, w))

function aspectWidth(w: number, h: number): number {
    return clampTile(rawAspectWidth(w, h))
}

// tile width from the compositor's freshest size poll — capture pixel
// sizes are NOT used: a window hanging off a workspace edge yields a
// clipped capture, and sizing from it would warp the tile. Astal client
// geometry (stale after resizes) is only the fallback.
function rawPreviewWidth(client: any): number {
    // a minimized window's frame can predate its move to the scratchpad
    // workspace, whose layout may have resized it — size from the frame
    // on display instead
    if (isMinimized(client)) {
        const cached = getCachedTexture(client.get_address())
        if (cached) return rawAspectWidth(cached.get_width(), cached.get_height())
    }
    const fresh = freshClientSize(client.get_address())
    return fresh
        ? rawAspectWidth(fresh[0], fresh[1])
        : rawAspectWidth(client.get_width(), client.get_height())
}

function previewWidth(client: any): number {
    return clampTile(rawPreviewWidth(client))
}

function Windows({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // previews wrap into centered rows instead of shrinking. Chunked by
    // hand: card widths are known upfront, and GtkFlowBox is a grid in
    // disguise — it stretches cards to uniform column widths.
    const rows = createComputed(get => {
        const monitor = get(popupGdkMonitor) ?? gdkmonitor
        // rows wrap well before the screen edge so the panel never reads
        // as a full-width band
        const budget = monitor.get_geometry().width * 0.85
        const chunks: any[][] = []
        let row: any[] = []
        let width = 0
        for (const client of get(displayedClients)) {
            const w = previewWidth(client)
            if (row.length > 0 && width + w > budget) {
                chunks.push(row)
                row = []
                width = 0
            }
            row.push(client)
            width += w
        }
        if (row.length > 0) chunks.push(row)
        return chunks
    })

    const pane = (
        <box
            class="app-switch-container"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            // hug the rows — FILL (the default) would stretch the
            // panel to the full window width, erasing the edge gap
            halign={Gtk.Align.CENTER}
        >
            <For each={rows}>
                {(row) => (
                    <box spacing={4} halign={Gtk.Align.CENTER}>
                        {row.map(client => <WindowPreview client={client} />)}
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

export function WindowPreview({ client }: { client: any }) {
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
    const tile = (
        <button class="window-preview" onclicked={activate}>
            <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
            <box class="preview-title-bar">
                {/* thumbnails of same-app windows look alike, so the icon
                    says which app at a glance; it sits here rather than on
                    the picture, which the compositor may be drawing.
                    maxWidthChars=1 lets the ellipsized label shrink below
                    its natural width instead of clipping early */}
                <AppIconImage entry={entryForClient(client)} pixelSize={16} cssClass="preview-title-icon" />
                <label
                    class="preview-title"
                    label={titleBinding}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                    xalign={0}
                />
            </box>

            <overlay>
                {/* a Picture's natural width is the full screenshot size, so
                    it must sit in a scroll-less viewport with the tile size
                    requested */}
                <Gtk.ScrolledWindow
                    class="window-preview-container"
                    $={(self: Gtk.Widget) => {
                        live.tiles.set(address, self)
                        onCleanup(() => { if (live.tiles.get(address) === self) live.tiles.delete(address) })
                    }}
                    overflow={Gtk.Overflow.HIDDEN}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.NEVER}
                    heightRequest={PREVIEW_HEIGHT}
                    // texture() is only the re-evaluation trigger (captures
                    // land alongside size changes); the size itself always
                    // comes from compositor geometry
                    widthRequest={texture(() => previewWidth(client))}
                >
                    <Gtk.Picture
                        canShrink={true}
                        // the container width is derived from the same
                        // aspect, so CONTAIN fills it edge to edge; when a
                        // clamp kicked in the tile can't match the aspect —
                        // zoom-crop to fill instead of letterboxing
                        contentFit={texture(t => {
                            const raw = rawPreviewWidth(client)
                            if (raw !== clampTile(raw)) return Gtk.ContentFit.COVER
                            // a frame captured before a retile no longer
                            // matches the window's aspect — fill and crop
                            // until the settle-recapture replaces it,
                            // instead of flashing a letterbox
                            if (t && Math.abs(rawAspectWidth(t.get_width(), t.get_height()) - raw) > 8)
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
        </button>
    ) as Gtk.Button

    createEffect(() => {
        if (selectedAddress() === address) {
            tile.add_css_class("selected")
        } else {
            tile.remove_css_class("selected")
        }
    })

    return (
        <overlay class="preview-tile">
            {tile}
            {/* hover-revealed, floating over the end of the title bar so it
                reserves no layout space there */}
            <button
                $type="overlay"
                class="switcher-preview-close"
                halign={Gtk.Align.END}
                valign={Gtk.Align.START}
                marginTop={10}
                marginEnd={6}
                onclicked={() => closeClientFromSwitcher(client)}
            >
                <Gtk.Image iconName="window-close-symbolic" pixelSize={12} />
            </button>
        </overlay>
    )
}
