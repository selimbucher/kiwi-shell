import { Gtk } from "ags/gtk4"
import Notifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Hyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"
import { Accessor, createComputed, createRoot, createState, onCleanup } from "ags"

import { logger } from "../../log"
import { minuteNow } from "../services/minuteClock"
import { clientSelector, focusWindow } from "../../hypr"
import { ColumnFactory } from "./AnimatedColumn"
import { CardRow, GroupRow, Row, appMatchesClient, clearAll, dismissAll, toggleGroup } from "./store"

const log = logger("notifications")

export const CARD_WIDTH = 340
const LEAD_SIZE = 36
const BADGE_SIZE = 18
const SMALL_ICON_SIZE = 16
const THUMB_SIZE = 42
// square images up to this size are pictures of a person, not content
const AVATAR_MAX_SIZE = 256

// clock for the relative timestamps, which count in minutes
const nowSec = minuteNow(t => t.to_unix())

function formatRelativeTime(time: number, now: number): string {
    const diff = Math.max(0, now - time)
    if (diff < 60) return "now"
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    if (diff < 2 * 86400) return "Yesterday"
    return GLib.DateTime.new_from_unix_local(time)?.format("%b %e") ?? ""
}

// ─── Column factory ───────────────────────────────────────────────────────────

const updaters = new WeakMap<Gtk.Widget, (row: Row) => void>()
const disposers = new WeakMap<Gtk.Widget, () => void>()

