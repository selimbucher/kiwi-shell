import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widgets/Bar/Bar"
import IndicatorBar from "./widgets/IndicatorBar/IndicatorBar"
import AppSwitcher, {
  toggleAppSwitcher,
} from "./widgets/AppSwitcher/AppSwitcher"
import Dock from "./widgets/Dock/Dock"
import { execAsync } from "ags/process"
import Prompt from "./widgets/prompts"
import { For, This, createBinding, createState } from "ags"
import NotificationCenter, {
  toggleNc,
} from "./widgets/Notifications/NotificationCenter"

let sawWarning = false

const [debug, setDebug] = createState(false)
export { debug }

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    const [cmd, arg, ...rest] = argv
    if (cmd == "show") {
      const string = `WARNING: kiwictl show command is deprecated. This is now handled automatically.`
      if (!sawWarning) {
        try {
          execAsync(["notify-send", "Kiwi Shell", string])
        } catch (error) {}
        sawWarning = true
      }
      response(string)
    } else if (cmd == "apps") {
      toggleAppSwitcher(arg)
      response(``)
    } else if (cmd == "quit") {
      app.quit()
    } else if (cmd == "debug") {
      setDebug(true)
    } else if (cmd == undefined) {
      response(`Kiwi-Shell already running.`)
    } else {
      response(`Unknown command: ${cmd}`)
    }
  },
  css: style,
  main() {
    const monitors = createBinding(app, "monitors")

    return (
      <For each={monitors}>
        {(gdkmonitor, index) => (
          <This this={app}>
            <Bar gdkmonitor={gdkmonitor} toggleNc={toggleNc} />
            <Dock gdkmonitor={gdkmonitor} />
            <NotificationCenter gdkmonitor={gdkmonitor} />
            {index() === 0 && <IndicatorBar gdkmonitor={gdkmonitor} />}
            {index() === 0 && <AppSwitcher gdkmonitor={gdkmonitor} />}
            {index() === 0 && <Prompt gdkmonitor={gdkmonitor} />}
          </This>
        )}
      </For>
    )
  },
})
