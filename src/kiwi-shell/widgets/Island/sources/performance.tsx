import { Gtk } from "ags/gtk4"
import { createComputed, createState, With, type Accessor } from "ags"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GLibUnix from "gi://GLibUnix"
import GioUnix from "gi://GioUnix"
import Pango from "gi://Pango"

import { logger } from "../../../log"
import { conf } from "../../config"
import { readText, readNumber, listDir } from "../../sysfs"
import { giconForEntry, entryFromCmdline } from "../../appIcon"
import { detectCpuTempFile } from "../../Bar/SystemMenu/tabs/hardwarePolling"
import { addActivitySource, opened, PRIORITY, type Activity } from "../model"

const log = logger("island")

// ─── Performance ──────────────────────────────────────────────────────────────
// Three activities, for when the machine is working unusually hard: memory
// running out, the CPU running hot, the CPU busy for minutes on end (all of
// it, or one app holding a core). macOS has nothing in its place; Activity
// Monitor and "Apps Using Significant Energy" in the battery menu are where
// a Mac shows this, and only when asked.
//
// None of it needs to be on time to the second, and the laptop runs on
// battery, so the shell looks only every 30 s (one read of /proc/stat,
// /proc/meminfo and the CPU's sensor) and calls something unusual only after
// two looks in a row. Memory running out is the exception: it freezes a
// machine within seconds, and the kernel says so on its own — pressure stall
// information (PSI), a trigger that fires once the tasks spend a share of
// their time waiting for memory. Nothing runs between the looks and the
// kernel's calls.

const CHECK_SECONDS = 30
// the CPU counts as busy at this share of all its cores…
const BUSY = 0.8
// …and an app as holding a core at this share of one, two looks in a row
const HOLDING = 0.95
// Memory is short below 5% available, or below 20% while apps wait for it,
// and fine again above 10% with none waiting. Waiting alone isn't memory
// running out: reading back what was swapped out or dropped from the cache
// waits too, with half the memory free.
const SHORT = 0.05
const SHORT_WAITING = 0.2
const ENOUGH = 0.1
// Waiting: at least 200 ms of every 2 s spent waiting for memory, for 6 s
// straight (PSI lets anyone but root ask only for whole 2 s windows, and
// calls at most once in each), and over once 10 s pass without a call.
const PRESSURE_TRIGGER = "some 200000 2000000"
const PRESSURE_FOR_MS = 6_000
const PRESSURE_OVER_MS = 10_000
// hot: from 90 °C, or 10 below the sensor's own limit when that's lower; and
// cool again 5 °C under that
const HOT = 90
const COOLING = 5

// ─── Processes ────────────────────────────────────────────────────────────────

const TICKS_PER_SECOND = 100 // USER_HZ, the unit of /proc/<pid>/stat
const cores = Math.max(1, (readText("/proc/stat") ?? "").split("\n").filter(l => /^cpu\d/.test(l)).length)

type Proc = { comm: string; ticks: number }

function processes(): Map<number, Proc> {
    const all = new Map<number, Proc>()
    for (const name of listDir("/proc")) {
        if (!/^\d+$/.test(name)) continue
        const stat = readText(`/proc/${name}/stat`)
        if (!stat) continue
        // the name is in parentheses and may hold anything, parentheses too
        const close = stat.lastIndexOf(")")
        const fields = stat.slice(close + 2).split(" ")
        all.set(Number(name), {
            comm: stat.slice(stat.indexOf("(") + 1, close),
            ticks: Number(fields[11]) + Number(fields[12]),
        })
    }
    return all
}

/** What a process is part of: its app, when its command line names one. */
export type Group = { key: string; name: string; entry: string | null; value: number }

// the shell's own process
const SELF = Number(GLib.file_read_link("/proc/self"))

