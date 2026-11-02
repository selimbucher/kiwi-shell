import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { Zoomed } from "./zoom"
import { For, type Accessor } from "ags"
import { Icon } from "./iconNames"
import { keyboardWhileOpen } from "./monitors"

// Every right-click menu in the shell pops one of these. Hand-rolled, the
// copies had already drifted apart on padding, and not one of them drew a
// separator — so a menu read as a flat stack of buttons with no sign of
// which of them belonged together.

export type ContextMenuItem = {
    // a rule between the group above and the group below; every other field
    // but `visible` is ignored
    separator?: boolean
    label?: string | Accessor<string>
    // an icon name (one that changes: a window's mark), or a ready-made
    // widget for the app icons the dock puts in its menus
    icon?: string | Accessor<string> | Gtk.Widget
    // why an item is insensitive: dimming alone says "not now" but never why
    tooltip?: string
    onClick?: () => void
    visible?: boolean | Accessor<boolean>
    sensitive?: boolean | Accessor<boolean>
    // rows that come and go, in place of this one (a dock icon's windows),
    // each kept by its key while it stays
    rows?: Accessor<(ContextMenuItem & { key: string })[]>
}

function MenuRow({ item, iconSize, popdown }: {
    item: ContextMenuItem
    iconSize: number
    popdown: () => void
}) {
    return (
        <button
            visible={item.visible ?? true}
            sensitive={item.sensitive ?? true}
            onclicked={() => {
                popdown()
                item.onClick?.()
            }}
            $={(self) => { if (item.tooltip) self.tooltipText = item.tooltip }}
        >
            <box spacing={6}>
                {item.icon === undefined
                    // an iconless row still leaves the gap, so one missing
                    // icon can't shunt its label out of the column
                    ? <box widthRequest={iconSize} />
                    : typeof item.icon === "string" || typeof item.icon === "function"
                        ? <box widthRequest={iconSize}>
                            <Icon class="context-menu-icon" iconName={item.icon as string} pixelSize={iconSize} />
                          </box>
                        : item.icon}
                {/* a window's title can be a sentence: cut, not a menu as wide as it */}
                <label halign={Gtk.Align.START} label={item.label ?? ""}
                    maxWidthChars={42} ellipsize={Pango.EllipsizeMode.END} />
            </box>
        </button>
    )
}

export function ContextMenu({ items, class: className = "context-menu", iconSize = 16, onVisible }: {
    items: ContextMenuItem[]
    class?: string
    iconSize?: number
    onVisible?: (visible: boolean) => void
}): Gtk.Popover {
    let popover: Gtk.Popover

    return (
        <popover
            autohide={true}
            hasArrow={false}
            // expand flags propagate up out of a popover into the widget it
            // hangs off — a hexpanding label inside would widen a dock cell
            // (see the flyout note in Dock/AppIcon.tsx)
            hexpand={false}
            vexpand={false}
            class={className}
            $={(self) => {
                popover = self
                keyboardWhileOpen(self as Gtk.Popover)
                if (onVisible)
                    self.connect("notify::visible", () => onVisible(self.visible))
            }}
        >
            <Zoomed>
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {items.map((item) => item.rows
                        ? <box orientation={Gtk.Orientation.VERTICAL} visible={item.visible ?? true}>
                            <For each={item.rows} id={(row) => row.key}>
                                {(row) => <MenuRow item={row} iconSize={iconSize}
                                    popdown={() => popover.popdown()} />}
                            </For>
                          </box>
                        : item.separator
                        ? <Gtk.Separator visible={item.visible ?? true} />
                        : <MenuRow
                            item={item}
                            iconSize={iconSize}
                            popdown={() => popover.popdown()}
                        />)}
                </box>
            </Zoomed>
        </popover>
    ) as Gtk.Popover
}
