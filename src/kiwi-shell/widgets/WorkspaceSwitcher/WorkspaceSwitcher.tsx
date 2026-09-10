import { logger } from "../../log"
const log = logger("workspaces")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, onCleanup } from "ags"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { isValidClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { conf } from "../config"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { evalLua, luaBind, luaUnbind, isKiwiBind, describeBind, focusWorkspace } from "../../hypr"

const hyprland = Hyprland.get_default()

const CARD_HEIGHT = 140

export const [isVisible, setVisibility] = createState(false)
const [selectedId, setSelectedId] = createState(1)
const [displayedIds, setDisplayedIds] = createState<number[]>([])
// per-workspace client snapshot, taken when the switcher opens
const [wsClients, setWsClients] = createState<Map<number, Hyprland.Client[]>>(new Map())

// ─── Super+Tab keybinds ───────────────────────────────────────────────────────
// Same architecture as alt-tab, all in the root submap: binde for cycling,
// a release bind on SUPER_L to confirm (fires on every plain Super release —
// the shell no-ops it while the switcher is closed), and SUPER+escape to
// abort. A press bind on SUPER+SUPER_L (launcher-on-super-tap setups) is
// unrelated to our release bind and keeps working — we never unbind SUPER_L.

const SUPER_MODMASK = 64

async function registerSuperTabBinds() {
    let haveConfirm = false
    let haveEscape = false
    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"]))
        // any kiwi-described bind counts as ours: the launcher registers its
        // own SUPER_L release bind (tap-to-open) which must not read as
        // foreign
        const foreign = binds.find((b: any) =>
            b.submap === "" && !isKiwiBind(b) && (
                (b.key === "TAB" && (b.modmask === SUPER_MODMASK || b.modmask === (SUPER_MODMASK | 1))) ||
                // a foreign *release* bind on super itself (a press bind,
                // like tap-to-launch, is fine)
                (b.key === "SUPER_L" && b.modmask === SUPER_MODMASK && b.release)
            ))
        if (foreign) {
            log.warn("foreign super-tab bind found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
        haveConfirm = binds.some((b: any) => b.description === "kiwi: workspaces confirm")
        haveEscape = binds.some((b: any) => b.description === "kiwi: workspaces escape")
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }

    const ok = await evalLua([
        luaUnbind("SUPER + TAB"),
        luaUnbind("SUPER + SHIFT + TAB"),
        luaBind("SUPER + TAB", `hl.dsp.exec_cmd("kiwictl workspaces open-next")`,
            "kiwi: workspaces next", { repeating: true }),
        luaBind("SUPER + SHIFT + TAB", `hl.dsp.exec_cmd("kiwictl workspaces previous")`,
            "kiwi: workspaces prev", { repeating: true }),
        // never unbind SUPER_L (would take tap-to-launch binds with it), so
        // only add ours when it isn't registered yet
        ...(haveConfirm ? [] : [luaBind("SUPER + SUPER_L", `hl.dsp.exec_cmd("kiwictl workspaces confirm")`,
            "kiwi: workspaces confirm", { release: true, transparent: true })]),
        ...(haveEscape ? [] : [luaBind("SUPER + escape", `hl.dsp.exec_cmd("kiwictl workspaces close")`,
            "kiwi: workspaces escape", { release: true })]),
    ].join("\n"), "super-tab binds")
    if (ok) log.info("registered super-tab binds")
}

registerSuperTabBinds()
hyprland.connect("config-reloaded", registerSuperTabBinds)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleWorkspaceSwitcher(cmd: string) {
    switch (cmd) {
        case "open":
            showSwitcher()
            break
        case "open-next":
            if (!isVisible()) showSwitcher()
            cycle(1)
            break
        case "close":
            setVisibility(false)
            break
        case "toggle":
            if (isVisible()) setVisibility(false)
            else showSwitcher()
            break
        case "next":
            cycle(1)
            break
        case "previous":
            if (!isVisible()) showSwitcher()
            cycle(-1)
            break
        case "confirm":
            confirmAndClose()
            break
    }
}

function showSwitcher() {
    const byWs = new Map<number, Hyprland.Client[]>()
    for (const client of hyprland.get_clients()) {
        if (!isValidClient(client)) continue
        const id = client.get_workspace()?.get_id() ?? 0
        if (id <= 0) continue
        byWs.set(id, [...(byWs.get(id) ?? []), client])
    }
    const last = Math.max(0, ...byWs.keys())
    const current = hyprland.focusedWorkspace?.id ?? 1
    // the first workspace through the empty one just after the last
    // occupied one, so there is always a fresh workspace to jump to
    const count = Math.max(last + 1, current)
    setWsClients(byWs)
    setDisplayedIds(Array.from({ length: count }, (_, i) => i + 1))
    setSelectedId(current)
    setVisibility(true)
}

function cycle(dir: 1 | -1) {
    if (!isVisible()) return
    const ids = displayedIds()
    if (ids.length === 0) return
    const idx = ids.indexOf(selectedId())
    setSelectedId(ids[(idx + dir + ids.length) % ids.length])
}

function confirmAndClose() {
    if (!isVisible()) return
    focusWorkspace(selectedId())
    setVisibility(false)
}

// ─── UI ───────────────────────────────────────────────────────────────────────
export default function WorkspaceSwitcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            css={conf(conf => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-workspace-switcher"
            class={conf.as((conf: any) => `WorkspaceSwitcher theme-${conf.theme}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.NORMAL}
            anchor={Astal.WindowAnchor.CENTER | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.TOP}
            $={(self) => onCleanup(() => destroyWindow(self))}
        >
            <centerbox class="ws-switch-menu">
                <box
                    $type="center"
                    class="app-switch-container"
                    spacing={8}
                    halign={Gtk.Align.CENTER}
                >
                    <For each={displayedIds}>
                        {(id) => <WorkspaceCard id={id} />}
                    </For>
                </box>
            </centerbox>
        </window>
    )
}

// A workspace's own monitor in Hyprland layout terms: logical size (physical
// divided by scale, dimensions swapped on rotated transforms) plus the layout
// offset. Client coordinates are global layout coordinates, so miniatures must
// subtract the offset and scale by the logical size — the popup's monitor is
// the wrong frame of reference for workspaces living on another screen.
// Workspaces that don't exist yet fall back to the focused monitor.
function workspaceGeometry(id: number) {
    const mon = hyprland.get_workspace(id)?.get_monitor()
        ?? hyprland.get_focused_monitor()
    const rotated = mon.get_transform() % 2 === 1
    const scale = mon.get_scale() || 1
    return {
        x: mon.get_x(),
        y: mon.get_y(),
        width: (rotated ? mon.get_height() : mon.get_width()) / scale,
        height: (rotated ? mon.get_width() : mon.get_height()) / scale,
    }
}

// A capture-free workspace preview: a miniature of the workspace's window
// layout, built from live client geometry, one rounded rect + app icon per
// window.
function WorkspaceCard({ id }: { id: number }) {
    // geometry is read per open inside the effect below — the popup can
    // land on a different monitor each time
    const [width, setWidth] = createState(Math.round(CARD_HEIGHT * 16 / 9))
    const [entries, setEntries] = createState<string[]>([])
    const [empty, setEmpty] = createState(true)

    const container = (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={0}
            class="window-preview"
        >
            <box class="preview-title-bar" spacing={5}>
                <label class="ws-number" label={`${id}`} xalign={0} />
                <For each={entries}>
                    {(entry) => <AppIconImage entry={entry} pixelSize={13} cssClass="ws-app-icon" />}
                </For>
            </box>
            <overlay>
                <Gtk.Fixed
                    class="ws-canvas"
                    widthRequest={width}
                    heightRequest={CARD_HEIGHT}
                    $={(self: Gtk.Fixed) => {
                        createEffect(() => {
                            if (!isVisible()) return
                            const geo = workspaceGeometry(id)
                            const cardWidth = Math.round(CARD_HEIGHT * geo.width / geo.height)
                            setWidth(cardWidth)
                            const clients = wsClients().get(id) ?? []
                            setEntries([...new Set(clients.map(entryForClient))])
                            setEmpty(clients.length === 0)

                            let child = self.get_first_child()
                            while (child) {
                                const next = child.get_next_sibling()
                                self.remove(child)
                                child = next
                            }
                            for (const c of clients) {
                                const w = Math.max(6, Math.round(c.get_width() * cardWidth / geo.width))
                                const h = Math.max(6, Math.round(c.get_height() * CARD_HEIGHT / geo.height))
                                const icon = Math.max(8, Math.min(20, Math.round(Math.min(w, h) * 0.55)))
                                self.put(
                                    (
                                        <overlay>
                                            <box class="ws-mini-window" widthRequest={w} heightRequest={h} />
                                            <box
                                                $type="overlay"
                                                halign={Gtk.Align.CENTER}
                                                valign={Gtk.Align.CENTER}
                                            >
                                                <AppIconImage
                                                    entry={entryForClient(c)}
                                                    pixelSize={icon}
                                                    cssClass="ws-mini-icon"
                                                />
                                            </box>
                                        </overlay>
                                    ) as Gtk.Widget,
                                    Math.round((c.get_x() - geo.x) * cardWidth / geo.width),
                                    Math.round((c.get_y() - geo.y) * CARD_HEIGHT / geo.height),
                                )
                            }
                        })
                    }}
                />
                {/* a theme icon, not a "＋" label: the fullwidth plus glyph
                    only exists in CJK fonts and renders as tofu without one */}
                <Gtk.Image
                    $type="overlay"
                    class="ws-plus"
                    iconName="list-add-symbolic"
                    pixelSize={24}
                    visible={empty}
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.CENTER}
                />
            </overlay>
        </box>
    ) as Gtk.Box

    createEffect(() => {
        if (selectedId() === id && isVisible()) {
            container.add_css_class("selected")
        } else {
            container.remove_css_class("selected")
        }
    })

    return container
}
