import { readFile, writeFileAsync } from "ags/file"
import { createState } from "ags"
import { exec } from "ags/process"
import { Gdk } from "ags/gtk4"

const HOME = exec('bash -c "echo $HOME"')
const CONFIG_FOLDER = `${HOME}/.config/desktop`
const COLOR_FILE = `${CONFIG_FOLDER}/colors.json`
const HYPR_FILE = `${CONFIG_FOLDER}/hypr.conf`

// --- 1. SAFE READ LOGIC ---
// We try to read the file. If it fails (doesn't exist), we return a default object.
function getInitialColors() {
    try {
        const content = readFile(COLOR_FILE)
        return JSON.parse(content)
    } catch (error) {
        // Return a safe default if file is missing or corrupt
        return { primary: "rgba(179,165,231,1)" }
    }
}

const colors = getInitialColors()
const borderOpacity = 0.6;

export const [primaryColor, setPrimaryColor] = createState(colors.primary)

export async function storePrimaryColor(color: Gdk.RGBA) {
    const colorString = color.to_string()
    
    // Update state and local object
    setPrimaryColor(colorString)
    colors.primary = colorString
    
    const jsonString = JSON.stringify(colors, null, 2)  

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