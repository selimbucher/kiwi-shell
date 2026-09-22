import { logger } from "../../log"
const log = logger("launcher")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For, Accessor, onCleanup } from "ags"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { conf } from "../config"
import { themeClasses, LAYER } from "../services/theme"
import { popupGdkMonitor, destroyWindow } from "../monitors"
import { applyBinds, currentBinds, registerBindSetup, isKiwiBind, describeBind, dialect, type BindOp } from "../../hypr"
import { shortcut, combo, type Shortcut } from "../../shortcuts"
import { globalShortcut } from "../services/globalShortcuts"
import { search, GROUP_LABEL, type Result } from "./providers"
import { evaluate, formatNumber } from "./calc"

// Spotlight: a floating search panel on a tap of Super. Type to find an app, a
// window you already have open, a setting, or the answer to a sum; arrows or
// Tab to move; Enter to do the thing the row says it will do.
//
// The desktop behind it is left alone. macOS doesn't blur it either, and the
// blur that used to be here was a compositor-wide setting the shell moved on
// every open and put back on every close — which is what made closing stutter.
// The panel's own glass comes from its layer rule, which only touches pixels
// the panel actually paints.

const MAX_RESULTS = 8

export const [isVisible, setVisibility] = createState(false)
const [query, setQuery] = createState("")
const [selectedIdx, setSelectedIdx] = createState(0)

const results: Accessor<Result[]> = createComputed(get => {
    const text = get(query).trim()
    // nothing typed is nothing to show: the panel is a bar until it has an
    // answer, and a list of guesses is in the way of the one you came to type
    if (!text) return []
    const value = evaluate(text)
    const answer = value === null ? null : { name: formatNumber(value), detail: text }
    return search(text, answer, MAX_RESULTS)
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
//
// A hyprlang config's global dispatcher sends a release even for a bind that
// was shadowed, so Super+T would open Spotlight too. There the tap runs
// hyprctl instead, a dispatcher that is shadowed like any other, and has it
// send the press shortcut.

let registered: Shortcut | null = null

const toggle = () => isVisible() ? hideLauncher() : showLauncher()
const PRESS = globalShortcut("launcher", "Spotlight: open or close", "press", toggle)
const TAP = globalShortcut("launcher-tap", "Spotlight: open or close on a tap", "release", toggle)

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
            b.description === "kiwi: launcher" && b.key === s.key && b.modmask === s.modmask)
    } catch (e) {
        log.error("failed to query binds, skipping setup:", e)
        return
    }
    if (haveToggle) {
        registered = s
        log.debug("launcher bind already in place")
        return
    }

    const action = !s.tap ? PRESS
        : await dialect() === "lua" ? TAP
        : { exec: "hyprctl dispatch global kiwi-shell:launcher" }
    if (await applyBinds([{
        bind: combo(s), action,
        description: "kiwi: launcher", flags: { release: s.tap },
    }], "launcher bind")) {
        registered = s
        log.info(`registered launcher bind on ${combo(s)}${s.tap ? " (tap)" : ""}`)
    }
}

const launcherUnbinds = (): BindOp[] => registered ? [{ unbind: combo(registered) }] : []

registerBindSetup("launcher", registerLauncherBind, launcherUnbinds)

let entryRef: Gtk.Entry | null = null
// the compositor's own layer fade, from animations.nix — the query is only
// cleared once it has run, so the list does not visibly empty on the way out
const FADE_MS = 200
let clearTimer = 0

function showLauncher() {
    if (clearTimer) {
        GLib.source_remove(clearTimer)
        clearTimer = 0
    }
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
    if (!isVisible()) return
    setVisibility(false)
    if (clearTimer) GLib.source_remove(clearTimer)
    clearTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_MS, () => {
        clearTimer = 0
        setSelectedIdx(0)
        setQuery("")
        entryRef?.set_text("")
        return GLib.SOURCE_REMOVE
    })
}

function moveSelection(step: number) {
    const count = results().length
    if (count === 0) return
    setSelectedIdx(((selectedIdx() + step) % count + count) % count)
}

function activate(result: Result) {
    hideLauncher()
    try {
        result.activate()
    } catch (e) {
        log.error(`activating "${result.name}" failed:`, e)
    }
}

function activateSelected() {
    const list = results()
    const target = list[Math.min(selectedIdx(), list.length - 1)]
    if (target) activate(target)
}

