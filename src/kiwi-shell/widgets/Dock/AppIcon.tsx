import { Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, createEffect, For } from "ags"
import Pango from "gi://Pango"
import { hyprland, list, setList, saveList, isNixManaged, isValidClient, JUMP_ANIMATION_CLASS_TIMEOUT, MINIMIZED_WS, isMinimized, isClientVisible, minimizeClient, restoreClient, focusClient } from "./dock-state"
import Hyprland from "gi://AstalHyprland"
import { DockContextIcon } from "./dock-utils"
import { mapVersion } from "../desktopEntries"
import { entryForClient, AppIconImage } from "../appIcon"
import { captureWindowToTexture, freshClientSize, getCachedTexture } from "../AppSwitcher/clientCachingService"
import { closeWindow, clientSelector } from "../../hypr"
import { conf } from "../config"
import { logger } from "../../log"
const log = logger("dock")

export function AppIcon({ entry, setMenuOpen }: { entry: string, setMenuOpen: (v: boolean) => void }) {
    const application = (() => {
        const GioUnix = imports.gi.GioUnix
        return GioUnix.DesktopAppInfo.new(entry)
    })()
    const name = application?.get_name() ?? entry.replace(/\.desktop$/, "")

    const [pinned, setPinned] = createState(list().includes(entry))
    const [jumping, setJumping] = createState(false)

    // same resolution the switcher and workspace overview use — one source
    // of truth for "which app does this window belong to"
    const clientsBinding = createComputed(get => {
        get(mapVersion) // reactive dependency — re-runs when maps rebuild
        const allClients = get(createBinding(hyprland, "clients"))
        return allClients.filter(client =>
            isValidClient(client) && entryForClient(client) === entry)
    })

    const onPinChange = (newPinned: boolean) => {
        setPinned(newPinned)
        if (newPinned) {
            setList([...list(), entry])
        } else {
            setList(list().filter(e => e !== entry))
        }
        saveList()
    }

    const menu = AppContextMenu(entry, clientsBinding, application, name, pinned, onPinChange, setMenuOpen)
    const previews = WindowPreviews(clientsBinding, setMenuOpen)

    // hover lifecycle, taskbar style: linger to open, stays while the
    // pointer is over the icon or flyout. Enter/leave only *trigger* the
    // close check — cursorpos decides it, since mapping the popup yanks
    // pointer focus off the dock layer (spurious leave, hyprland 0.56).
    let openTimer: ReturnType<typeof setTimeout> | null = null
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    let iconWidget: Gtk.Widget | null = null

    const KEEP_SLOP_PX = 16

    // pointer inside the icon's dock cell or the flyout above it? The dock
    // is a bottom-anchored monitor-wide layer, so widget bounds translate by
    // monitor geometry; the flyout rect is reconstructed from its content
    // size (slop absorbs GTK's edge clamping).
    const pointerInKeepRegion = (): boolean => {
        if (!iconWidget) { log.debug(`[keep:${entry}] no iconWidget`); return false }
        const root = iconWidget.get_root() as any
        const monitor: Gdk.Monitor | null = root?.gdkmonitor ?? null
        if (!root || !monitor) { log.debug(`[keep:${entry}] root=${!!root} monitor=${!!monitor}`); return false }

        let reply: string
        try {
            reply = hyprland.message("cursorpos")
        } catch {
            log.debug(`[keep:${entry}] cursorpos IPC failed`)
            return false // IPC down → evidence lapses → flyout closes
        }
        const m = reply.match(/(-?\d+),\s*(-?\d+)/)
        if (!m) { log.debug(`[keep:${entry}] unparseable cursorpos: ${reply}`); return false }
        const px = Number(m[1])
        const py = Number(m[2])

        const geo = monitor.get_geometry()
        const dockTop = geo.y + geo.height - root.get_height()
        const [ok, bounds] = iconWidget.compute_bounds(root)
        if (!ok) { log.debug(`[keep:${entry}] compute_bounds failed`); return false }
        const iconL = geo.x + bounds.get_x() - KEEP_SLOP_PX
        const iconR = geo.x + bounds.get_x() + bounds.get_width() + KEEP_SLOP_PX
        if (py >= dockTop && px >= iconL && px <= iconR) return true

        if (!previews.visible) { log.debug(`[keep:${entry}] outside icon (${px},${py} vs x ${iconL}-${iconR}, dockTop ${dockTop}), no flyout`); return false }
        const flyout = previews.get_child()?.get_allocation()
        const w = (flyout?.width ?? 0) + 2 * KEEP_SLOP_PX
        const h = (flyout?.height ?? 0) + 2 * KEEP_SLOP_PX
        const cx = geo.x + bounds.get_x() + bounds.get_width() / 2
        const inFlyout = px >= cx - w / 2 && px <= cx + w / 2 &&
            py >= dockTop - h && py <= dockTop + KEEP_SLOP_PX
        if (!inFlyout) log.debug(`[keep:${entry}] outside both: ptr (${px},${py}) icon x ${iconL}-${iconR} dockTop ${dockTop} flyout ${w}x${h} cx ${cx}`)
        return inFlyout
    }

    const cancelOpen = () => { if (openTimer) { clearTimeout(openTimer); openTimer = null } }
    const cancelClose = () => {
        log.debug(`[preview:${entry}] cancelClose (had timer: ${closeTimer !== null})`)
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    }
    const scheduleClose = () => {
        cancelClose()
        closeTimer = setTimeout(() => {
            closeTimer = null
            if (!previews.visible) return
            if (pointerInKeepRegion()) {
                log.debug(`[preview:${entry}] close timer: pointer still here → re-arm`)
                scheduleClose()
                return
            }
            log.debug(`[preview:${entry}] close timer FIRED → popdown`)
            previews.popdown()
        }, PREVIEW_HOVER_CLOSE_MS)
    }
    const previewsMotion = new Gtk.EventControllerMotion()
    previewsMotion.connect("enter", () => {
        log.debug(`[preview:${entry}] popover ENTER`)
        cancelClose()
    })
    previewsMotion.connect("leave", () => {
        log.debug(`[preview:${entry}] popover LEAVE`)
        scheduleClose()
    })
    previews.add_controller(previewsMotion)

    return (
        <box class="app-icon-container">
            <button
                onclicked={() => {
                    cancelOpen()
                    cancelClose()
                    const clients = clientsBinding()
                    if (clients.length === 0) {
                        setJumping(true)
                        setTimeout(() => setJumping(false), JUMP_ANIMATION_CLASS_TIMEOUT + 100)
                        application.launch([], null)
                        return
                    }
                    // several windows → window picker with previews,
                    // taskbar style
                    if (clients.length > 1) {
                        previews.popup()
                        return
                    }
                    previews.popdown()
                    const client = clients[0]
                    if (isClientVisible(client)) {
                        // visible → stash in the minimized scratchpad
                        minimizeClient(client)
                    } else if (isMinimized(client)) {
                        // bring it back to the current workspace
                        restoreClient(client)
                    } else {
                        // running on another (non-visible) workspace → jump to it
                        focusClient(client)
                    }
                }}
                $={(self) => {
                    iconWidget = self
                    const gesture = new Gtk.GestureClick()
                    gesture.set_button(3)
                    gesture.connect("released", () => {
                        previews.popdown()
                        menu.popup()
                    })
                    self.add_controller(gesture)

                    const hover = new Gtk.EventControllerMotion()
                    hover.connect("enter", () => {
                        log.debug(`[preview:${entry}] icon ENTER`)
                        cancelClose()
                        cancelOpen()
                        openTimer = setTimeout(() => {
                            if (clientsBinding().length > 0 && !menu.visible)
                                previews.popup()
                        }, PREVIEW_HOVER_OPEN_MS)
                    })
                    hover.connect("leave", () => {
                        log.debug(`[preview:${entry}] icon LEAVE`)
                        cancelOpen()
                        scheduleClose()
                    })
                    self.add_controller(hover)
                }}
                class={jumping.as(isJumping => isJumping ? "app-launch-button jumping" : "app-launch-button")}
            >
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {menu}
                    {previews}
                    <overlay>
                        <AppIconImage entry={entry} pixelSize={
                            conf.as(conf => conf.dock_icon_size)
                        } />
                        <box $type="overlay" class="dots-container" orientation={Gtk.Orientation.VERTICAL}>
                            <box vexpand={true}></box>
                            <box class="client-dots" halign={Gtk.Align.CENTER} spacing={3}>
                                <For each={clientsBinding}>
                                    {(client) => <ActiveClientDot client={client} />}
                                </For>
                            </box>
                        </box>
                    </overlay>
                </box>
            </button>
        </box>
    )
}

