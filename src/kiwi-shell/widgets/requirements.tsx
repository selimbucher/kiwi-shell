import app from "ags/gtk4/app"
import { exec } from "ags/process"

const REQUIRED_SERVICES = [
    { name: "NetworkManager", unit: "NetworkManager.service", user: false },
    { name: "BlueZ", unit: "bluetooth.service", user: false },
    { name: "Power Profiles Daemon", unit: "power-profiles-daemon.service", user: false },
    { name: "WirePlumber", unit: "wireplumber.service", user: true },
]

export function checkRequirements() {
    let quit = false
    for (const service of REQUIRED_SERVICES) {
        try {
            const flag = service.user ? "--user" : ""
            const result = exec(`systemctl ${flag} is-active ${service.unit}`).trim()
            if (result !== "active") {
                console.error(`[kiwi-shell] Required service not active: ${service.name} (${service.unit}) — status: ${result}`)
                quit = true
            }
        } catch {
            console.error(`[kiwi-shell] Failed to check service: ${service.name} (${service.unit})`)
            quit = true
        }
    }
    if (quit)
        app.quit()
}