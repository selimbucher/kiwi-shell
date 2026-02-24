import { Gtk } from "ags/gtk4"
import { createBinding, createComputed, With } from "ags"
import Mpris from "gi://AstalMpris"

// Access the first available player
// const player = mpris.get_players()[0]

export function MediaPlayer() {
  const mpris = Mpris.get_default()
  
  return (
    <box>
      <With value={createBinding(mpris, "players")}>
        {(players) => {
          const list = Array.isArray(players) ? players : []
          
          // 1. Pick the best player: Prioritize 'PLAYING', fallback to the first available.
          const player = list.find(p => p.playback_status === Mpris.PlaybackStatus.PLAYING) || list[0]
          
          if (!player) return;
          
          // make fields reactive and ensure strings
          const title = createBinding(player, "title").as(v => String(v ?? ""))
          const artist = createBinding(player, "artist").as(v => String(v ?? ""))
          const album = createBinding(player, "album").as(v => String(v ?? ""))
          const status = createBinding(player, "playback_status")
          const cover = createBinding(player, "cover_art").as(v => String(v ?? ""))
          const position = createBinding(player, "position")
          const length = createBinding(player, "length")
          const remaining = createComputed((get) =>
            get(length) - get(position)
          )

          return (
            // 2. REACTIVE FIX: Hide the whole box if the title is empty.
            <box 
              class="media-player" 
              hexpand={true} 
              visible={title.as(t => t.trim().length > 0)}
            >
              <box class="cover-art" overflow={Gtk.Overflow.HIDDEN}>
                <With value={cover}>
                  {(cover) => {
                    const coverSize = 96

                    return cover ? (
                      <image
                        file={cover}
                        pixelSize={coverSize}
                      />
                    ) : (
                      <box class="generic-container">
                      <image
                        iconName="audio-x-generic-symbolic"
                        pixelSize={coverSize-32}
                      />
                      </box>
                    )
                  }}
                </With>
              </box>
              <box class="playback-info" orientation={Gtk.Orientation.VERTICAL} >
                <scrolledwindow hscrollbarPolicy={Gtk.PolicyType.EXTERNAL} vscrollbarPolicy={Gtk.PolicyType.NEVER}>
                  <label class="title" label={title} halign={Gtk.Align.START}/>
                </scrolledwindow>
                <scrolledwindow hscrollbarPolicy={Gtk.PolicyType.EXTERNAL} vscrollbarPolicy={Gtk.PolicyType.NEVER}>
                  <label class="artist" label={artist} halign={Gtk.Align.START}/>
                </scrolledwindow>
                <box vexpand={true}/>
                <box class="media-control" orientation={Gtk.Orientation.VERTICAL}>
                  <slider
                    hexpand={true}
                    min={0}
                    max={length}
                    value={position}
                    onChangeValue = {(self) => {
                      player.set_position(self.value)
                    }}
                    />
                  <centerbox class="bottom-bar">
                    <label $type="start" label={position.as(v => formatTime(v))} />
                    <box $type="center" class="control-bar" hexpand={true} halign={Gtk.Align.CENTER}>
                      <button onClicked={() => player.previous()}>
                        <Gtk.Image
                            pixelSize={16}
                            iconName="media-skip-backward-symbolic"
                          /> 
                      </button>
                      <button onClicked={() => player.play_pause()}>
                        <Gtk.Image
                            pixelSize={16}
                            iconName={status.as(b => 
                              b === Mpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic"
                              : "media-playback-start-symbolic"
                            )}
                          /> 
                      </button>
                      <button onClicked={() => player.next()}>
                        <Gtk.Image
                            pixelSize={16}
                            iconName="media-skip-forward-symbolic"
                          /> 
                      </button>
                    </box>
                    <label $type="end" label={remaining.as(v => '-'+formatTime(v))} />
                  </centerbox>
                  
                </box>
              </box>
            </box>
          )
        }}
      </With>
    </box>
  )
}

function formatTime(seconds: number) {
  if (seconds <= 0 || seconds > 1000000000) return "0:00"
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function CircularProgress({ 
  progress = 0.5, 
  lineWidth = 8, 
  size = 64, 
  color = "#4DB3FF"
}) {
  // Helper: parse hex, rgb(), rgba() into RGBA [0..1]
  const parseColor = (input: string) => {
    if (!input) return null
    let s = input.trim()

    // Hex: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
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

    // rgb(a): rgb(255, 0, 0) or rgba(255,0,0,0.5) with optional spaces/percents
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

  // Replace progressAcc + colorAcc with a single combined accessor
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

            // Background circle
            cr.setSourceRGBA(0.2, 0.2, 0.2, 0.3)
            cr.setLineWidth(lineWidth)
            cr.arc(centerX, centerY, radius, 0, 2 * Math.PI)
            cr.stroke()

            // Progress arc with rounded caps and parsed color
            const parsed = parseColor(c) ?? parseColor("#4DB3FF")!
            cr.setSourceRGBA(parsed.r, parsed.g, parsed.b, parsed.a)
            cr.setLineWidth(lineWidth)
            cr.setLineCap(1) // Cairo.LineCap.ROUND

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