const PREVIEW_HOVER_OPEN_MS = 400
const PREVIEW_HOVER_CLOSE_MS = 300

// Windows-taskbar-style window picker: one live thumbnail per window of the
// app, click to focus (or restore, if minimized), ✕ to close.
function WindowPreviews(
    clientsBinding: ReturnType<typeof createComputed<Hyprland.Client[]>>,
    setMenuOpen: (v: boolean) => void,
) {
    let popover: Gtk.Popover
    const [open, setOpen] = createState(false)

    return (
        <popover
            // no grab: it opens on hover and closes on pointer leave, so it
            // must not swallow clicks meant for the dock or the icon
            autohide={false}
            hasArrow={false}
            // expand flags propagate up from *visible* children — including
            // popovers, which box layout otherwise ignores. Without this,
            // the hexpand title labels inside make the icon's dock cell grow
            // while the flyout is open, shifting the whole dock sideways.
            hexpand={false}
            vexpand={false}
            class="dock-previews"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    log.debug(`[preview] popover notify::visible → ${self.visible}`)
                    setOpen(self.visible)
                    setMenuOpen(self.visible)
                })
                // closing the last window from the picker leaves nothing
                // to show — dismiss instead of floating an empty pill
                createEffect(() => {
                    if (clientsBinding().length === 0 && popover.visible) {
                        log.debug(`[preview] popdown via empty clientsBinding effect`)
                        popover.popdown()
                    }
                })
            }}
        >
            <box spacing={4}>
                <For each={clientsBinding}>
                    {(client) => (
                        <WindowPreviewItem
                            client={client}
                            pickerOpen={open}
                            popdown={() => popover.popdown()}
                        />
                    )}
                </For>
            </box>
        </popover>
    ) as Gtk.Popover
}

