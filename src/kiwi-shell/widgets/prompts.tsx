import { logger } from "../log"
const log = logger("prompts")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For, onCleanup } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { exec, execAsync } from "ags/process"

import { conf } from "./config"
import { themeClasses, LAYER } from "./services/theme"
import Hyprland from "gi://AstalHyprland"
import { Icon } from "./iconNames"
import { playSound } from "./sound";
import { popupGdkMonitor, destroyWindow } from "./monitors"

export default function Prompt({ gdkmonitor, onSetup }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            namespace={LAYER.panel}
            css={conf.as(conf => 
                `
                --primary: ${conf.primary_color};
                `
            )}
            name="ags-prompt"
            class={themeClasses(t => `Prompt ${t}`)}
            gdkmonitor={createComputed(get => get(popupGdkMonitor) ?? gdkmonitor)}
            exclusivity={Astal.Exclusivity.IGNORE}
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.RIGHT | Astal.WindowAnchor.TOP}
            visible={showPrompt}
            application={app}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.EXCLUSIVE}
            $={(self) => {
                // it takes the keyboard while it is up, so escape has to be
                // answered here or there is no way out but the mouse
                const keys = new Gtk.EventControllerKey()
                // ahead of the entry, which has the focus and the key first
                keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
                keys.connect("key-pressed", (_controller, keyval: number) => {
                    if (keyval === Gdk.KEY_Escape) {
                        setShowPrompt(false)
                        return Gdk.EVENT_STOP
                    }
                    // a choice prompt has no entry to take Enter: it means the primary
                    if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && kind() === "choice") {
                        const primary = choice()?.choices.find(c => c.primary)
                        if (primary) choose(primary)
                        return Gdk.EVENT_STOP
                    }
                    return Gdk.EVENT_PROPAGATE
                })
                self.add_controller(keys)
                onCleanup(() => destroyWindow(self))
            }}
        >
            <box>
                <WifiPrompt />
                <ChoicePrompt />
            </box>
        </window>
    )
}

const [showPrompt, setShowPrompt] = createState(false)
// which of the prompt bodies the window shows
const [kind, setKind] = createState<"wifi" | "choice">("wifi")


const [wifiSSID, setWifiSSID] = createState("")
let pw!: Gtk.Entry
const [pwInvalid, setpwInvalid] = createState(false)

export function openWifiPrompt(ssid: string, invalid = false) {
    pw.text = ""
    setpwInvalid(invalid)
    setWifiSSID(ssid)
    setKind("wifi")
    setShowPrompt(true)
}

// A question with buttons for answers: the power menu's confirmations. One
// choice may be primary (Enter picks it); Cancel and Escape are always there.
export type Choice = { label: string; primary?: boolean; run: () => void }
const [choice, setChoice] = createState<{ title: string; text: string; choices: Choice[] } | null>(null)

export function openChoicePrompt(title: string, text: string, choices: Choice[]) {
    setChoice({ title, text, choices })
    setKind("choice")
    setShowPrompt(true)
}

function choose(c: Choice) {
    setShowPrompt(false)
    c.run()
}

function ChoicePrompt() {
    return (
        <box
            class="prompt-container prompt-choice"
            visible={kind.as(k => k === "choice")}
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
            hexpand
            orientation={Gtk.Orientation.VERTICAL}
        >
            <box class="prompt-top" orientation={Gtk.Orientation.VERTICAL} hexpand>
                <label class="prompt-header" xalign={0} label={choice.as(c => c?.title ?? "")} />
                <label class="prompt-text" xalign={0} wrap maxWidthChars={38}
                    label={choice.as(c => c?.text ?? "")} />
            </box>
            <box
                class="prompt-actions"
                orientation={Gtk.Orientation.HORIZONTAL}
                halign={Gtk.Align.END}
                spacing={8}
            >
                <button onClicked={() => setShowPrompt(false)}>Cancel</button>
                <For each={choice.as(c => c?.choices ?? [])}>
                    {(c: Choice) => (
                        <button class={c.primary ? "primary" : ""} onClicked={() => choose(c)}>{c.label}</button>
                    )}
                </For>
            </box>
        </box>
    )
}

function WifiPrompt() {
    pw = (
        <entry
            class="single-entry"
            placeholderText="Password"
            visibility={false}
            //onChanged={self => print("changed: ", self.text)}
            onActivate={self => submitWifiPassword(wifiSSID(), self.text)}
        />
    )
    const title = (
        <label class="prompt-header" xalign={0}
            label={pwInvalid.as(invalid => invalid ? "Wrong Password" : "Wi-Fi Connection")} />
    )
    // the name is the one thing being asked about, so it carries the weight;
    // a long one wraps rather than stretching the dialog
    const text = (
        <label class="prompt-text" xalign={0} wrap maxWidthChars={38} useMarkup
            label={wifiSSID.as(ssid =>
                `Enter the password for <b>${ssid.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</b>.`)} />
    )

    return (
        <box
            class="prompt-container"
            visible={kind.as(k => k === "wifi")}
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
            hexpand
            orientation={Gtk.Orientation.VERTICAL}
        >
            <box class="prompt-top" orientation={Gtk.Orientation.VERTICAL} hexpand>
                {title}
                {text}
            </box>
            { pw }
            <box
                class="prompt-actions"
                orientation={Gtk.Orientation.HORIZONTAL}
                halign={Gtk.Align.END}
                spacing={8}
            >
                <button onClicked={self => setShowPrompt(false)}>Cancel</button>
                <button
                    class="primary"
                    onClicked={self => {
                        submitWifiPassword(wifiSSID(), pw.text)
                    }}
                >Submit</button>
            </box>
        </box>
    )
}


async function submitWifiPassword(ssid, password) {
    setShowPrompt(false)
    try {
        await execAsync(["nmcli", "device", "wifi", "connect", ssid, "password", password])
    } catch (e) {
        let errorLabel = "Failed to connect to Wi-Fi. Error: "+e
        if (String(e).includes("Insufficient privileges")) {
            // show error to user
            log.error("Insufficient privileges. Add yourself to the 'network' group to fix this.")
        } else if (String(e).includes("Secrets were required, but not provided") ||
            String(e).includes("property is invalid")) {
            setpwInvalid(true)
            setShowPrompt(true)
            return;
        }
        log.error(errorLabel)        
    }
}