import { createState } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import { listDir, readText, readNumber, driverName } from "../../../sysfs"

// Hardware gauges for the performance tab. Two rules keep this cheap:
//  - pollers are OFF by default and only run while the performance tab is
//    open (SystemMenu calls setHardwarePolling) — the shell must not burn
//    cycles on gauges nobody is looking at
//  - sources are detected ONCE, the first time the tab opens, and then read
//    straight from /proc and /sys with no process spawns (nvidia-smi being
//    the only exception, as sysfs has no NVIDIA utilization)
//
// What there is to read differs from machine to machine, so a gauge whose
// source isn't there is left out of the tab rather than showing a made-up 0.
// A read that fails later on (a device gone, a file refusing) keeps the last
// value instead of showing NaN.

type Poller = { intervalMs: number; tick: () => void; id: number | null }
const pollers: Poller[] = []

// read returns null for "nothing new", and may answer later for a source
// that has to be asked through a process
function poll(intervalMs: number, read: () => number | null | Promise<number | null>) {
    const [state, setState] = createState(0)
    const set = (v: number | null) => {
        if (v !== null && Number.isFinite(v)) setState(v)
    }
    pollers.push({
        intervalMs,
        tick: () => {
            try {
                const v = read()
                if (v instanceof Promise) v.then(set, () => {})
                else set(v)
            } catch {}
        },
        id: null,
    })
    return state
}

export function setHardwarePolling(active: boolean) {
    if (active) detect()
    for (const p of pollers) {
        if (active && p.id === null) {
            p.tick() // fresh values the moment the tab opens
            p.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, p.intervalMs, () => {
                p.tick()
                return GLib.SOURCE_CONTINUE
            })
        } else if (!active && p.id !== null) {
            GLib.source_remove(p.id)
            p.id = null
        }
    }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

// ─── GPU ──────────────────────────────────────────────────────────────────────

// One reader per GPU, each answering a load from 0 to 1. The gauge shows the
// busiest, so a laptop with an integrated and a discrete GPU shows whichever
// one is doing the work.
type GpuReader = () => number | null | Promise<number | null>

// A discrete GPU that has powered down is idle, and asking it for its load
// (gpu_busy_percent, nvidia-smi) can wake it up again, on every tick.
const asleep = (device: string) =>
    readText(`${device}/power/runtime_status`) === "suspended"

// Intel has no busy counter in sysfs, but it does count the time the GPU
// spends in RC6, its idle power state. The share of time out of it is how
// long the GPU was awake, which follows its load closely enough for a gauge.
function residencyReader(file: string, device: string): GpuReader {
    let last: number | null = null
    let lastAt = 0
    return () => {
        // asleep, the counter stands still and would read as busy afterwards,
        // so the next sample after waking starts over
        if (asleep(device)) {
            last = null
            return 0
        }
        const now = GLib.get_monotonic_time()
        const idleMs = readNumber(file)
        const prev = last
        const elapsedMs = (now - lastAt) / 1000
        // too short a span to say anything (the tick right after detection)
        if (prev !== null && idleMs !== null && elapsedMs < 100) return null
        last = idleMs
        lastAt = now
        if (prev === null || idleMs === null || idleMs < prev) return null
        return clamp01(1 - (idleMs - prev) / elapsedMs)
    }
}

function gpuReaderFor(card: string): GpuReader | null {
    const cardDir = `/sys/class/drm/${card}`
    const device = `${cardDir}/device`
    const driver = driverName(device)

    // AMD: gpu_busy_percent straight from sysfs
    if (driver === "amdgpu" && readNumber(`${device}/gpu_busy_percent`) !== null) {
        return () => {
            if (asleep(device)) return 0
            const busy = readNumber(`${device}/gpu_busy_percent`)
            return busy === null ? null : clamp01(busy / 100)
        }
    }

    // Intel: i915 has the RC6 residency per GT, older kernels only for the
    // whole card; xe calls it gt idle residency
    if (driver === "i915") {
        for (const file of [`${cardDir}/gt/gt0/rc6_residency_ms`, `${cardDir}/power/rc6_residency_ms`])
            if (readNumber(file) !== null) return residencyReader(file, device)
    }
    if (driver === "xe") {
        for (const tile of listDir(device).filter(n => /^tile\d+$/.test(n)).sort()) {
            const file = `${device}/${tile}/gt0/gtidle/idle_residency_ms`
            if (readNumber(file) !== null) return residencyReader(file, device)
        }
    }

    // nouveau, simpledrm, virtio and the like have no load to read
    return null
}

// NVIDIA's own driver keeps utilization out of sysfs; nvidia-smi reports it
// for all its GPUs at once. It is asked only while no answer is pending (the
// last one stands in meanwhile), so a slow nvidia-smi can't pile up
// processes, and not at all while every NVIDIA GPU is powered down.
function nvidiaReader(devices: string[]): GpuReader | null {
    if (devices.length === 0 || !GLib.find_program_in_path("nvidia-smi")) return null
    let pending = false
    let lastLoad: number | null = null
    return () => {
        if (devices.every(asleep)) return 0
        if (pending) return lastLoad
        pending = true
        return execAsync(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])
            .then(out => {
                const loads = out.split("\n").map(l => parseInt(l)).filter(Number.isFinite)
                lastLoad = loads.length > 0 ? clamp01(Math.max(...loads) / 100) : null
                return lastLoad
            })
            .finally(() => { pending = false })
    }
}

