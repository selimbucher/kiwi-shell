import { exec } from "ags/process"
import { createPoll } from "ags/time"

function readGpuUsage(): number {
  try {
    return parseInt(exec("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits").trim()) / 100
  } catch {}
  try {
    return parseInt(exec("cat /sys/class/drm/card0/device/gpu_busy_percent").trim()) / 100
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