import { logger } from "../../log"
const log = logger("launcher")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For, Accessor, onCleanup } from "ags"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Apps from "gi://AstalApps"
import { conf } from "../config"
import { themeClasses, LAYER_NAMESPACE } from "../services/theme"
import { mapVersion } from "../desktopEntries"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { applyBinds, currentBinds, registerBindSetup, isKiwiBind, describeBind, type BindOp } from "../../hypr"
import { shortcut, combo, type Shortcut } from "../../shortcuts"

// Spotlight-style launcher: a centered glass search panel on Super+Space.
// Type to fuzzy-search applications, arrows/Tab to select, Enter to launch,
// Escape or a click on the backdrop to dismiss.

const apps = new Apps.Apps()

// desktopEntries already watches the application dirs — piggyback on it to
// keep the search index fresh
mapVersion.subscribe(() => apps.reload())

const MAX_RESULTS = 7

export const [isVisible, setVisibility] = createState(false)
const [query, setQuery] = createState("")
const [selectedIdx, setSelectedIdx] = createState(0)

const results = createComputed(get => {
    const text = get(query).trim()
    if (!text) return [] as Apps.Application[]
    return apps.fuzzy_query(text).slice(0, MAX_RESULTS)
})

// ─── Launcher keybind (shortcuts.launcher, default: tap Super) ─────────────────
// A tap is rofi-style: a release bind on the modifier's own key. Hyprland
// shadows non-transparent binds whenever another bind (key, mouse or scroll)
// fires while the mod is held — shadowKeybinds() in KeybindManager.cpp — so
// this only triggers on a clean tap. A switcher's confirm on the same key is
// a transparent bindrt: it cannot be shadowed, keeps firing after Super+Tab,
// and is no-op guarded shell-side. Any other shortcut is a plain press bind.
// Reloads wipe dynamic binds; registerBindSetup re-runs this after each.
// The combo is only unbound when the shortcut changes (rebindAll), since
// that also takes a switcher confirm on the same key with it.

let registered: Shortcut | null = null

async function registerLauncherBind() {
    const s = shortcut("launcher")
    let haveToggle = false
    try {
        const binds = await currentBinds()
        // any foreign bind on the same combo (for a tap, press or release —
        // both collide with tap semantics) means the user has their own setup
        const foreign = binds.find((b: any) =>
            b.key === s.key && b.modmask === s.modmask &&
            b.submap === "" && !isKiwiBind(b))
        if (foreign) {
            log.warn("foreign bind on the launcher shortcut found, leaving keybinds alone:",
                describeBind(foreign))
            return
        }
        haveToggle = binds.some((b: any) =>
            b.description === "kiwi: launcher toggle" && b.key === s.key && b.modmask === s.modmask)
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }
    if (haveToggle) {
        registered = s
        log.debug("launcher bind already in place")
        return
    }

    if (await applyBinds([{
        bind: combo(s), action: { exec: "kiwictl launcher toggle" },
        description: "kiwi: launcher toggle", flags: { release: s.tap },
    }], "launcher bind")) {
        registered = s
        log.info(`registered launcher bind on ${combo(s)}${s.tap ? " (tap)" : ""}`)
    }
}

const launcherUnbinds = (): BindOp[] => registered ? [{ unbind: combo(registered) }] : []

registerBindSetup("launcher", registerLauncherBind, launcherUnbinds)

// ─── Public API ───────────────────────────────────────────────────────────────
export function toggleLauncher(cmd: string) {
    switch (cmd) {
        case "open":
            showLauncher()
            break
        case "close":
            hideLauncher()
            break
        case "toggle":
        default:
            if (isVisible()) hideLauncher()
            else showLauncher()
    }
}

let entryRef: Gtk.Entry | null = null

function showLauncher() {
    setSelectedIdx(0)
    setQuery("")
    entryRef?.set_text("")
    setVisibility(true)
    // the entry can only take focus once the surface is mapped
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        entryRef?.grab_focus()
        return GLib.SOURCE_REMOVE
    })
}

function hideLauncher() {
    setVisibility(false)
}

function moveSelection(step: number) {
    const count = results().length
    if (count === 0) return
    setSelectedIdx(((selectedIdx() + step) % count + count) % count)
}

