// first: what the shell starts gets the environment it was started with
import "./widgets/services/localVfs"
import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widgets/Bar/Bar"
import IndicatorBar from "./widgets/IndicatorBar/IndicatorBar"
import { IslandCard } from "./widgets/Island/Island"
import AppSwitcher from "./widgets/AppSwitcher/AppSwitcher"
import MissionControl from "./widgets/MissionControl/MissionControl"
import SnapAssist from "./widgets/SnapAssist/SnapAssist"
import WorkspaceSwitcher from "./widgets/WorkspaceSwitcher/WorkspaceSwitcher"
import Dock from "./widgets/Dock/Dock"
import Desktop from "./widgets/Desktop/Desktop"
import Launcher from "./widgets/Launcher/Launcher"
import Prompt from "./widgets/prompts"
import { For, This, createBinding, createRoot } from "ags"
import type { Gdk } from "ags/gtk4"
import NotificationCenter, {
  toggleNc,
} from "./widgets/Notifications/NotificationCenter"
import { handleCliRequest } from "./cli"
import { logger } from "./log"

import steamDesktopPatcher from "./widgets/services/steamDesktopPatcher";
import nightShiftService from "./widgets/services/nightShiftSchedule"
import { loadPlugins } from "./hypr"
import { standOnOwnBase } from "./widgets/services/gtkBase"
import { useShellFont } from "./widgets/services/font"
import "./widgets/services/gestures"
import "./widgets/services/focusTrail"

logger("kiwi").info("kiwi-shell starting")

app.start({
  requestHandler(argv: string[], response: (response: string) => void) {
    handleCliRequest(argv, response)
  },
  main() {
    // on a base of its own, not the desktop's theme, the shell's style over it
    standOnOwnBase()
    app.apply_css(style)
    // the font the settings choose, over the stylesheet's Quicksand
    useShellFont()
    steamDesktopPatcher()
    nightShiftService()
    loadPlugins()

    const monitors = createBinding(app, "monitors")

    // The windows there is one of (popups follow popupGdkMonitor) are the
    // first display's, whichever that is: when it goes, they're built again
    // for the next one, rather than going with it. Built in a scope of their
    // own, outside any effect: in one (gnim's With), whatever state they read
    // as they were built became the effect's, and its next change built them
    // all again — Mission Control and the rest lost mid-use.
    let builtFor: Gdk.Monitor | null = null
    let dispose: (() => void) | null = null
    const buildSingles = () => {
      const first = app.get_monitors()[0] ?? null
      if (first === builtFor) return
      dispose?.()
      dispose = null
      builtFor = first
      if (!first) return
      createRoot(end => {
        dispose = end
        return (
          <This this={app}>
            <NotificationCenter gdkmonitor={first} />
            <Desktop gdkmonitor={first} />
            <IndicatorBar gdkmonitor={first} />
            <IslandCard />
            <AppSwitcher gdkmonitor={first} />
            <MissionControl gdkmonitor={first} />
            <SnapAssist />
            <WorkspaceSwitcher gdkmonitor={first} />
            <Launcher gdkmonitor={first} />
            <Prompt gdkmonitor={first} />
          </This>
        )
      })
    }
    // each display's bar and dock first, as it always was
    const perDisplay = (
      <For each={monitors}>
        {(gdkmonitor) => (
          <This this={app}>
            <Bar gdkmonitor={gdkmonitor} toggleNc={toggleNc} />
            <Dock gdkmonitor={gdkmonitor} />
          </This>
        )}
      </For>
    )
    buildSingles()
    monitors.subscribe(buildSingles)
    return perDisplay
  },
})
