export function powerProfileIcon(profile: string) {
    if (profile == "performance") {
    return "gamepad-symbolic"
  }
  if (profile == "balanced") {
    return "software-license-symbolic"
  }
  if (profile == "power-saver") {
    return "power-saving-symbolic"
  }
  return "power-profile-balanced-rtl-symbolic"
}

export function volumeIcon(percentage: number, is_muted: boolean) {
  if (is_muted) {
    return "audio-volume-muted-symbolic"
  }
  if (percentage >= 0.68) {
    return "audio-volume-high-symbolic"
  } else if ( percentage >= 0.33) {
    return "audio-volume-medium-symbolic"
  }
  else if ( percentage > 0) {
    return "audio-volume-low-symbolic"
  } else {
return "audio-volume-muted-symbolic"
  }
}

export function brightnessIcon(value: number, max: number) {
  const percentage = value / max
  if (percentage >= 2/3) {
    return "display-brightness-high-symbolic"
  } else if ( percentage >= 1/3) {
    return "display-brightness-medium-symbolic"
  }
  else if ( percentage > 0) {
    return "display-brightness-low-symbolic"
  } else {
return "display-brightness-off-symbolic"
  }
}

export function keyboardBrightnessIcon(percentage: number) {
  if (percentage >= 1) {
    return 'keyboard-brightness-high-symbolic'
  } else if (percentage >= 0.66) {
    return 'keyboard-brightness-symbolic'
  } else if (percentage >= 0.33) {
    return 'keyboard-brightness-medium-symbolic'
  }
  return 'keyboard-brightness-off-symbolic'
}