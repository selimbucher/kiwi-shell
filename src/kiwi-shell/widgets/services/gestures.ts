import { logger } from "../../log"
import { dialect, evalLua, keyword, luaStr, registerBindSetup, pluginsReady } from "../../hypr"
import { globalShortcut } from "./globalShortcuts"
import { livePreviews, flyOnGesture } from "./previews"
import { openMissionControl, closeMissionControl, isOpen } from "../MissionControl/MissionControl"
import { openNc, closeNc } from "../Notifications/NotificationCenter"

const log = logger("gestures")

// ─── Trackpad gestures ────────────────────────────────────────────────────────
// macOS's, as far as Linux lets them be:
//
//   three fingers sideways   the desktop next to this one, the screen
//                            following the fingers (Hyprland's own swipe,
//                            through kiwi's desktops only, never making one)
//   three fingers up         Mission Control, the windows following the
//                            fingers out of their places (kiwi's plugin,
//                            previews.cpp; without it, once the fingers have
//                            gone far enough)
//   three fingers down       out of it again, the same way
//   four fingers left        Notification Center, in from the right
//   four fingers right       away again
//
// macOS opens Notification Center with two fingers from the trackpad's right
// edge; libinput reports two fingers as scrolling, with no position, so that
// one has no equivalent here (docs/macos-differences.md).
//
// Like the shell's binds they are added to the compositor at runtime and again
// after every config reload, which clears them. A gesture the user's config
// already has on the same fingers and direction is left to the config.
//
// The setups run more than once per reload (a burst of them, the plugin's own
// load), and Hyprland can't be asked which gestures it has, so each gesture
// leaves a mark in the compositor's Lua state once added — a state every
// reload starts afresh, just as it starts the gestures afresh.

// the compositor's name for Mission Control's windows (MissionControl.tsx)
const MISSION_CONTROL_SET = "mission-control"

// how far the fingers go before Mission Control or the notifications come,
// where they can't follow the fingers
const TRAVEL = 60

const MC_OPEN = globalShortcut("gesture-mission-control-open", "Gesture: open Mission Control", "press",
    () => { if (!isOpen.get()) openMissionControl() })
const MC_CLOSE = globalShortcut("gesture-mission-control-close", "Gesture: close Mission Control", "press",
    () => closeMissionControl())
const NC_OPEN = globalShortcut("gesture-notifications-open", "Gesture: open Notification Center", "press", openNc)
const NC_CLOSE = globalShortcut("gesture-notifications-close", "Gesture: close Notification Center", "press", closeNc)

type Trigger = { fingers: number; direction: "up" | "down" | "left" | "right"; action: { global: string } }

const TRIGGERS: Trigger[] = [
    { fingers: 3, direction: "up", action: MC_OPEN },
    { fingers: 3, direction: "down", action: MC_CLOSE },
    { fingers: 4, direction: "left", action: NC_OPEN },
    { fingers: 4, direction: "right", action: NC_CLOSE },
]

// the swipe through the desktops: one per swipe, none made, eager like a Mac's
const SWIPE = {
    workspace_swipe_create_new: false,
    workspace_swipe_forever: false,
    workspace_swipe_use_r: false,
    workspace_swipe_distance: 400,
    // a short quick swipe is enough, as on a Mac
    workspace_swipe_min_speed_to_force: 12,
    workspace_swipe_cancel_ratio: 0.2,
}

// Fires once the fingers have gone TRAVEL that way, while they still move:
// Hyprland hands a gesture over at the first few units, and a hand resting on
// the trackpad would set it off.
function triggerLua(t: Trigger): string {
    const axis = t.direction === "up" || t.direction === "down" ? "y" : "x"
    const sign = t.direction === "up" || t.direction === "left" ? -1 : 1
    return once(`${t.fingers} ${t.direction}`, `local travel, fired = 0, false
  hl.gesture({ fingers = ${t.fingers}, direction = ${luaStr(t.direction)}, action = {
    start = function() travel, fired = 0, false end,
    update = function(e)
      travel = travel + ((e.delta and e.delta.${axis}) or 0) * ${sign}
      if not fired and travel > ${TRAVEL} then
        fired = true
        hl.dispatch(hl.dsp.global(${luaStr(t.action.global)}))
      end
    end,
  } })`)
}

// `body` unless it has run since the last reload; a failing hl.gesture stops
// the chunk before the mark, so it is tried again (and reported) next time
function once(mark: string, body: string): string {
    return `kiwi_gestures = kiwi_gestures or {}
if not kiwi_gestures[${luaStr(mark)}] then
  ${body}
  kiwi_gestures[${luaStr(mark)}] = true
end`
}

async function registerGestures() {
    // whether the plugin is there to take Mission Control's
    await pluginsReady
    const lua = await dialect() === "lua"
    const added: string[] = []
    const skipped: string[] = []

    const settings = lua
        ? await evalLua(`hl.config({ gestures = { ${Object.entries(SWIPE).map(([k, v]) => `${k} = ${v}`).join(", ")} } })`, "swipe settings")
        : (await Promise.all(Object.entries(SWIPE).map(([k, v]) => keyword(`gestures:${k} ${v}`, `swipe ${k}`)))).every(Boolean)
    if (!settings) log.warn("could not set the workspace swipe up the way kiwi's desktops need")

    const swipe = lua
        ? await evalLua(once("3 horizontal", `hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })`), "desktop swipe")
        : await keyword("gesture 3, horizontal, workspace", "desktop swipe")
    ;(swipe ? added : skipped).push("3 fingers sideways")

    // Mission Control follows the fingers when the plugin draws it
    let following = false
    if (livePreviews()) {
        const reply = await flyOnGesture(MISSION_CONTROL_SET, 3)
        following = reply === "ok"
        if (following) added.push("3 fingers up and down, following")
        else log.warn(`Mission Control's gesture: ${reply}`)
    }

    for (const t of TRIGGERS) {
        if (following && t.fingers === 3) continue
        const ok = lua
            ? await evalLua(triggerLua(t), `gesture ${t.fingers} ${t.direction}`)
            : await keyword(`gesture ${t.fingers}, ${t.direction}, dispatcher, global, ${t.action.global}`, `gesture ${t.fingers} ${t.direction}`)
        ;(ok ? added : skipped).push(`${t.fingers} fingers ${t.direction}`)
    }

    if (added.length) log.info(`trackpad gestures: ${added.join(", ")}`)
    // the reason is in the line above: the config has its own there
    if (skipped.length) log.warn(`trackpad gestures left to the config: ${skipped.join(", ")}`)
}

registerBindSetup("gestures", registerGestures)
