import { Gtk } from 'ags/gtk4'
import { exec, execAsync } from 'ags/process';

import calendarService from './calendarUtil'
async function runDiagnostics() {
    await calendarService.getCalendarSources();
    await calendarService.checkCalendarDatabases();
    await calendarService.findICSFiles();
    await calendarService.getNextEventFromICS();
}

export default function CalendarTab({visible}) {
    return (
        <box visible={visible} orientation={Gtk.Orientation.VERTICAL}>
            Upcoming Events
        </box>
    )
}