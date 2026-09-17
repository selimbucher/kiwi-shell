import { logger } from "../../log"
const log = logger("workspaces")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createEffect, For, onCleanup } from "ags"
import Hyprland from "gi://AstalHyprland"
import { isValidClient } from "../Dock/dock-state"
import { entryForClient, AppIconImage } from "../appIcon"
import { conf } from "../config"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { applyBinds, currentBinds, registerBindSetup, isKiwiBind, describeBind, focusWorkspace, type BindOp } from "../../hypr"
import { shortcut, combo, heldModifierKey, type Shortcut } from "../../shortcuts"

const hyprland = Hyprland.get_default()

const CARD_HEIGHT = 140

export const [isVisible, setVisibility] = createState(false)
const [selectedId, setSelectedId] = createState(1)
const [displayedIds, setDisplayedIds] = createState<number[]>([])
// per-workspace client snapshot, taken when the switcher opens
const [wsClients, setWsClients] = createState<Map<number, Hyprland.Client[]>>(new Map())

// ─── Workspace switcher keybinds (shortcuts.workspace_switcher, default Super+Tab)
// Same architecture as the app switcher, all in the root submap: binde for
// cycling (Shift goes backwards), a release bind on the modifier to confirm
// (fires on every plain release — the shell no-ops it while the switcher is
// closed), and modifier+escape to abort. A launcher tap on the same modifier
// is unrelated to our release bind and keeps working — outside rebindAll we
// never unbind the modifier key.

let registered: Shortcut | null = null

async function registerSuperTabBinds() {
    const s = shortcut("workspace_switcher")
    const mod = s.mods[0]
    const next = combo(s)
    const previous = combo(s, "SHIFT")
    const confirm = `${mod} + ${heldModifierKey(s)}`
    const escape = `${mod} + escape`
    let haveConfirm = false
    let haveEscape = false
    try {
        const binds = await currentBinds()
        // any kiwi-described bind counts as ours: the launcher registers its
        // own release bind (tap-to-open) which must not read as foreign
        const foreign = binds.find((b: any) =>
            b.submap === "" && !isKiwiBind(b) && (
                (b.key === s.key && (b.modmask === s.modmask || b.modmask === (s.modmask | 1))) ||
                // a foreign *release* bind on the modifier itself (a press
                // bind, like tap-to-launch, is fine)
                (b.key === heldModifierKey(s) && b.modmask === s.modmask && b.release)
            ))
        if (foreign) {
            log.warn("foreign workspace switcher bind found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
        const onCombo = (b: any, description: string, c: string) =>
            b.description === description && `${b.modmask}` === `${s.modmask}` &&
            b.key === c.split(" + ").pop()
        haveConfirm = binds.some((b: any) => onCombo(b, "kiwi: workspaces confirm", confirm))
        haveEscape = binds.some((b: any) => onCombo(b, "kiwi: workspaces escape", escape))
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }

    const ops: BindOp[] = [
        { unbind: next },
        { unbind: previous },
        { bind: next, action: { exec: "kiwictl workspaces open-next" },
            description: "kiwi: workspaces next", flags: { repeating: true } },
        { bind: previous, action: { exec: "kiwictl workspaces previous" },
            description: "kiwi: workspaces prev", flags: { repeating: true } },
    ]
    // never unbind the modifier key here (would take tap-to-launch binds with
    // it), so only add ours when it isn't registered yet
    if (!haveConfirm)
        ops.push({ bind: confirm, action: { exec: "kiwictl workspaces confirm" },
            description: "kiwi: workspaces confirm", flags: { release: true, transparent: true } })
    if (!haveEscape)
        ops.push({ bind: escape, action: { exec: "kiwictl workspaces close" },
            description: "kiwi: workspaces escape", flags: { release: true } })

    if (await applyBinds(ops, "workspace switcher binds")) {
        registered = s
        log.info(`registered workspace switcher binds on ${next}`)
    }
}

registerBindSetup("workspaces", registerSuperTabBinds, () => {
    if (!registered) return []
    const mod = registered.mods[0]
    return [
        { unbind: combo(registered) },
        { unbind: combo(registered, "SHIFT") },
        { unbind: `${mod} + ${heldModifierKey(registered)}` },
        { unbind: `${mod} + escape` },
    ]
})

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