export const rowFactory: ColumnFactory<Row> = {
    create(row) {
        return createRoot(dispose => {
            const [state, setState] = createState<Row>(row)
            const widget =
                row.kind === "header" ? Header()
                : row.kind === "empty" ? Empty()
                : row.kind === "group" ? GroupHeader({ row: state as Accessor<GroupRow> })
                : Card({ row: state as Accessor<CardRow> })
            updaters.set(widget, setState)
            disposers.set(widget, dispose)
            return widget
        })
    },
    update(widget, row) {
        updaters.get(widget)?.(row)
    },
    dispose(widget) {
        disposers.get(widget)?.()
        disposers.delete(widget)
        updaters.delete(widget)
    },
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

function Header() {
    return (
        <box class="nc-header">
            <label class="nc-header-title" label="Notifications" hexpand xalign={0} />
            <button class="nc-pill" onClicked={clearAll}>
                <label label="Clear All" />
            </button>
        </box>
    ) as Gtk.Widget
}

function Empty() {
    return (
        <box class="nc-empty" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
            <Gtk.Image iconName="notifications-symbolic" pixelSize={22} class="nc-empty-icon" />
            <label class="nc-empty-text" label="No Notifications" />
        </box>
    ) as Gtk.Widget
}

function GroupHeader({ row }: { row: Accessor<GroupRow> }) {
    return (
        <box class="nc-group-header" spacing={8}>
            <box
                valign={Gtk.Align.CENTER}
                $={(self) => rebuildOnNewest(self, () => row().members[0], n => [smallIcon(n)], row)}
            />
            <label
                class="nc-group-name"
                label={row(r => r.members[0]?.appName || r.groupKey)}
                ellipsize={Pango.EllipsizeMode.END}
                hexpand
                xalign={0}
            />
            <button class="nc-pill" onClicked={() => toggleGroup(row().groupKey)}>
                <label label="Show Less" />
            </button>
            <button class="nc-round" onClicked={() => dismissAll(row().members)}>
                <Gtk.Image iconName="window-close-symbolic" pixelSize={10} />
            </button>
        </box>
    ) as Gtk.Widget
}

function Card({ row }: { row: Accessor<CardRow> }) {
    const newest = () => row().members[0]

    // macOS behavior: clicking opens the source (the default action if the
    // app has one, otherwise its window) and the notification is gone for
    // good, including from the center.
    const activate = () => {
        const n = newest()
        if ((n.actions ?? []).some(a => a.id === "default")) n.invoke("default")
        else focusApp(n)
        dismissAll(row().members)
    }

    const cardClass = row(r => [
        "nc-card",
        r.banner ? "banner" : "",
        r.members[0].urgency === Notifd.Urgency.CRITICAL ? "critical" : "",
        r.hiddenRows > 0 ? "stacked" : "",
    ].filter(Boolean).join(" "))

    const title = row(r => r.members[0].summary || r.members[0].appName || "")
    const body = row(r => r.members[0].body ?? "")
    const count = row(r => r.count > 1 ? `×${r.count}` : "")
    const time = createComputed(get => formatRelativeTime(get(row).members[0].time, get(nowSec)))

    return (
        <overlay class="nc-card-wrap">
            <box
                class={cardClass}
                orientation={Gtk.Orientation.VERTICAL}
                widthRequest={CARD_WIDTH}
                $={(self) => {
                    // a plain gesture instead of a button: clicks on nested
                    // buttons/links must not fall through to the card action
                    const click = new Gtk.GestureClick()
                    click.set_button(1)
                    click.connect("released", (_gesture, _nPress, x, y) => {
                        const target = self.pick(x, y, Gtk.PickFlags.DEFAULT)
                        for (let w: Gtk.Widget | null = target; w && w !== self; w = w.get_parent()) {
                            if (w instanceof Gtk.Button) return
                            if (w instanceof Gtk.Label && w.get_current_uri()) return
                        }
                        // clicking a collapsed stack expands its group; only
                        // an expanded (or single) card activates
                        if (row().hiddenRows > 0) toggleGroup(row().groupKey)
                        else activate()
                    })
                    self.add_controller(click)
                }}
            >
                <box class="nc-main" spacing={12}>
                    <box
                        class="nc-lead"
                        valign={Gtk.Align.CENTER}
                        $={(self) => rebuildOnNewest(self, newest, n => [leadVisual(n)], row)}
                    />
                    <box
                        class="nc-text"
                        orientation={Gtk.Orientation.VERTICAL}
                        hexpand
                        valign={Gtk.Align.CENTER}
                    >
                        <box class="nc-title-row" spacing={6}>
                            <label
                                class="nc-title"
                                label={title}
                                ellipsize={Pango.EllipsizeMode.END}
                                maxWidthChars={1}
                                hexpand
                                xalign={0}
                            />
                            <label
                                class="nc-count"
                                label={count}
                                valign={Gtk.Align.CENTER}
                                visible={count(c => c !== "")}
                            />
                            <label class="nc-time" label={time} valign={Gtk.Align.CENTER} />
                        </box>
                        <label
                            class="nc-message"
                            useMarkup
                            label={body(b => sanitizeBody(b))}
                            visible={body(b => b.trim() !== "")}
                            wrap
                            wrapMode={Pango.WrapMode.WORD_CHAR}
                            ellipsize={Pango.EllipsizeMode.END}
                            lines={row(r => r.banner ? 3 : 5)}
                            maxWidthChars={1}
                            hexpand
                            xalign={0}
                            $={(self) => {
                                self.connect("activate-link", (_label, uri: string) => {
                                    openUri(uri)
                                    return true
                                })
                            }}
                        />
                    </box>
                    <box
                        class="nc-thumb-slot"
                        valign={Gtk.Align.CENTER}
                        $={(self) => rebuildOnNewest(self, newest, n => {
                            const thumb = thumbnailVisual(n)
                            return thumb ? [thumb] : []
                        }, row)}
                    />
                </box>
                <box
                    class="nc-actions"
                    homogeneous
                    $={(self) => rebuildOnNewest(self, newest, n =>
                        (n.actions ?? [])
                            .filter(a => a.id !== "default")
                            .map(action => ActionButton(n, action, row)), row)}
                />
            </box>
            <button
                $type="overlay"
                class="nc-close"
                halign={Gtk.Align.START}
                valign={Gtk.Align.START}
                onClicked={() => dismissAll(row().members)}
            >
                <Gtk.Image iconName="window-close-symbolic" pixelSize={9} />
            </button>
        </overlay>
    ) as Gtk.Widget
}

function ActionButton(n: Notifd.Notification, action: Notifd.Action, row: Accessor<CardRow>) {
    return (
        <button
            class="nc-action"
            onClicked={() => {
                n.invoke(action.id)
                if (!n.resident) dismissAll(row().members)
            }}
        >
            {n.actionIcons
                ? <Gtk.Image iconName={action.id} pixelSize={14} />
                : <label
                    label={action.label}
                    ellipsize={Pango.EllipsizeMode.END}
                    maxWidthChars={1}
                    hexpand
                />}
        </button>
    ) as Gtk.Widget
}

// Icons, images and actions belong to one notification: the box's children
// are rebuilt only when a replacement swaps that notification out. An empty
// box hides itself.
function rebuildOnNewest(
    box: Gtk.Box,
    newest: () => Notifd.Notification | undefined,
    build: (n: Notifd.Notification) => Gtk.Widget[],
    changes?: Accessor<unknown>,
) {
    let shown: Notifd.Notification | undefined
    const rebuild = () => {
        const n = newest()
        if (!n || n === shown) return
        shown = n
        for (let c = box.get_first_child(); c; c = box.get_first_child()) box.remove(c)
        const parts = build(n)
        for (const part of parts) box.append(part)
        box.set_visible(parts.length > 0)
    }
    rebuild()
    if (changes) onCleanup(changes.subscribe(rebuild))
}

// ─── Icons / images ───────────────────────────────────────────────────────────

function filePathOf(str: string | null | undefined): string | null {
    if (!str) return null
    const path = str.startsWith("file://") ? decodeURI(str.slice("file://".length)) : str
    if (!path.startsWith("/")) return null
    return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null
}

function desktopEntryIcon(n: Notifd.Notification): string | null {
    return n.desktopEntry ? entryIcon(n.desktopEntry) : null
}

// the Icon= key of an installed application id, or null
function entryIcon(id: string): string | null {
    const base = id.endsWith(".desktop") ? id.slice(0, -".desktop".length) : id
    for (const candidate of [base, base.toLowerCase()]) {
        const info = GioUnix.DesktopAppInfo.new(candidate + ".desktop")
        const iconName = info?.get_string("Icon")
        if (iconName) return iconName
    }
    return null
}

type Source = { name: string } | { path: string }

const asSource = (icon: string): Source =>
    filePathOf(icon) ? { path: icon } : { name: icon }

// Who sent this, in the order the sender is most sure about it: the
// desktop-entry hint, then app_name, which is a desktop id often enough to be
// worth asking, then app_icon.
//
// An app handing over an absolute path to its own bundled logo steps around
// the icon theme, and its notification ends up wearing different artwork from
// its own dock icon — kitty does exactly this. So when the answer is a path
// and the file is named after an installed application, the theme has an
// opinion about that app and it wins.
function appIconSource(n: Notifd.Notification): Source | null {
    const fromEntry = desktopEntryIcon(n)
    if (fromEntry) return asSource(fromEntry)

    const fromName = n.appName ? entryIcon(n.appName) : null
    if (fromName) return asSource(fromName)

    const path = filePathOf(n.appIcon)
    if (path) {
        const stem = GLib.path_get_basename(path).replace(/\.[^.]+$/, "")
        const themed = entryIcon(stem)
        if (themed && !filePathOf(themed)) return { name: themed }
        return { path }
    }
    return n.appIcon ? { name: n.appIcon } : null
}

// the image-path / image-data hint (notifd caches image data to a file)
function imageSource(n: Notifd.Notification): Source | null {
    const path = filePathOf(n.image)
    if (path) return { path }
    return n.image ? { name: n.image } : null
}

// chat apps send the sender's picture: small and square
function looksLikeAvatar(path: string): boolean {
    try {
        const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path)
        if (!format || width <= 0 || height <= 0) return false
        return Math.abs(width - height) <= Math.max(width, height) * 0.05 &&
            Math.max(width, height) <= AVATAR_MAX_SIZE
    } catch {
        return false
    }
}

