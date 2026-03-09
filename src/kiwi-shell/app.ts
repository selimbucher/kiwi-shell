import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widgets/Bar/Bar"
import IndicatorBar, { showIndicator } from "./widgets/IndicatorBar/IndicatorBar"
import AppSwitcher, { toggleAppSwitcher } from "./widgets/AppSwitcher/AppSwitcher"
import Dock, { EdgeSensor } from "./widgets/Dock/Dock"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

const settings = Gtk.Settings.get_default()
if (settings) {
  settings.gtk_theme_name = "WhiteSur-Dark"
  //console.log("Setting GTK theme to WhiteSur-Dark")
}

let sawWarning = false;

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    const [cmd, arg, ...rest] = argv
    if (cmd == "show") {
      const string = `WARNING: kiwictl show command is deprecated. This is now handled automatically.`
      if (!sawWarning) {
        try {
          execAsync(["notify-send", "Kiwi Shell", string])
        } catch (error) { }
        sawWarning = true
      }
      response(string)
    } else if (cmd == "apps") {
      toggleAppSwitcher(arg)
      response(``)
    } else {
      response(`Unknown command: ${cmd}`)
    }
    
  },
  css: style,
  main() {
    app.get_monitors().map(Bar)
    app.get_monitors().map(IndicatorBar)
    app.get_monitors().map(AppSwitcher)
    app.get_monitors().map(Dock)
    app.get_monitors().map(EdgeSensor)
    
  },
})
