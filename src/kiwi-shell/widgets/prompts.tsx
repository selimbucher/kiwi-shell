import { logger } from "../log"
const log = logger("prompts")
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, createBinding, For, onCleanup } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { exec, execAsync } from "ags/process"

import { conf } from "./config"
import { themeClasses, LAYER_NAMESPACE } from "./services/theme"
import Hyprland from "gi://AstalHyprland"
import { Icon } from "./iconNames"
import { playSound } from "./sound";
import { popupGdkMonitor, destroyWindow } from "./monitors"

export default function Prompt({ gdkmonitor, onSetup }: { gdkmonitor: Gdk.Monitor }) {
    return (
        <window
            namespace={LAYER_NAMESPACE}
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
            $={(self) => onCleanup(() => destroyWindow(self))}
        >
            <box>
                <WifiPrompt />
            </box>
        </window>
    )
}

const [showPrompt, setShowPrompt] = createState(false)


const [wifiSSID, setWifiSSID] = createState("")
let pw!: Gtk.Entry
const [pwInvalid, setpwInvalid] = createState(false)

export function openWifiPrompt(ssid: string, invalid = false) {
    pw.text = ""
    setpwInvalid(invalid)
    setWifiSSID(ssid)
    setShowPrompt(true)
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
    return (
        <box
            class="prompt-container"
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
            hexpand
            orientation={Gtk.Orientation.VERTICAL}
        >
            <box class="prompt-header" halign={Gtk.Align.CENTER}>
                <label label={pwInvalid.as(invalid => {
                    if (invalid === true) {
                        return "Wrong Password"
                    }
                    return "Wi-Fi Connection"
                })} />
            </box>
            <box class="prompt-text" halign={Gtk.Align.CENTER}>Enter the password for <label label={wifiSSID}/>.</box>
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