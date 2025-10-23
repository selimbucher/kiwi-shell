import { Gdk } from "ags/gtk4"

function adjustColorByHSV(rgba: Gdk.RGBA){
    const hsv = rgbaToHSV(rgba)
    hsv.s = Math.max(hsv.s, 0.25)
    hsv.s = Math.min(hsv.s, 0.60)
    hsv.v = Math.max(hsv.v, 0.85)
    hsv.v = Math.min(hsv.v, 0.92)
    return hsvToRGBA(hsv)
}

interface HSV {
    h: number  // 0-360
    s: number  // 0-1
    v: number  // 0-1
}

function rgbaToHSV(rgba: any): HSV {
    const r = rgba.red
    const g = rgba.green
    const b = rgba.blue
    
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const diff = max - min
    
    let h = 0
    let s = max === 0 ? 0 : diff / max
    let v = max
    
    if (diff !== 0) {
        if (max === r) {
            h = 60 * (((g - b) / diff) % 6)
        } else if (max === g) {
            h = 60 * (((b - r) / diff) + 2)
        } else {
            h = 60 * (((r - g) / diff) + 4)
        }
    }
    
    if (h < 0) h += 360
    
    return { h, s, v }
}

function hsvToRGBA(hsv: HSV, alpha: number = 1.0): any {
    const { h, s, v } = hsv
    
    const c = v * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = v - c
    
    let r = 0, g = 0, b = 0
    
    if (h >= 0 && h < 60) {
        r = c; g = x; b = 0
    } else if (h >= 60 && h < 120) {
        r = x; g = c; b = 0
    } else if (h >= 120 && h < 180) {
        r = 0; g = c; b = x
    } else if (h >= 180 && h < 240) {
        r = 0; g = x; b = c
    } else if (h >= 240 && h < 300) {
        r = x; g = 0; b = c
    } else {
        r = c; g = 0; b = x
    }
    
    const rgba = new Gdk.RGBA()
    rgba.red = r + m
    rgba.green = g + m
    rgba.blue = b + m
    rgba.alpha = alpha
    
    return rgba
}

interface HSL {
    h: number  // 0-360
    s: number  // 0-1
    l: number  // 0-1
}

function rgbaToHSL(rgba: any): HSL {
    const r = rgba.red
    const g = rgba.green
    const b = rgba.blue
    
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const diff = max - min
    
    let h = 0
    let s = 0
    let l = (max + min) / 2
    
    if (diff !== 0) {
        s = l > 0.5 ? diff / (2 - max - min) : diff / (max + min)
        
        if (max === r) {
            h = 60 * (((g - b) / diff) % 6)
        } else if (max === g) {
            h = 60 * (((b - r) / diff) + 2)
        } else {
            h = 60 * (((r - g) / diff) + 4)
        }
    }
    
    if (h < 0) h += 360
    
    return { h, s, l }
}

function hslToRGBA(hsl: HSL, alpha: number = 1.0): any {
    const { h, s, l } = hsl
    
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    
    let r = 0, g = 0, b = 0
    
    if (h >= 0 && h < 60) {
        r = c; g = x; b = 0
    } else if (h >= 60 && h < 120) {
        r = x; g = c; b = 0
    } else if (h >= 120 && h < 180) {
        r = 0; g = c; b = x
    } else if (h >= 180 && h < 240) {
        r = 0; g = x; b = c
    } else if (h >= 240 && h < 300) {
        r = x; g = 0; b = c
    } else {
        r = c; g = 0; b = x
    }
    
    const rgba = new Gdk.RGBA()
    rgba.red = r + m
    rgba.green = g + m
    rgba.blue = b + m
    rgba.alpha = alpha
    
    return rgba
}