// A Gtk.Picture's natural size is the image's full size, which would blow up
// the card for large images. An overlay only measures its main child, so a
// fixed-size box dictates the size and the picture just fills it.
function picture(path: string, size: number, cssClass: string, fit: Gtk.ContentFit): Gtk.Widget {
    return (
        <overlay
            class={cssClass}
            overflow={Gtk.Overflow.HIDDEN}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
        >
            <box widthRequest={size} heightRequest={size} />
            <Gtk.Picture
                $type="overlay"
                $={(self: Gtk.Picture) => {
                    self.set_filename(path)
                    self.set_content_fit(fit)
                    self.set_can_shrink(true)
                }}
            />
        </overlay>
    ) as Gtk.Widget
}

function iconWidget(source: Source, size: number, cssClass: string): Gtk.Widget {
    if ("path" in source) return picture(source.path, size, cssClass, Gtk.ContentFit.CONTAIN)
    return (
        <Gtk.Image
            iconName={source.name}
            pixelSize={size}
            class={cssClass}
            valign={Gtk.Align.CENTER}
        />
    ) as Gtk.Widget
}

const FALLBACK_ICON: Source = { name: "dialog-information-symbolic" }

// Left of the text: the app icon, or for a message with the sender's picture,
// that picture with the app icon as a badge (like macOS Messages). Without an
// app icon, the content image takes its place.
function leadVisual(n: Notifd.Notification): Gtk.Widget {
    const app = appIconSource(n)
    const image = imageSource(n)

    if (image && "path" in image && looksLikeAvatar(image.path)) {
        const avatar = picture(image.path, LEAD_SIZE, "nc-avatar", Gtk.ContentFit.COVER)
        if (!app) return avatar
        return (
            <overlay widthRequest={LEAD_SIZE + 4} heightRequest={LEAD_SIZE + 4}>
                <box halign={Gtk.Align.START} valign={Gtk.Align.START}>{avatar}</box>
                <box
                    $type="overlay"
                    class="nc-badge"
                    halign={Gtk.Align.END}
                    valign={Gtk.Align.END}
                >
                    {iconWidget(app, BADGE_SIZE, "nc-badge-icon")}
                </box>
            </overlay>
        ) as Gtk.Widget
    }
    if (app) return iconWidget(app, LEAD_SIZE, "nc-app-icon")
    if (image && "path" in image) return picture(image.path, LEAD_SIZE, "nc-thumb", Gtk.ContentFit.COVER)
    return iconWidget(image ?? FALLBACK_ICON, LEAD_SIZE, "nc-app-icon")
}