// ─── UI ───────────────────────────────────────────────────────────────────────

/** A row's section heading, on the first row of each run of one group. */
type Row = { result: Result, header: string | null }

const rows: Accessor<Row[]> = createComputed(get =>
    get(results).map((result, index, all) => ({
        result,
        header: index === 0 || all[index - 1].group !== result.group
            ? GROUP_LABEL[result.group]
            : null,
    })))

// Each row's position in the list, for the pointer to find the row it is over.
const rowIndex = new WeakMap<Gtk.Widget, Accessor<number>>()

function ResultRow({ row, index }: { row: Row, index: Accessor<number> }) {
    const selected = createComputed(get => get(selectedIdx) === get(index))
    const { result } = row

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            {row.header && (
                <label class="launcher-group" label={row.header} xalign={0} />
            )}
            <box
                class={selected.as(on => on ? "launcher-row selected" : "launcher-row")}
                spacing={12}
                $={(self) => {
                    rowIndex.set(self, index)
                    const click = new Gtk.GestureClick()
                    click.connect("released", () => activate(result))
                    self.add_controller(click)
                }}
            >
                <Gtk.Image
                    iconName={result.iconName}
                    gicon={result.gicon}
                    pixelSize={result.group === "apps" || result.group === "windows" ? 30 : 22}
                    class={result.group === "apps" || result.group === "windows"
                        ? "launcher-row-icon" : "launcher-row-icon symbolic"}
                />
                <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                    <label
                        class="launcher-row-name"
                        label={result.name}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={1}
                        hexpand
                        xalign={0}
                    />
                    {result.detail && (
                        <label
                            class="launcher-row-desc"
                            label={result.detail}
                            ellipsize={Pango.EllipsizeMode.END}
                            maxWidthChars={1}
                            hexpand
                            xalign={0}
                        />
                    )}
                </box>
                {/* what Enter does, on the row it would do it to */}
                <box class="launcher-verb" valign={Gtk.Align.CENTER} spacing={5} visible={selected}>
                    <label class="launcher-verb-label" label={result.verb} />
                    <label class="launcher-verb-key" label="↵" />
                </box>
            </box>
        </box>
    )
}

export default function Launcher({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
    // spotlight sits in the upper part of the screen, top edge fixed so the
    // panel only ever grows downwards while results appear
    const marginTop = createComputed(get =>
        Math.round((get(popupGdkMonitor) ?? gdkmonitor).get_geometry().height * 0.2))
    let panelRef: Gtk.Box

    return (
        <window
            namespace={LAYER.scrim}
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

                // A pointer that moves takes the selection, so clicking and
                // Enter never disagree about which row is the live one. One
                // that rests does not: every keystroke rebuilds the rows, and
                // GTK hands the row that lands under a still pointer an enter
                // and a motion at the same spot, which pulled the selection
                // off the top result on each stroke. The window covers the
                // screen, so only a hand on the mouse changes the position.
                let pointer: [number, number] | null = null
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", (_controller, x, y) => { pointer = [x, y] })
                motion.connect("leave", () => { pointer = null })
                motion.connect("motion", (_controller, x, y) => {
                    if (!pointer || (pointer[0] === x && pointer[1] === y)) {
                        pointer = [x, y]
                        return
                    }
                    pointer = [x, y]
                    for (let w = self.pick(x, y, Gtk.PickFlags.DEFAULT); w; w = w.get_parent()) {
                        const index = rowIndex.get(w)
                        if (index) {
                            setSelectedIdx(index())
                            return
                        }
                    }
                })
                self.add_controller(motion)
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
                    widthRequest={660}
                    $={(self) => { panelRef = self }}
                >
                    <box class="launcher-search-row" spacing={12}>
                        <Gtk.Image
                            iconName="system-search-symbolic"
                            pixelSize={22}
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
                            onActivate={() => activateSelected()}
                            $={(self) => { entryRef = self }}
                        />
                    </box>
                    <box
                        class="launcher-results"
                        orientation={Gtk.Orientation.VERTICAL}
                        visible={rows.as(r => r.length > 0)}
                    >
                        <For each={rows}>
                            {(row: Row, index: Accessor<number>) => (
                                <ResultRow row={row} index={index} />
                            )}
                        </For>
                    </box>
                </box>
            </box>
        </window>
    )
}
