import { logger } from "../../log"
const log = logger("appswitcher")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, createBinding } from "ags"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"
import { conf } from "../config"
import { playSound } from "../sound"
import { captureWindowToTexture, freshClientSize, getCachedTexture } from "./clientCachingService"
import { isValidClient, isMinimized, restoreClient, focusClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { popupGdkMonitor } from "../monitors"
import { evalLua, luaBind, luaUnbind, isKiwiBind, describeBind, closeWindow, clientSelector } from "../../hypr"

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

// ─── Alt+Tab keybinds ─────────────────────────────────────────────────────────
// Registered on startup and after every config reload (reloads wipe dynamic
// binds). A foreign ALT+TAB / ALT+ALT_L root bind means the user has their
// own alt-tab — leave the keyboard alone. The ALT_L release binds must live
// in the root submap: a bind matches the submap active at key PRESS, and Alt
// goes down before the submap is entered (isVisible no-ops the stray fires).

const ALT_MODMASK = 8

async function registerAltTabBinds() {
    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"]))
        const foreign = binds.find((b: any) =>
            (b.key === "TAB" || b.key === "ALT_L") &&
            b.modmask === ALT_MODMASK && b.submap === "" && !isKiwiBind(b))
        if (foreign) {
            log.warn("foreign alt-tab bind found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
    } catch (e) {
        log.error("failed to query binds, skipping alt-tab setup:", e)
        return
    }

    // one eval chunk = atomic and ordered. define_submap appends on
    // redefinition, hence the unbinds inside it first.
    const ok = await evalLua([
        // clear any previous incarnation of the scheme first
        luaUnbind("ALT + TAB"),
        luaUnbind("ALT + ALT_L"),
        `hl.define_submap("app_switcher", function()`,
        `  ${luaUnbind("ALT + TAB")}`,
        `  ${luaUnbind("ALT + ALT_L")}`,
        `  ${luaUnbind("escape")}`,
        `  ${luaUnbind("ALT + escape")}`,
        `end)`,
        // root: entry, and the Alt-release confirm (see comment above)
        luaBind("ALT + TAB", `hl.dsp.exec_cmd("kiwictl apps open-next")`, "kiwi: apps open"),
        luaBind("ALT + TAB", `hl.dsp.submap("app_switcher")`, "kiwi: apps submap enter"),
        luaBind("ALT + ALT_L", `hl.dsp.exec_cmd("kiwictl apps confirm")`, "kiwi: apps confirm",
            { release: true, transparent: true }),
        luaBind("ALT + ALT_L", `hl.dsp.submap("reset")`, "kiwi: apps submap reset",
            { release: true, transparent: true }),
        // submap: cycling while held, escape failsafes
        `hl.define_submap("app_switcher", function()`,
        `  ${luaBind("ALT + TAB", `hl.dsp.exec_cmd("kiwictl apps open-next")`, "kiwi: apps cycle", { repeating: true })}`,
        `  ${luaBind("escape", `hl.dsp.exec_cmd("kiwictl apps close")`, "kiwi: apps close", { release: true })}`,
        `  ${luaBind("escape", `hl.dsp.submap("reset")`, "kiwi: apps submap reset", { release: true })}`,
        `  ${luaBind("ALT + escape", `hl.dsp.exec_cmd("kiwictl apps close")`, "kiwi: apps close", { release: true })}`,
        `  ${luaBind("ALT + escape", `hl.dsp.submap("reset")`, "kiwi: apps submap reset", { release: true })}`,
        `end)`,
    ].join("\n"), "alt-tab binds")
    if (ok) log.info("registered alt-tab binds (root + app_switcher submap)")
}

registerAltTabBinds()
hyprland.connect("config-reloaded", registerAltTabBinds)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleAppSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showAppSwitcher()
            break
        case "open-next":
            if (!isVisible()) showAppSwitcher()
            selectNextClient()
            break
        case "close":
            hideAppSwitcher()
            break
        case "toggle":
            if (isVisible()) hideAppSwitcher()
            else showAppSwitcher()
            break
        case "next":
            selectNextClient()
            break
        case "previous":
            selectPreviousClient()
            break
        case "confirm":
            executeSelectedAndClose()
            break
    }
}

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

function selectNextClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx + 1) % clients.length].get_address())
}

function selectPreviousClient() {
    if (!isVisible()) return
    const clients = displayedClients()
    if (clients.length === 0) return
    const idx = clients.findIndex(c => c.get_address() === selectedAddress())
    setSelectedAddress(clients[(idx - 1 + clients.length) % clients.length].get_address())
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
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-app-switcher"
            class={conf.as((conf: any) => `AppSwitcher theme-${conf.theme}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
        >
            <Windows gdkmonitor={gdkmonitor} />
        </window>
    )
}

// Uniform height, width hugs the window's aspect ratio — the tile IS the
// preview (narrow windows get narrow tiles, same as Windows Alt-Tab).
// Outside the clamps the tile can't hug: those windows are cover-zoomed to
// fill it instead of floating in letterbox space.
const PREVIEW_HEIGHT = 170
const MIN_TILE_WIDTH = 140
const MAX_TILE_WIDTH = 720

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
    // a minimized window is unmapped: its compositor geometry reflects the
    // hidden scratchpad layout, while the frame on display is the cached
    // pre-minimize snapshot — size from the snapshot instead
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

    return (
        <centerbox class="app-switch-menu">
            <box
                $type="center"
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
        </centerbox>
    )
}

export function WindowPreview({ client }: { client: any }) {
    if (!client) return null

    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)

    createEffect(() => {
        if (!isVisible()) return
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
                {/* no app icon here — the badge on the thumbnail carries
                    it; maxWidthChars=1 lets the ellipsized label shrink
                    below its natural width instead of clipping early */}
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
                {/* the recognition anchor — thumbnails of same-app windows
                    look alike, the badge says which app at a glance */}
                <box
                    $type="overlay"
                    class="switcher-badge"
                    halign={Gtk.Align.END}
                    valign={Gtk.Align.END}
                >
                    <AppIconImage entry={entryForClient(client)} pixelSize={40} cssClass="switcher-badge-icon" />
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