function detectGpuReaders(): GpuReader[] {
    const readers: GpuReader[] = []
    const nvidia: string[] = []
    // only the cards themselves: cardN-eDP-1 and the like are their connectors,
    // and the first GPU need not be card0
    for (const card of listDir("/sys/class/drm").filter(n => /^card\d+$/.test(n)).sort()) {
        const device = `/sys/class/drm/${card}/device`
        if (driverName(device) === "nvidia") {
            nvidia.push(device)
            continue
        }
        const reader = gpuReaderFor(card)
        if (reader) readers.push(reader)
    }
    const nv = nvidiaReader(nvidia)
    if (nv) readers.push(nv)
    return readers
}

let gpuReaders: GpuReader[] = []

export const gpuUsage = poll(1000, () => {
    const loads = gpuReaders.map(read => {
        try {
            return read()
        } catch {
            return null
        }
    })
    // the busiest of them, once the ones that have to be asked have answered
    const busiest = (values: (number | null)[]) => {
        const known = values.filter((v): v is number => v !== null)
        return known.length > 0 ? Math.max(...known) : null
    }
    return loads.some(v => v instanceof Promise)
        ? Promise.all(loads.map(v => Promise.resolve(v).catch(() => null))).then(busiest)
        : busiest(loads as (number | null)[])
})

// ─── RAM ──────────────────────────────────────────────────────────────────────

export const ramUsage = poll(2000, () => {
    const out = readText("/proc/meminfo")
    if (out === null) return null
    const get = (key: string) => {
        const line = out.split("\n").find((l) => l.startsWith(key))
        return line ? parseInt(line.split(/\s+/)[1]) : NaN
    }
    const total = get("MemTotal:")
    const available = get("MemAvailable:")
    return total > 0 ? clamp01((total - available) / total) : null
})

// ─── CPU temperature ──────────────────────────────────────────────────────────

// The hwmon drivers that know the CPU's own temperature, and which of their
// sensors to prefer, by label: the die over the control value AMD's fans go
// by, the package over any one core. hwmonN numbers change from boot to boot,
// so they are found by name.
const CPU_HWMON: Record<string, RegExp[]> = {
    k10temp: [/^Tdie$/, /^Tctl$/],
    zenpower: [/^Tdie$/, /^Tctl$/],
    coretemp: [/^Package id/],
    cpu_thermal: [],
}

// Failing those, a thermal zone: the x86 package sensor, then anything that
// names the CPU or SoC (cpu-thermal on ARM boards, TCPU on Intel laptops),
// and last the ACPI zone, which on some machines is the only one there is.
const ZONE_RANK = [/^x86_pkg_temp$/, /cpu|soc|pkg|core/i, /^acpitz$/]

function detectCpuTempFile(): string | null {
    for (const h of listDir("/sys/class/hwmon").sort()) {
        const base = `/sys/class/hwmon/${h}`
        const prefer = CPU_HWMON[readText(`${base}/name`) ?? ""]
        if (!prefer) continue
        const inputs = listDir(base)
            .filter(n => /^temp\d+_input$/.test(n))
            .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))
            .filter(n => readNumber(`${base}/${n}`) !== null)
        const label = (input: string) =>
            readText(`${base}/${input.replace("_input", "_label")}`) ?? ""
        for (const re of prefer) {
            const match = inputs.find(n => re.test(label(n)))
            if (match) return `${base}/${match}`
        }
        if (inputs.length > 0) return `${base}/${inputs[0]}`
    }

    const zones = listDir("/sys/class/thermal")
        .filter(z => z.startsWith("thermal_zone"))
        .sort((a, b) => parseInt(a.slice(12)) - parseInt(b.slice(12)))
        .map(z => ({ file: `/sys/class/thermal/${z}/temp`, type: readText(`/sys/class/thermal/${z}/type`) ?? "" }))
        .filter(z => readNumber(z.file) !== null)
    for (const re of ZONE_RANK) {
        const match = zones.find(z => re.test(z.type))
        if (match) return match.file
    }
    return null
}

let cpuTempFile: string | null = null

// degrees Celsius as a plain number, e.g. 54, 72
export const cpuTemp = poll(2000, () => {
    const milli = cpuTempFile ? readNumber(cpuTempFile) : null
    return milli === null ? null : milli / 1000
})

// ─── CPU usage ────────────────────────────────────────────────────────────────

// the first line of /proc/stat adds up every core, however many there are
function readCpuTicks(): [number, number] | null {
    const line = readText("/proc/stat")?.split("\n")[0]
    if (!line?.startsWith("cpu ")) return null
    const parts = line.split(/\s+/).slice(1).map(Number)
    const idle = parts[3] + (parts[4] || 0) // idle + iowait
    const total = parts.reduce((a, b) => a + (b || 0), 0)
    return Number.isFinite(idle) ? [idle, total] : null
}

let prevTicks: [number, number] | null = null

export const cpuUsage = poll(1000, () => {
    const ticks = readCpuTicks()
    const prev = prevTicks
    prevTicks = ticks
    if (!ticks || !prev) return null
    const diffIdle = ticks[0] - prev[0]
    const diffTotal = ticks[1] - prev[1]
    return diffTotal <= 0 ? null : clamp01(1 - diffIdle / diffTotal)
})

// ─── What this machine has ────────────────────────────────────────────────────

// Found the first time the tab opens, so a machine that never shows it never
// looks, and kept from then on. CPU and RAM come from /proc and are always
// there; GPU and temperature only where a source was found.
const [available, setAvailable] = createState({ gpu: false, cpuTemp: false })
export { available as hardwareAvailable }

let detected = false

function detect() {
    if (detected) return
    detected = true
    gpuReaders = detectGpuReaders()
    cpuTempFile = detectCpuTempFile()
    prevTicks = readCpuTicks()
    setAvailable({ gpu: gpuReaders.length > 0, cpuTemp: cpuTempFile !== null })
}
