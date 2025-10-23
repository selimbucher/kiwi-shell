import { readFile, writeFileAsync } from "ags/file"

import { createState } from "ags"
import { exec } from "ags/process"

import { Gdk } from "ags/gtk4"

const HOME = exec('bash -c "echo $HOME"')

const readColors = readFile(`${HOME}/.config/desktop/colors.json`)
const colors = JSON.parse(readColors)

const borderOpacity = 0.6;

export const [primaryColor, setPrimaryColor] = createState(colors.primary)

export async function storePrimaryColor(color: Gdk.RGBA) {
    // Convert RGBA to string for storage
    const colorString = color.to_string()
    
    setPrimaryColor(colorString)
    colors.primary = colorString  // Store as string, not RGBA object!
    
    const jsonString = JSON.stringify(colors, null, 2)  

    // Create border color with modified opacity
    const borderColor = color.copy()
    borderColor.alpha = borderOpacity
    const hyprString = `$primaryColor = ${borderColor.to_string()}`

    await writeFileAsync(`${HOME}/.config/desktop/colors.json`, jsonString)
    await writeFileAsync(`${HOME}/.config/desktop/hypr.conf`, hyprString)
}