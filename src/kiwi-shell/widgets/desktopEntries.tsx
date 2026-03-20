import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"

// Maps WM class (lowercase) → desktop entry ID, and the reverse.
// Prefers StartupWMClass when set; falls back to the entry stem.
export const classToEntry = new Map<string, string>()
export const entryToClass = new Map<string, string>()

for (const appInfo of Gio.AppInfo.get_all() as GioUnix.DesktopAppInfo[]) {
    const id = appInfo.get_id()
    if (!id) continue

    const wmClass = appInfo.get_startup_wm_class()
    const key = wmClass
        ? wmClass.toLowerCase()
        : id.replace(/\.desktop$/, "").toLowerCase()

    if (!classToEntry.has(key)) {
        classToEntry.set(key, id)
        entryToClass.set(id, key)
    }
}