import { logger } from "../log"
const log = logger("mediakeys")
import AstalWp from "gi://AstalWp"
import { brightness, brightnessAvailable, brightnessWritable, kbdAvailable, setBrightnessLevel } from "./brightness"
import { applyBinds, currentBinds, registerBindSetup } from "../hypr"
import { globalShortcut } from "./services/globalShortcuts"

const DESCRIPTIONS: Record<string, string> = {
  'volume-up':           'Volume Up',
  'volume-down':         'Volume Down',
  'volume-mute':         'Mute / Unmute',
  'brightness-up':       'Brightness Up',
  'brightness-down':     'Brightness Down',
  'kbd-brightness-up':   'Keyboard Brightness Up',
  'kbd-brightness-down': 'Keyboard Brightness Down',
}

const SHORTCUT_MAP: Record<string, string> = {
  'volume-up':           'volume',
  'volume-down':         'volume',
  'volume-mute':         'volume',
  'brightness-up':       'brightness',
  'brightness-down':     'brightness',
  'kbd-brightness-up':   'keyboardBrightness',
  'kbd-brightness-down': 'keyboardBrightness',
}

// The volume and screen brightness keys change what they say where nothing
// else acts on them: most Hyprland configs bind them (wpctl, brightnessctl),
// and then kiwi only shows the change. Where none does, kiwi makes it, in a
// Mac's sixteen steps. Keyboard backlights are left to their firmware, which
// mostly steps them itself.
const ownKeys = new Set<string>()
const STEP = 1 / 16
const stepped = (value: number, by: number, lowest: number) =>
  Math.min(1, Math.max(lowest, Math.round((value + by) / STEP) * STEP))

function act(id: string) {
  if (!ownKeys.has(id)) return
  const speaker = AstalWp.get_default()?.audio?.defaultSpeaker
  switch (id) {
    case 'volume-up':
    case 'volume-down':
      if (!speaker) return
      speaker.mute = false
      speaker.volume = stepped(speaker.volume, id === 'volume-up' ? STEP : -STEP, 0)
      return
    case 'volume-mute':
      if (speaker) speaker.mute = !speaker.mute
      return
    case 'brightness-up':
    case 'brightness-down':
      // (not down to nothing: some panels switch off at 0)
      if (brightnessWritable) setBrightnessLevel(stepped(brightness.peek(), id === 'brightness-up' ? STEP : -STEP, STEP))
      return
  }
}

async function registerHyprlandBinds() {
  const KEY_TO_ID: Record<string, string> = {
    'XF86AudioRaiseVolume':   'volume-up',
    'XF86AudioLowerVolume':   'volume-down',
    'XF86AudioMute':          'volume-mute',
    'XF86MonBrightnessUp':    'brightness-up',
    'XF86MonBrightnessDown':  'brightness-down',
    'XF86KbdBrightnessUp':    'kbd-brightness-up',
    'XF86KbdBrightnessDown':  'kbd-brightness-down',
  }
  let keys = ['XF86AudioRaiseVolume', 'XF86AudioLowerVolume', 'XF86AudioMute']
  if (brightnessAvailable) keys.push('XF86MonBrightnessUp', 'XF86MonBrightnessDown')
  else log.debug('no backlight device — skipping XF86MonBrightness binds')
  if (kbdAvailable) keys.push('XF86KbdBrightnessUp', 'XF86KbdBrightnessDown')
  else log.debug('no keyboard backlight — skipping XF86KbdBrightness binds')

  // never unbind these keys (users bind their own actions on them); skip
  // keys that already carry our described bind instead
  try {
    const binds = await currentBinds()
    // the keys the config binds to something of its own
    ownKeys.clear()
    for (const key of keys) {
      const theirs = binds.some((b: any) => b.key === key && Number(b.modmask) === 0 &&
        !String(b.description ?? "").startsWith("kiwi:"))
      if (!theirs && !KEY_TO_ID[key].startsWith('kbd-')) ownKeys.add(KEY_TO_ID[key])
    }
    if (ownKeys.size > 0) log.info(`nothing else acts on ${[...ownKeys].join(', ')}: kiwi does`)
    const registered = new Set(binds.map((b: any) => b.description))
    const skipped = keys.filter(key => registered.has(`kiwi: ${KEY_TO_ID[key]}`))
    if (skipped.length > 0)
      log.debug(`already bound, skipping: ${skipped.join(', ')}`)
    keys = keys.filter(key => !registered.has(`kiwi: ${KEY_TO_ID[key]}`))
  } catch (e) {
    log.error('failed to query binds:', e)
  }
  if (keys.length === 0) {
    log.info('all indicator key binds already registered')
    return
  }

  if (await applyBinds(keys.map(key => ({
    bind: key,
    action: { global: `kiwi-shell:${KEY_TO_ID[key]}` },
    description: `kiwi: ${KEY_TO_ID[key]}`,
    // held, it goes on stepping (the mute key only once); and on the lock
    // screen too, as a Mac's keys do
    flags: { repeating: key !== 'XF86AudioMute', locked: true },
  })), 'indicator key binds'))
    log.info(`registered global binds: ${keys.join(', ')}`)
}

export function watchIndicatorKeys(onKey: (type: string) => void) {
  const ids = ['volume-up', 'volume-down', 'volume-mute']
  if (brightnessAvailable) ids.push('brightness-up', 'brightness-down')
  if (kbdAvailable) ids.push('kbd-brightness-up', 'kbd-brightness-down')
  for (const id of ids)
    globalShortcut(id, DESCRIPTIONS[id], 'press', () => {
      log.debug(`shortcut activated: ${id}`)
      act(id)
      onKey(SHORTCUT_MAP[id])
    })

  registerBindSetup('mediakeys', registerHyprlandBinds)
}
