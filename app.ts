import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widget/Bar"
import IndicatorBar, { showIndicator } from "./widget/IndicatorBar"
import { Gtk } from "ags/gtk4"

const settings = Gtk.Settings.get_default()
if (settings) {
  settings.gtk_theme_name = "WhiteSur-Dark" // or your preferred theme
}

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    const [cmd, arg, ...rest] = argv
    if (cmd == "show") {
      showIndicator(arg)
      response(``)
      return
    }
    response(`Unknown command: ${cmd}`)
  },
  css: style,
  main() {
    app.get_monitors().map(Bar)
    app.get_monitors().map(IndicatorBar)
  },
})
