import { readFile, writeFileAsync, monitorFile } from "ags/file"
import { createState } from "ags"
import { exec } from "ags/process"
import { Gdk } from "ags/gtk4"
import App from "ags/app"

const HOME = exec('bash -c "echo $HOME"')
const CONFIG_FOLDER = `${HOME}/.config/desktop`
const COLOR_FILE = `${CONFIG_FOLDER}/config.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

const ROOT = typeof SRC !== "undefined" ? SRC : App.configDir
const DEFAULT_CONFIG_FILE = `${ROOT}/defaultConfig.json`

// --- 1. SAFE READ LOGIC ---
// We try to read the file. If it fails (doesn't exist), we return a default object.
function getInitialColors() {
    try {
        const content = readFile(COLOR_FILE)
        return JSON.parse(content)
    } catch (error) {
        exec(`mkdir -p ${CONFIG_FOLDER}`)
        exec(`cp ${DEFAULT_CONFIG_FILE} ${COLOR_FILE}`)
        const content = readFile(DEFAULT_CONFIG_FILE)
        return JSON.parse(content)
    }
}

const config = getInitialColors()
const borderOpacity = 0.7;

export const [primaryColor, setPrimaryColor] = createState(config.primary_color)

export const [conf, setConf] = createState(config)

export async function storePrimaryColor(color: Gdk.RGBA) {
    const colorString = color.to_string()
    
    // Update state and local object
    setPrimaryColor(colorString)
    config.primary_color = colorString
    
    setConf({ ...config })
    
    const jsonString = JSON.stringify(config, null, 2)  

    // Prepare Hyprland string
    const borderColor = color.copy()
    borderColor.alpha = borderOpacity
    const hyprString = `$primaryColor = ${borderColor.to_string()}`

    // --- 2. SAFE WRITE LOGIC ---
    // Ensure the folder exists before writing. 'mkdir -p' is safe to run even if it exists.
    exec(`mkdir -p ${CONFIG_FOLDER}`)

    try {
        await writeFileAsync(COLOR_FILE, jsonString)
        await writeFileAsync(HYPR_FILE, hyprString)
    } catch (error) {
        console.error("Failed to save colors:", error)
    }
}

monitorFile(COLOR_FILE, () => {
    try {
        const newConf = JSON.parse(readFile(COLOR_FILE));
        // Overwriting the variable triggers the UI update
        setConf({ ...newConf })
    } catch (e) {
        console.error("Failed to parse updated config file:", e);
    }
});