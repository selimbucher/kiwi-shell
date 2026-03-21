import { exec } from "ags/process"
import { createPoll } from "ags/time"

function readGpuUsage(): number {
  try {
    // NVIDIA
    return parseInt(exec("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits").trim()) / 100
  } catch {}
  try {
    // AMD: glob across all cards, take first match (AMD vendor 0x1002)
    const out = exec(["bash", "-c",
      "for f in /sys/class/drm/card*/device/gpu_busy_percent; do " +
      "  vendor=$(cat ${f%gpu_busy_percent}vendor 2>/dev/null); " +
      "  [ \"$vendor\" = '0x1002' ] && cat $f && break; " +
      "done"
    ]).trim()
    if (out) return parseInt(out) / 100
  } catch {}
  return 0
}

export const gpuUsage = createPoll(0, 1000, readGpuUsage)

export const ramUsage = createPoll(0, 2000, "cat /proc/meminfo", (out) => {
  const get = (key: string) => {
    const line = out.split("\n").find(l => l.startsWith(key))!
    return parseInt(line.split(/\s+/)[1])
  }
  const total = get("MemTotal:")
  const available = get("MemAvailable:")
  return (total - available) / total
})

// Returns degrees Celsius as a plain number e.g. 54, 72
export const cpuTemp = createPoll(0, 2000, ["bash", "-c", `
  # 1. AMD: k10temp hwmon (Tdie preferred, fallback to Tctl)
  for d in /sys/class/hwmon/hwmon*/; do
    [ "\$(cat \${d}name 2>/dev/null)" = "k10temp" ] || continue
    t=\$(cat \${d}temp2_input 2>/dev/null || cat \${d}temp1_input 2>/dev/null)
    [ -n "\$t" ] && echo "\$t" && exit
  done
  # 2. Intel: coretemp hwmon (Package id 0 = temp1)
  for d in /sys/class/hwmon/hwmon*/; do
    [ "\$(cat \${d}name 2>/dev/null)" = "coretemp" ] || continue
    t=\$(cat \${d}temp1_input 2>/dev/null)
    [ -n "\$t" ] && echo "\$t" && exit
  done
  # 3. Intel: x86_pkg_temp thermal zone
  f=\$(grep -rl x86_pkg_temp /sys/class/thermal/thermal_zone*/type 2>/dev/null \
    | sed 's/type/temp/' | head -1)
  [ -n "\$f" ] && cat "\$f" && exit
  # 4. Generic fallback: any thermal zone named *cpu* or *pkg*
  for z in /sys/class/thermal/thermal_zone*/; do
    name=\$(cat \${z}type 2>/dev/null | tr '[:upper:]' '[:lower:]')
    case "\$name" in *cpu*|*pkg*|*core*)
      cat \${z}temp 2>/dev/null && exit
    esac
  done
`], (out) => {
  const raw = parseInt(out.trim())
  return isNaN(raw) ? 0 : raw / 1000
})

function readCpuTicks(): [number, number] {
  const line = exec("bash -c \"grep -m1 'cpu ' /proc/stat\"")
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const idle = parts[3] + parts[4]
  const total = parts.reduce((a, b) => a + b, 0)
  return [idle, total]
}

let [prevIdle, prevTotal] = readCpuTicks()

export const cpuUsage = createPoll(0, 1000, () => {
  const [idle, total] = readCpuTicks()
  const diffIdle = idle - prevIdle
  const diffTotal = total - prevTotal
  ;[prevIdle, prevTotal] = [idle, total]
  return diffTotal === 0 ? 0 : 1 - diffIdle / diffTotal
})