// same geometry rules as the app switcher: the tile hugs the window's
// aspect ratio; outside the clamps it can't hug, so the shot is
// cover-zoomed to fill instead of floating in letterbox space
const DOCK_SHOT_HEIGHT = 112
const dockRawWidth = (w: number, h: number) =>
    h > 0 ? Math.round(DOCK_SHOT_HEIGHT * w / h) : 192
const dockClampWidth = (w: number) => Math.min(300, Math.max(120, w))

// compositor geometry, never capture pixel sizes — a window hanging off a
// workspace edge yields a clipped capture that would warp the tile
const dockRawClientWidth = (client: Hyprland.Client) => {
    // minimized → size from the snapshot: the compositor geometry reflects
    // the hidden scratchpad layout, not the frame being shown
    if (isMinimized(client)) {
        const cached = getCachedTexture(client.get_address())
        if (cached) return dockRawWidth(cached.get_width(), cached.get_height())
    }
    const fresh = freshClientSize(client.get_address())
    return fresh
        ? dockRawWidth(fresh[0], fresh[1])
        : dockRawWidth(client.get_width(), client.get_height())
}

function WindowPreviewItem({ client, pickerOpen, popdown }: {
    client: Hyprland.Client,
    pickerOpen: ReturnType<typeof createState<boolean>>[0],
    popdown: () => void,
}) {
    const address = client.get_address()
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)
    const title = createBinding(client, "title")

    createEffect(() => {
        if (!pickerOpen()) return
        captureWindowToTexture(address).then(t => {
            if (t) setTexture(t)
        })
    })

    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            class="dock-preview-item"
            $={(self) => {
                // a plain gesture instead of a button: the close button is
                // nested inside, and its clicks must not activate the window
                const click = new Gtk.GestureClick()
                click.set_button(1)
                click.connect("released", (_gesture, _nPress, x, y) => {
                    const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                    for (let w: Gtk.Widget | null = target; w && w !== self; w = w.get_parent()) {
                        if (w instanceof Gtk.Button) return
                    }
                    popdown()
                    if (isMinimized(client)) restoreClient(client)
                    else focusClient(client)
                })
                self.add_controller(click)
            }}
        >
            <box class="dock-preview-header" spacing={6}>
                <AppIconImage
                    entry={entryForClient(client)}
                    pixelSize={14}
                    cssClass="dock-preview-icon"
                />
                <label
                    class="dock-preview-title"
                    label={title}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                    xalign={0}
                />
                <button
                    class="dock-preview-close"
                    onclicked={() => closeWindow(clientSelector(client))}
                >
                    <Gtk.Image iconName="window-close-symbolic" pixelSize={10} />
                </button>
            </box>
            {/* scroll-less viewport sized to the window's aspect ratio:
                a Picture's natural size is the full screenshot, so it must
                sit in a scrollable with the thumbnail size requested — the
                tile then hugs the image with no letterbox bars */}
            <Gtk.ScrolledWindow
                class="dock-preview-shot"
                overflow={Gtk.Overflow.HIDDEN}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                vscrollbarPolicy={Gtk.PolicyType.NEVER}
                heightRequest={DOCK_SHOT_HEIGHT}
                // texture() is only the re-evaluation trigger (captures
                // land alongside size changes)
                widthRequest={texture(() =>
                    dockClampWidth(dockRawClientWidth(client)))}
            >
                <Gtk.Picture
                    canShrink={true}
                    contentFit={texture(t => {
                        const raw = dockRawClientWidth(client)
                        if (raw !== dockClampWidth(raw)) return Gtk.ContentFit.COVER
                        // stale pre-retile frame → fill and crop until the
                        // settle-recapture replaces it
                        if (t && Math.abs(dockRawWidth(t.get_width(), t.get_height()) - raw) > 6)
                            return Gtk.ContentFit.COVER
                        return Gtk.ContentFit.CONTAIN
                    })}
                    widthRequest={-1}
                    paintable={texture}
                />
            </Gtk.ScrolledWindow>
        </box>
    )
}