// Right of the text: a content image (album art, screenshot) when the app
// icon already fills the left.
function thumbnailVisual(n: Notifd.Notification): Gtk.Widget | null {
    const image = imageSource(n)
    if (!image || !appIconSource(n)) return null
    if ("path" in image) {
        if (looksLikeAvatar(image.path)) return null
        return picture(image.path, THUMB_SIZE, "nc-thumb", Gtk.ContentFit.COVER)
    }
    return iconWidget(image, THUMB_SIZE - 10, "nc-thumb-icon")
}

function smallIcon(n: Notifd.Notification): Gtk.Widget {
    return iconWidget(appIconSource(n) ?? imageSource(n) ?? FALLBACK_ICON, SMALL_ICON_SIZE, "nc-small-icon")
}

// ─── Body markup ──────────────────────────────────────────────────────────────

// The spec allows a small HTML subset in the body (<b>, <i>, <u>, <a>, <img>),
// but arbitrary text is common too. Escape everything, then re-allow tags that
// GtkLabel's Pango markup understands, so stray '<', '>' and '&' can't break
// rendering. Falls back to plain text when tags don't balance.
function sanitizeBody(rawBody: string): string {
    const stripped = rawBody
        .replace(/<img[^>]*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")

    let s = GLib.markup_escape_text(stripped, -1)
    s = s.replace(/&lt;(\/?)(b|i|u|s|tt|big|small|sub|sup)&gt;/gi, "<$1$2>")
    s = s.replace(
        /&lt;a\s+href=(&quot;|&apos;)([\s\S]*?)\1&gt;/gi,
        (_match, _quote, href) => `<a href="${href.replace(/&apos;/g, "&#39;")}">`,
    )
    s = s.replace(/&lt;\/a&gt;/gi, "</a>")

    if (!tagsBalanced(s)) {
        return GLib.markup_escape_text(stripped.replace(/<[^>]*>/g, ""), -1)
    }
    return s
}

function tagsBalanced(markup: string): boolean {
    const stack: string[] = []
    const tagRe = /<(\/?)([a-z]+)(?:\s[^>]*)?>/gi
    let match: RegExpExecArray | null
    while ((match = tagRe.exec(markup)) !== null) {
        if (match[1]) {
            if (stack.pop() !== match[2].toLowerCase()) return false
        } else {
            stack.push(match[2].toLowerCase())
        }
    }
    return stack.length === 0
}

// Focus an existing window of the sending app, if there is one. Deliberately
// conservative (exact class match only) — never launches anything.
function focusApp(n: Notifd.Notification) {
    try {
        const client = Hyprland.get_default().get_clients().find(c => appMatchesClient(n, c))
        if (client) focusWindow(clientSelector(client))
    } catch (error) {
        log.error("Failed to focus app for notification:", error)
    }
}

function openUri(uri: string) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null)
    } catch (error) {
        log.error("Failed to open link:", error)
    }
}
