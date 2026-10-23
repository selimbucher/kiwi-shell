import { Gtk } from "ags/gtk4"
import { createComputed, With } from "ags"

export function CircularProgress({ 
  progress = 0.5, 
  lineWidth = 8, 
  size = 64, 
  color = "#4DB3FF"
}) {
  const parseColor = (input: string) => {
    if (!input) return null
    let s = input.trim()

    if (s.startsWith("#")) {
      let h = s.slice(1)
      if (h.length === 3 || h.length === 4) {
        h = h.split("").map(ch => ch + ch).join("")
      }
      if (h.length !== 6 && h.length !== 8) return null
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      return { r: r / 255, g: g / 255, b: b / 255, a }
    }

    const m = s.match(/^rgba?\(\s*([+-]?\d*\.?\d+%?)\s*,\s*([+-]?\d*\.?\d+%?)\s*,\s*([+-]?\d*\.?\d+%?)(?:\s*,\s*([+-]?\d*\.?\d+%?)\s*)?\)$/i)
    if (m) {
      const to255 = (v: string) => {
        const isPct = v.endsWith("%")
        const n = parseFloat(v)
        if (Number.isNaN(n)) return 0
        return isPct ? Math.max(0, Math.min(255, (n / 100) * 255)) : Math.max(0, Math.min(255, n))
      }
      const toAlpha = (v?: string) => {
        if (!v) return 1
        const isPct = v.endsWith("%")
        const n = parseFloat(v)
        if (Number.isNaN(n)) return 1
        return Math.max(0, Math.min(1, isPct ? n / 100 : n))
      }

      const r = to255(m[1])
      const g = to255(m[2])
      const b = to255(m[3])
      const a = toAlpha(m[4])
      return { r: r / 255, g: g / 255, b: b / 255, a }
    }

    return null
  }

  const stateAcc = createComputed((get) => {
    const raw = typeof progress === "number" ? progress : get(progress)
    const v = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw))
    const c = typeof color === "string" ? color : get(color)
    return { v, c }
  })

  return (
    <overlay>
      <With value={stateAcc}>
        {({ v, c }) => {
          const drawingArea = new Gtk.DrawingArea({
            widthRequest: size,
            heightRequest: size,
          })

          drawingArea.set_draw_func((widget, cr, width, height) => {
            const radius = Math.min(width, height) / 2 - 10
            const centerX = width / 2
            const centerY = height / 2

            cr.setSourceRGBA(0.3, 0.3, 0.3, 0.3)
            cr.setLineWidth(lineWidth)
            cr.arc(centerX, centerY, radius, 0, 2 * Math.PI)
            cr.stroke()

            const parsed = parseColor(c) ?? parseColor("#4DB3FF")!
            cr.setSourceRGBA(parsed.r, parsed.g, parsed.b, parsed.a)
            cr.setLineWidth(lineWidth)
            cr.setLineCap(1)

            const startAngle = -Math.PI / 2
            const endAngle = startAngle + (2 * Math.PI * v)

            cr.arc(centerX, centerY, radius, startAngle, endAngle)
            cr.stroke()
          })

          return drawingArea
        }}
      </With>
    </overlay>
  )
}