function ActiveClientDot({ client }: { client: Hyprland.Client }) {
    const workspace = createBinding(client, "workspace")
    return (
        <box class={workspace.as(ws =>
            ws?.name === MINIMIZED_WS ? "active-client-dot minimized" : "active-client-dot"
        )} />
    )
}

function AppContextMenu(entry, clientsBinding, application, name, pinned, onPinChange, setMenuOpen) {
    let popover: Gtk.Popover

    return (
        <popover
            autohide={true}
            hasArrow={false}
            hexpand={false}
            vexpand={false}
            class="app-context-menu"
            $={(self) => {
                popover = self
                self.connect("notify::visible", () => {
                    setMenuOpen(self.visible)
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                <button
                    onclicked={() => {
                        popover.popdown()
                        application.launch([], null)
                    }}
                >
                    <box>
                        <AppIconImage entry={entry} pixelSize={20} cssClass="dock-context-icon" />
                        <label halign={Gtk.Align.START} label={name} />
                    </box>
                </button>

                <button
                    visible={pinned.as(p => p === true && !isNixManaged)}
                    onclicked={() => {
                        popover.popdown()
                        onPinChange(false)
                    }}
                >
                    <box>
                        <DockContextIcon icon="unpin-symbolic" />
                        <label halign={Gtk.Align.START} label="Unpin from Dock" />
                    </box>
                </button>

                <button
                    visible={pinned.as(p => p === false && !isNixManaged)}
                    onclicked={() => {
                        popover.popdown()
                        onPinChange(true)
                    }}
                >
                    <box>
                        <DockContextIcon icon="pin-symbolic" />
                        <label halign={Gtk.Align.START} label="Pin to Dock" />
                    </box>
                </button>

                <button
                    onclicked={() => {
                        popover.popdown()
                        for (const client of clientsBinding()) {
                            closeWindow(clientSelector(client))
                        }
                    }}
                    visible={clientsBinding.as(clients => clients.length > 0)}
                >
                    <box>
                        <DockContextIcon icon="window-close-symbolic" />
                        <label halign={Gtk.Align.START} label="Close Window" />
                    </box>
                </button>
            </box>
        </popover>
    )
}