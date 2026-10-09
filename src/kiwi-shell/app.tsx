import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widgets/Bar/Bar"
import IndicatorBar from "./widgets/IndicatorBar/IndicatorBar"
import AppSwitcher from "./widgets/AppSwitcher/AppSwitcher"
import WorkspaceSwitcher from "./widgets/WorkspaceSwitcher/WorkspaceSwitcher"
import Dock from "./widgets/Dock/Dock"
import Desktop from "./widgets/Desktop/Desktop"
import Launcher from "./widgets/Launcher/Launcher"
import Prompt from "./widgets/prompts"
import { For, This, createBinding } from "ags"
import NotificationCenter, {
  toggleNc,
} from "./widgets/Notifications/NotificationCenter"
import { handleCliRequest } from "./cli"
import { logger } from "./log"

import steamDesktopPatcher from "./widgets/services/steamDesktopPatcher";
import nightShiftService from "./widgets/services/nightShiftSchedule"
import { loadPlugins } from "./hypr"

logger("kiwi").info("kiwi-shell starting")

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    handleCliRequest(argv, response)
  },
  css: style,
  main() {
    steamDesktopPatcher()
    nightShiftService()
    loadPlugins()

    const monitors = createBinding(app, "monitors")

    return (
      <For each={monitors}>
        {(gdkmonitor, index) => (
          <This this={app}>
            <Bar gdkmonitor={gdkmonitor} toggleNc={toggleNc} />
            <Dock gdkmonitor={gdkmonitor} />
            {/* popups follow popupGdkMonitor — one instance is enough */}
            {index() === 0 && <NotificationCenter gdkmonitor={gdkmonitor} />}
            {index() === 0 && <Desktop gdkmonitor={gdkmonitor} />}
            {index() === 0 && <IndicatorBar gdkmonitor={gdkmonitor} />}
            {index() === 0 && <AppSwitcher gdkmonitor={gdkmonitor} />}
            {index() === 0 && <WorkspaceSwitcher gdkmonitor={gdkmonitor} />}
            {index() === 0 && <Launcher gdkmonitor={gdkmonitor} />}
            {index() === 0 && <Prompt gdkmonitor={gdkmonitor} />}
          </This>
        )}
      </For>
    )
  },
})
