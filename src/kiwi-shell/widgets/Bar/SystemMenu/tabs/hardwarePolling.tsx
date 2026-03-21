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
export const cpuTemp = createPoll(0, 2000, ["bash", "-c",
  "grep -l x86_pkg_temp /sys/class/thermal/thermal_zone*/type 2>/dev/null | sed 's/type/temp/' | head -1 | xargs cat"
], (out) => {
  const raw = parseInt(out.trim())
  return isNaN(raw) ? 0 : raw / 1000
})