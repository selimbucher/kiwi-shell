import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widgets/Bar/Bar"
import IndicatorBar, { showIndicator } from "./widgets/IndicatorBar/IndicatorBar"
import AppSwitcher, { toggleAppSwitcher } from "./widgets/AppSwitcher/AppSwitcher"
import Dock, { EdgeSensor } from "./widgets/Dock/Dock"
import { Gtk } from "ags/gtk4"

const settings = Gtk.Settings.get_default()
if (settings) {
  settings.gtk_theme_name = "WhiteSur-Dark"
  //console.log("Setting GTK theme to WhiteSur-Dark")
}

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    const [cmd, arg, ...rest] = argv
    if (cmd == "show") {
      showIndicator(arg)
      response(``)
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
