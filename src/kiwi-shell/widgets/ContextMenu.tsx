import { Gtk } from "ags/gtk4"
import { type Accessor } from "ags"
import { Icon } from "./iconNames"

// Every right-click menu in the shell pops one of these. Hand-rolled, the
// copies had already drifted apart on padding, and not one of them drew a
// separator — so a menu read as a flat stack of buttons with no sign of
// which of them belonged together.

export type ContextMenuItem = {
    // a rule between the group above and the group below; every other field
    // but `visible` is ignored
    separator?: boolean
    label?: string | Accessor<string>
    // an icon name, or a ready-made widget for the app icons the dock puts
    // in its menus
    icon?: string | Gtk.Widget
    // why an item is insensitive: dimming alone says "not now" but never why
    tooltip?: string
    onClick?: () => void
    visible?: boolean | Accessor<boolean>
    sensitive?: boolean | Accessor<boolean>
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
                    : typeof item.icon === "string"
                        ? <Icon class="context-menu-icon" iconName={item.icon} pixelSize={iconSize} />
                        : item.icon}
                <label halign={Gtk.Align.START} label={item.label ?? ""} />
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
                if (onVisible)
                    self.connect("notify::visible", () => onVisible(self.visible))
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                {items.map((item) => item.separator
                    ? <Gtk.Separator visible={item.visible ?? true} />
                    : <MenuRow
                        item={item}
                        iconSize={iconSize}
                        popdown={() => popover.popdown()}
                    />)}
            </box>
        </popover>
    ) as Gtk.Popover
}