function launchSelected() {
    const list = results()
    const target = list[Math.min(selectedIdx(), list.length - 1)]
    if (!target) return
    hideLauncher()
    target.launch()
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function ResultRow({ application, index }: {
    application: Apps.Application
    index: Accessor<number>
}) {
    const rowClass = createComputed(get =>
        get(selectedIdx) === get(index) ? "launcher-row selected" : "launcher-row")
    const description = application.get_description()

    return (
        <box
            class={rowClass}
            spacing={12}
            $={(self) => {
                const click = new Gtk.GestureClick()
                click.connect("released", () => {
                    hideLauncher()
                    application.launch()
                })
                self.add_controller(click)
            }}
        >
            <Gtk.Image
                iconName={application.get_icon_name() || "application-x-executable"}
                pixelSize={30}
                class="launcher-row-icon"
            />
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                <label
                    class="launcher-row-name"
                    label={application.get_name()}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                    xalign={0}
                />
                {description && (
                    <label
                        class="launcher-row-desc"
                        label={description}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={1}
                        hexpand
                        xalign={0}
                    />
                )}
            </box>
        </box>
    )
}

export default function Launcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // spotlight sits in the upper part of the screen, top edge fixed so the
    // panel only ever grows downwards while results appear
    const marginTop = createComputed(get =>
        Math.round((get(popupGdkMonitor) ?? gdkmonitor).get_geometry().height * 0.22))
    let panelRef: Gtk.Box

    return (
        <window
            namespace={LAYER_NAMESPACE}
            css={conf.as((conf: any) => `--primary: ${conf.primary_color};`)}
            visible={isVisible}
            name="ags-launcher"
            class={themeClasses(t => `Launcher ${t}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            application={app}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.EXCLUSIVE}
            $={(self) => {
                onCleanup(() => destroyWindow(self))
                const keys = new Gtk.EventControllerKey()
                keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                keys.connect("key-pressed", (_controller, keyval) => {
                    if (keyval === Gdk.KEY_Escape) {
                        hideLauncher()
                        return Gdk.EVENT_STOP
                    }
                    if (keyval === Gdk.KEY_Down || keyval === Gdk.KEY_Tab) {
                        moveSelection(1)
                        return Gdk.EVENT_STOP
                    }
                    if (keyval === Gdk.KEY_Up || keyval === Gdk.KEY_ISO_Left_Tab) {
                        moveSelection(-1)
                        return Gdk.EVENT_STOP
                    }
                    return Gdk.EVENT_PROPAGATE
                })
                self.add_controller(keys)
            }}
        >
            <box
                class="launcher-backdrop"
                orientation={Gtk.Orientation.VERTICAL}
                $={(self) => {
                    // click anywhere outside the panel dismisses
                    const click = new Gtk.GestureClick()
                    click.connect("pressed", (_gesture, _n, x, y) => {
                        const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                        for (let w: Gtk.Widget | null = target; w; w = w.get_parent()) {
                            if (w === panelRef) return
                        }
                        hideLauncher()
                    })
                    self.add_controller(click)
                }}
            >
                <box
                    class="launcher-panel"
                    orientation={Gtk.Orientation.VERTICAL}
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.START}
                    marginTop={marginTop}
                    widthRequest={620}
                    $={(self) => { panelRef = self }}
                >
                    <box class="launcher-search-row" spacing={10}>
                        <Gtk.Image
                            iconName="system-search-symbolic"
                            pixelSize={20}
                            class="launcher-search-icon"
                        />
                        <entry
                            class="launcher-entry"
                            hexpand
                            placeholderText="Search"
                            onChanged={(self) => {
                                setSelectedIdx(0)
                                setQuery(self.text)
                            }}
                            onActivate={() => launchSelected()}
                            $={(self) => { entryRef = self }}
                        />
                    </box>
                    <box
                        class="launcher-results"
                        orientation={Gtk.Orientation.VERTICAL}
                        visible={results.as(r => r.length > 0)}
                    >
                        <For each={results}>
                            {(application: Apps.Application, index: Accessor<number>) => (
                                <ResultRow application={application} index={index} />
                            )}
                        </For>
                    </box>
                </box>
            </box>
        </window>
    )
}
