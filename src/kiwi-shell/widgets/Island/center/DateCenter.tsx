import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

import { minuteNow } from "../../services/minuteClock"

// ─── The date ─────────────────────────────────────────────────────────────────
// The day in the middle, its weekday written out, the month under it: the
// classic desktop's clock and calendar. The time stays at the right end,
// where the Mac has it, with the weekday short beside it as the Mac's menu
// bar clock has (Bar.tsx). macOS has the calendar as a Notification Center
// widget instead.

export default function DateCenter() {
    let calendar: Gtk.Calendar | null = null

    return (
        <menubutton class="island-date" valign={Gtk.Align.CENTER} alwaysShowArrow={false}>
            <label class="date" label={minuteNow(t => t.format("%A %b %-d") ?? "")} />
            <popover class="island-calendar" hasArrow={false} autohide
                onShow={() => {
                    // back to today every time it opens, whatever month was left
                    const today = GLib.DateTime.new_now_local()
                    calendar?.set_year(today.get_year())
                    calendar?.set_month(today.get_month() - 1)
                    calendar?.set_day(today.get_day_of_month())
                }}>
                <box orientation={Gtk.Orientation.VERTICAL}>
                    <label class="today" xalign={0} label={minuteNow(t => t.format("%A, %B %-d") ?? "")} />
                    <Gtk.Calendar showHeading showDayNames showWeekNumbers={false}
                        $={self => { calendar = self }} />
                </box>
            </popover>
        </menubutton>
    )
}
