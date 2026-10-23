import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Soup from "gi://Soup?version=3.0"

import { logger } from "../../log"

const log = logger("covers")

// ─── Covers from the web ──────────────────────────────────────────────────────
// A player's cover from the web (Spotify's), fetched here rather than by
// AstalMpris through gvfs. gvfs's downloader waits forever on a connection
// that died under it (a sleep, a network change), and AstalMpris lists a
// player only once its cover is in: one hung download hid Now Playing
// altogether. kiwi runs without gvfs (GIO_USE_VFS=local, flake.nix), so
// AstalMpris gives up on a web cover at once, and it is fetched here instead,
// given up on after a few seconds. The last few hundred are kept.

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), "kiwi-shell", "covers"])
const KEEP = 200
const session = new Soup.Session({ user_agent: "kiwi-shell", timeout: 10 })
const fetching = new Map<string, Promise<string | null>>()

const fileOf = (url: string) =>
    GLib.build_filenamev([DIR, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)!])

export const isWebCover = (url: string) => /^https?:\/\//.test(url)

/** The cover at `url` as a file if it has been fetched already, at once. */
export function fetchedCover(url: string): string | null {
    const file = fileOf(url)
    return GLib.file_test(file, GLib.FileTest.EXISTS) ? file : null
}

/** The cover at `url` as a file, fetched the first time; null if it can't be had. */
export function coverFile(url: string): Promise<string | null> {
    const file = fileOf(url)
    if (GLib.file_test(file, GLib.FileTest.EXISTS)) return Promise.resolve(file)
    let pending = fetching.get(url)
    if (!pending) {
        pending = fetchTo(url, file).finally(() => fetching.delete(url))
        fetching.set(url, pending)
    }
    return pending
}

function fetchTo(url: string, file: string): Promise<string | null> {
    const message = Soup.Message.new("GET", url)
    if (!message) return Promise.resolve(null)
    return new Promise(resolve => {
        session.send_and_read_async(message, GLib.PRIORITY_LOW, null, (_s, result) => {
            try {
                const bytes = session.send_and_read_finish(result)
                if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`)
                GLib.mkdir_with_parents(DIR, 0o755)
                GLib.file_set_contents(file, bytes.get_data() ?? new Uint8Array())
                prune()
                resolve(file)
            } catch (e) {
                log.warn(`no cover from ${url}: ${(e as Error).message ?? e}`)
                resolve(null)
            }
        })
    })
}

// the oldest go once there are more than KEEP
function prune() {
    const files: { file: Gio.File; time: number }[] = []
    try {
        const list = Gio.File.new_for_path(DIR).enumerate_children("standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null)
        for (let info = list.next_file(null); info; info = list.next_file(null))
            files.push({ file: list.get_child(info), time: info.get_attribute_uint64("time::modified") })
        list.close(null)
    } catch {
        return
    }
    files.sort((a, b) => b.time - a.time).slice(KEEP).forEach(({ file }) => {
        try {
            file.delete(null)
        } catch {
            // gone already
        }
    })
}