// A process's name as people know it. The kernel keeps 15 characters of it,
// and Nix's wrappers rename programs to .<name>-wrapped, so the command line
// says it better. Kernel threads have none, and are all the kernel's work
// (macOS's kernel_task).
function nameOf(pid: number, comm: string, cmdline: string | null): string {
    if (pid === SELF) return "Kiwi Shell"
    if (!cmdline) return "Kernel"
    const program = GLib.path_get_basename(cmdline.split("\0")[0] || comm)
    return program.replace(/^\.(.+?)-(un)?wrapped$/, "$1") || comm
}

function groupOf(pid: number, comm: string): { key: string; name: string; entry: string | null } {
    const cmdline = readText(`/proc/${pid}/cmdline`)
    const entry = cmdline && pid !== SELF ? entryFromCmdline(cmdline) : null
    if (!entry) {
        const name = nameOf(pid, comm, cmdline)
        return { key: `name:${name}`, name, entry: null }
    }
    const name = GioUnix.DesktopAppInfo.new(entry)?.get_name() ?? comm
    return { key: entry, name, entry }
}

function sumBy(items: { pid: number; comm: string; value: number }[]): Group[] {
    const groups = new Map<string, Group>()
    for (const item of items) {
        const g = groupOf(item.pid, item.comm)
        const sum = groups.get(g.key) ?? { ...g, value: 0 }
        sum.value += item.value
        groups.set(g.key, sum)
    }
    return [...groups.values()].sort((a, b) => b.value - a.value)
}

/** CPU time between two looks, as shares of one core, by app; busiest first. */
function cpuBetween(before: Map<number, Proc>, after: Map<number, Proc>, seconds: number): Group[] {
    const items: { pid: number; comm: string; value: number }[] = []
    for (const [pid, proc] of after) {
        const earlier = before.get(pid)
        if (!earlier || earlier.comm !== proc.comm) continue
        const value = (proc.ticks - earlier.ticks) / TICKS_PER_SECOND / seconds
        if (value >= 0.02) items.push({ pid, comm: proc.comm, value })
    }
    return sumBy(items)
}

/** Resident memory in bytes, by app; biggest first. */
function memoryByApp(): Group[] {
    const items: { pid: number; comm: string; value: number }[] = []
    for (const name of listDir("/proc")) {
        if (!/^\d+$/.test(name)) continue
        const status = readText(`/proc/${name}/status`)
        const rss = status?.match(/^VmRSS:\s+(\d+) kB/m)
        if (!status || !rss) continue
        const comm = status.match(/^Name:\s+(.*)$/m)?.[1] ?? name
        items.push({ pid: Number(name), comm, value: Number(rss[1]) * 1024 })
    }
    return sumBy(items.sort((a, b) => b.value - a.value).slice(0, 60))
}

// ─── The looks ────────────────────────────────────────────────────────────────

type Reading = { cpu: number; memory: number; available: number; temperature: number | null }

function readCpu(): [idle: number, total: number] | null {
    const line = readText("/proc/stat")?.split("\n")[0]
    if (!line?.startsWith("cpu ")) return null
    const parts = line.split(/\s+/).slice(1).map(Number)
    return [parts[3] + (parts[4] || 0), parts.reduce((a, b) => a + (b || 0), 0)]
}

function readMemory(): { used: number; available: number } | null {
    const info = readText("/proc/meminfo")
    const kb = (key: string) => Number(info?.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1])
    const total = kb("MemTotal"), available = kb("MemAvailable")
    if (!(total > 0) || !Number.isFinite(available)) return null
    return { used: 1 - available / total, available: available / total }
}

let sensor: string | null | undefined
let hot = HOT

function readTemperature(): number | null {
    if (sensor === undefined) {
        sensor = detectCpuTempFile()
        const limit = sensor ? readNumber(sensor.replace(/_input$/, "_max")) ?? readNumber(sensor.replace(/_input$/, "_crit")) : null
        if (limit && limit > 0) hot = Math.min(HOT, limit / 1000 - 10)
        log.info(`performance: CPU sensor ${sensor ?? "none"}, hot from ${hot} °C`)
    }
    const milli = sensor ? readNumber(sensor) : null
    return milli === null ? null : milli / 1000
}

