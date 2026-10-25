import Gio from "gi://Gio"
import GLib from "gi://GLib"

// ─── Files without gvfs, for the shell alone ──────────────────────────────────
// The shell runs on GIO's local files only (GIO_USE_VFS=local, set by its
// wrapper): gvfs's web downloader can hang for good, and with it every media
// player AstalMpris lists (services/covers.ts). The variable chooses the VFS
// once, as GIO first needs it — here, before anything else of the shell's
// runs — and is then taken out of the environment, so what the shell starts
// isn't without gvfs too: apps launched from the Dock lost trash://, sftp://
// and phones, and `gio trash --empty` (Empty Trash) didn't work at all.
Gio.Vfs.get_default()
GLib.unsetenv("GIO_USE_VFS")
