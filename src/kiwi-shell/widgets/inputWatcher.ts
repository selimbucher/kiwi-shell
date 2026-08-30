import { logger } from "../log"
const log = logger("mediakeys")
import KiwiShortcuts from "gi://KiwiShortcuts"
import { brightnessAvailable, kbdAvailable } from "./brightness"
import { execAsync } from "ags/process"
import Hyprland from "gi://AstalHyprland"
import { evalLua, luaBind, luaStr } from "../hypr"

const SHORTCUT_MAP: Record<string, string> = {
  'volume-up':           'volume',
  'volume-down':         'volume',
  'volume-mute':         'volume',
  'brightness-up':       'brightness',
  'brightness-down':     'brightness',
  'kbd-brightness-up':   'keyboardBrightness',
  'kbd-brightness-down': 'keyboardBrightness',
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
    const binds = JSON.parse(await execAsync(['hyprctl', 'binds', '-j']))
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

  if (await evalLua(keys.map(key => luaBind(
    key,
    `hl.dsp.global(${luaStr(`kiwi-shell:${KEY_TO_ID[key]}`)})`,
    `kiwi: ${KEY_TO_ID[key]}`,
  )).join('\n'), 'indicator key binds'))
    log.info(`registered global binds: ${keys.join(', ')}`)
}

let manager: KiwiShortcuts.Manager | null = null

export function watchIndicatorKeys(onKey: (type: string) => void) {
  registerHyprlandBinds()

  const hyprland = Hyprland.get_default()
  hyprland.connect('config-reloaded', () => {
    log.debug('config reloaded — re-registering indicator key binds')
    registerHyprlandBinds()
  })

  manager = new KiwiShortcuts.Manager()

  manager.register('volume-up',   'Volume Up')
  manager.register('volume-down', 'Volume Down')
  manager.register('volume-mute', 'Mute / Unmute')

  if (brightnessAvailable) {
    manager.register('brightness-up',   'Brightness Up')
    manager.register('brightness-down', 'Brightness Down')
  }

  if (kbdAvailable) {
    manager.register('kbd-brightness-up',   'Keyboard Brightness Up')
    manager.register('kbd-brightness-down', 'Keyboard Brightness Down')
  }

  manager.connect('activated', (_: unknown, id: string) => {
    const type = SHORTCUT_MAP[id]
    log.debug(`shortcut activated: ${id}`)
    if (type) onKey(type)
    else log.warn(`activated shortcut has no mapping: ${id}`)
  })
}