let lastCpu = readCpu()
let lastLookAt = GLib.get_monotonic_time()
let snapshot: Map<number, Proc> | null = null
let busyLooks = 0
let holdingLooks = 0
let hotLooks = 0

type CpuState = { kind: "busy" | "holding"; load: number; top: Group[]; since: number }
type MemoryState = { used: number; top: Group[]; pressured: boolean; since: number }
type HeatState = { degrees: number; top: Group[]; since: number }

const [cpu, setCpu] = createState<CpuState | null>(null)
const [memory, setMemory] = createState<MemoryState | null>(null)
const [heat, setHeat] = createState<HeatState | null>(null)

// the busiest apps between the last two looks
let lastTop: Group[] = []

function look() {
    const now = GLib.get_monotonic_time()
    const seconds = (now - lastLookAt) / 1e6
    lastLookAt = now

    const ticks = readCpu()
    const load = ticks && lastCpu && ticks[1] > lastCpu[1]
        ? 1 - (ticks[0] - lastCpu[0]) / (ticks[1] - lastCpu[1]) : 0
    lastCpu = ticks

    // apps are only looked at while at least a core's worth is busy
    const working = load * cores >= 0.9
    const procs = working ? processes() : null
    lastTop = procs && snapshot ? cpuBetween(snapshot, procs, seconds) : []
    snapshot = procs

    busyLooks = load >= BUSY ? busyLooks + 1 : 0
    holdingLooks = (lastTop[0]?.value ?? 0) >= HOLDING ? holdingLooks + 1 : 0
    const busy = busyLooks >= 2 || (cpu()?.kind === "busy" && load >= BUSY * 0.75)
    const holding = holdingLooks >= 2
    const since = cpu()?.since ?? now
    if (busy) setCpu({ kind: "busy", load, top: lastTop, since })
    else if (holding) setCpu({ kind: "holding", load: lastTop[0].value, top: lastTop, since })
    else if (cpu()) setCpu(null)

    const degrees = readTemperature()
    hotLooks = degrees !== null && degrees >= hot ? hotLooks + 1 : 0
    const stillHot = heat() !== null && degrees !== null && degrees >= hot - COOLING
    if (degrees !== null && (hotLooks >= 2 || stillHot))
        setHeat({ degrees, top: lastTop, since: heat()?.since ?? now })
    else if (heat()) setHeat(null)

    const mem = readMemory()
    if (mem) judgeMemory(mem)
}

// ─── Memory pressure ──────────────────────────────────────────────────────────

let pressureFrom = 0
let pressureLast = 0
let pressureOver = 0

function judgeMemory(mem: { used: number; available: number }, pressured = memory()?.pressured ?? false) {
    const showing = memory() !== null
    const waitingShort = pressured && mem.available < SHORT_WAITING
    const short = mem.available < SHORT || waitingShort || (showing && mem.available < ENOUGH)
    if (!short) {
        if (showing) setMemory(null)
        return
    }
    const top = memory()?.top.length ? memory()!.top : memoryByApp()
    setMemory({ used: mem.used, top, pressured, since: memory()?.since ?? GLib.get_monotonic_time() })
}

function onPressure() {
    const now = GLib.get_monotonic_time()
    if (!pressureFrom || now - pressureLast > 4e6) pressureFrom = now
    pressureLast = now
    if (pressureOver) GLib.source_remove(pressureOver)
    pressureOver = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRESSURE_OVER_MS, () => {
        pressureOver = 0
        pressureFrom = 0
        const mem = readMemory()
        if (mem) judgeMemory(mem, false)
        else setMemory(null)
        return GLib.SOURCE_REMOVE
    })
    const mem = readMemory()
    if (mem && (now - pressureFrom) / 1000 >= PRESSURE_FOR_MS) judgeMemory(mem, true)
}

// the open file is the trigger: it lasts as long as the stream is kept
let pressureStream: Gio.FileIOStream | null = null
let pressureSource = 0

