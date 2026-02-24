import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { createState } from "ags"
import { exec } from "ags/process"
import { Gdk } from "ags/gtk4"
import App from "ags/app"

const HOME = exec('bash -c "echo $HOME"')
const CONFIG_FOLDER = `${HOME}/.config/desktop`
const CONFIG_FILE = `${CONFIG_FOLDER}/config.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir
const DEFAULT_CONFIG_FILE = `${ROOT}/defaultConfig.json`
const NIXOS_CONFIG_FILE = `${CONFIG_FOLDER}/initial-config.json`

// Ensure config directory exists once at startup
exec(`mkdir -p ${CONFIG_FOLDER}`)

function loadConfig() {
    try {
        const content = readFile(CONFIG_FILE)
        return JSON.parse(content)
    } catch (error) {
        try {
            const content = readFile(NIXOS_CONFIG_FILE)
            return JSON.parse(content)
        } catch (error) {
            exec(`cp ${DEFAULT_CONFIG_FILE} ${CONFIG_FILE}`)
            const content = readFile(DEFAULT_CONFIG_FILE)
            return JSON.parse(content)
        }
    }
}

const initialConfig = loadConfig()
const borderOpacity = 0.7;

export const [conf, setConf] = createState(initialConfig)
export const [primaryColor, setPrimaryColor] = createState(initialConfig.primary_color)

export async function writeConf() {
    // Read directly from the current state
    const currentConf = conf(); 
    const jsonString = JSON.stringify(currentConf, null, 2);
    
    try {
        await writeFileAsync(CONFIG_FILE, jsonString)
    } catch (error) {
        console.error("Failed to save config:", error)
    }
}

export async function storePrimaryColor(color: Gdk.RGBA) {
    const colorString = color.to_string()
    
    // Update both states
    setPrimaryColor(colorString)
    setConf({ ...conf(), primary_color: colorString })
    
    // Reuse writeConf to save the updated JSON config
    await writeConf()

    // Prepare and save Hyprland string
    const borderColor = color.copy()
    borderColor.alpha = borderOpacity
    const hyprString = `$primaryColor = ${borderColor.to_string()}`

    try {
        await writeFileAsync(HYPR_FILE, hyprString)
    } catch (error) {
        console.error("Failed to save hypr colors:", error)
    }
}