function watchPressure(): boolean {
    try {
        const stream = Gio.File.new_for_path("/proc/pressure/memory").open_readwrite(null)
        const out = stream.get_output_stream() as Gio.FileOutputStream
        // the kernel takes the last byte written for the string's end
        out.write_all(new TextEncoder().encode(`${PRESSURE_TRIGGER}\0`), null)
        const fd = (out as unknown as Gio.FileDescriptorBased).get_fd()
        pressureSource = GLibUnix.fd_add_full(GLib.PRIORITY_DEFAULT, fd, GLib.IOCondition.PRI, () => {
            onPressure()
            return GLib.SOURCE_CONTINUE
        })
        pressureStream = stream
        return true
    } catch (e) {
        log.warn("performance: no memory pressure events (PSI):", e as Error)
        return false
    }
}

// ─── On and off ───────────────────────────────────────────────────────────────

let looking = 0

function setWatching(on: boolean) {
    if (on && !looking) {
        lastCpu = readCpu()
        lastLookAt = GLib.get_monotonic_time()
        looking = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, CHECK_SECONDS, () => {
            look()
            return GLib.SOURCE_CONTINUE
        })
        if (!pressureStream) watchPressure()
    } else if (!on && looking) {
        GLib.source_remove(looking)
        looking = 0
        if (pressureSource) GLib.source_remove(pressureSource)
        pressureSource = 0
        pressureStream?.close(null)
        pressureStream = null
        snapshot = null
        busyLooks = holdingLooks = hotLooks = 0
        setCpu(null)
        setMemory(null)
        setHeat(null)
    }
}

const enabled = conf(c => !!c.island.performance)
enabled.subscribe(() => setWatching(enabled()))
setWatching(enabled())

// an open card has the latest by the time it shows: one more look at the
// apps then, measured from the last
opened.subscribe(() => {
    const id = opened()?.id
    if (id !== "cpu" && id !== "temperature" && id !== "memory") return
    if (id === "memory") {
        const state = memory()
        if (state) setMemory({ ...state, top: memoryByApp() })
        return
    }
    const now = GLib.get_monotonic_time()
    const seconds = (now - lastLookAt) / 1e6
    if (!snapshot || seconds < 2) return
    const top = cpuBetween(snapshot, processes(), seconds)
    const c = cpu(), h = heat()
    if (c) setCpu({ ...c, top })
    if (h) setHeat({ ...h, top })
})

// ─── Views ────────────────────────────────────────────────────────────────────

const percent = (share: number) => `${Math.round(share * 100)}%`

function bytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
    return `${Math.round(n / 1024 ** 2)} MB`
}

function minutes(since: number): string {
    const m = Math.round((GLib.get_monotonic_time() - since) / 60e6)
    return m < 1 ? "under a minute" : m === 1 ? "a minute" : `${m} minutes`
}

function GroupIcon({ group, size }: { group: Group | undefined; size: number }) {
    return group?.entry
        ? <Gtk.Image gicon={giconForEntry(group.entry)} pixelSize={size} />
        : <Gtk.Image iconName="am-cpu-symbolic" pixelSize={size} />
}

function Top({ groups, value }: { groups: Group[]; value: (g: Group) => string }) {
    return (
        <box class="top" orientation={Gtk.Orientation.VERTICAL}>
            {groups.slice(0, 5).map(g => (
                <box class="app">
                    <GroupIcon group={g} size={18} />
                    <label class="name" label={g.name} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} />
                    <label class="value" label={value(g)} />
                </box>
            ))}
        </box>
    )
}

function Card({ tone, icon, title, detail, children }: {
    tone: string; icon: string; title: string; detail: string; children?: JSX.Element
}) {
    return (
        <box class={`island-card island-performance ${tone}`} orientation={Gtk.Orientation.VERTICAL}>
            <box class="head">
                <Gtk.Image class="symbol" iconName={icon} pixelSize={22} />
                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                    <label class="title" label={title} xalign={0} />
                    <label class="detail" label={detail} xalign={0} wrap />
                </box>
            </box>
            {children}
        </box>
    )
}

const Symbol = ({ icon, tone }: { icon: string; tone: string }) =>
    <Gtk.Image class={`island-symbol ${tone}`} iconName={icon} pixelSize={16} valign={Gtk.Align.CENTER} /> as Gtk.Widget

const Value = ({ text, tone }: { text: Accessor<string> | string; tone: string }) =>
    <label class={`island-value ${tone}`} label={text} valign={Gtk.Align.CENTER} /> as Gtk.Widget

const CPU_ICON = "am-cpu-symbolic"
const HEAT_ICON = "am-temperature-symbolic"
const MEMORY_ICON = "nvidia-ram-symbolic"

const cpuActivity = createComputed(get => get(cpu) ? "cpu" : null)
const heatActivity = createComputed(get => get(heat) ? "temperature" : null)
const memoryActivity = createComputed(get => get(memory) ? "memory" : null)

addActivitySource(createComputed(get => {
    if (!get(cpuActivity)) return null
    const value = cpu(c => c ? percent(c.load) : "")
    return {
        id: "cpu",
        priority: PRIORITY.cpu,
        leading: () => {
            const c = cpu()
            return c?.kind === "holding" && c.top[0]?.entry
                ? <GroupIcon group={c.top[0]} size={18} /> as Gtk.Widget
                : <Symbol icon={CPU_ICON} tone="busy" />
        },
        trailing: () => <Value text={value} tone="busy" />,
        minimal: () => <Symbol icon={CPU_ICON} tone="busy" />,
        expanded: () => <With value={cpu}>{(c: CpuState | null) => !c ? <box /> : c.kind === "busy"
            ? <Card tone="busy" icon={CPU_ICON} title="CPU busy"
                detail={`${percent(c.load)} of all ${cores} cores, for ${minutes(c.since)}`}>
                <Top groups={c.top} value={g => percent(g.value)} />
            </Card>
            : <Card tone="busy" icon={CPU_ICON} title={`${c.top[0]?.name ?? "An app"} is busy`}
                detail={`It has kept a whole core busy for ${minutes(c.since)}. 100% is one core.`}>
                <Top groups={c.top} value={g => percent(g.value)} />
            </Card>}
        </With> as Gtk.Widget,
    } satisfies Activity
}))

addActivitySource(createComputed(get => {
    if (!get(heatActivity)) return null
    return {
        id: "temperature",
        priority: PRIORITY.temperature,
        leading: () => <Symbol icon={HEAT_ICON} tone="hot" />,
        trailing: () => <Value text={heat(h => h ? `${Math.round(h.degrees)}°` : "")} tone="hot" />,
        minimal: () => <Symbol icon={HEAT_ICON} tone="hot" />,
        expanded: () => <With value={heat}>{(h: HeatState | null) => !h ? <box /> :
            <Card tone="hot" icon={HEAT_ICON} title="CPU running hot"
                detail={`${Math.round(h.degrees)} °C for ${minutes(h.since)}. It slows itself down to cool off.`}>
                {h.top.length ? <Top groups={h.top} value={g => percent(g.value)} /> : <box />}
            </Card>}
        </With> as Gtk.Widget,
    } satisfies Activity
}))

addActivitySource(createComputed(get => {
    if (!get(memoryActivity)) return null
    return {
        id: "memory",
        priority: PRIORITY.memory,
        leading: () => <Symbol icon={MEMORY_ICON} tone="full" />,
        trailing: () => <Value text={memory(m => m ? percent(m.used) : "")} tone="full" />,
        minimal: () => <Symbol icon={MEMORY_ICON} tone="full" />,
        expanded: () => <With value={memory}>{(m: MemoryState | null) => !m ? <box /> :
            <Card tone="full" icon={MEMORY_ICON} title="Memory almost full"
                detail={m.pressured
                    ? `${percent(m.used)} used, and apps are waiting for memory: things slow down until some is freed.`
                    : `${percent(m.used)} used. Quitting an app frees its memory.`}>
                <Top groups={m.top} value={g => bytes(g.value)} />
            </Card>}
        </With> as Gtk.Widget,
    } satisfies Activity
}))
