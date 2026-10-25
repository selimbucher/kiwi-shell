import { Gtk } from "ags/gtk4"
import { createComputed, createState, onCleanup, type Accessor } from "ags"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GLibUnix from "gi://GLibUnix"
import GioUnix from "gi://GioUnix"
import Pango from "gi://Pango"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"

import { logger } from "../../../log"
import { conf } from "../../config"
import { readText, readNumber, listDir } from "../../sysfs"
import { giconForEntry, entryFromCmdline } from "../../appIcon"
import { detectCpuTempFile } from "../../Bar/SystemMenu/tabs/hardwarePolling"
import { addActivitySource, opened, PRIORITY, type Activity } from "../model"
import { closeWindow, clientSelector } from "../../../hypr"

const log = logger("island")

// ─── Performance ──────────────────────────────────────────────────────────────
// Three activities, for when the machine is working unusually hard: memory
// running out, the CPU running hot, the CPU busy. And macOS's "Apps Using
// Significant Energy": an app that has kept a lot of the CPU busy for
// minutes, listed in the system menu's Performance tab (a Mac lists them in
// its battery menu, which kiwi doesn't have). macOS has nothing in the
// island's place; Activity Monitor and the battery menu are where a Mac shows
// all this, and only when asked.
//
// The CPU shows only at its limit, all of its cores as good as full: the
// hardware giving all it has, which is as often a good sign (a build using
// the whole machine) as a bad one. Opened, it has been seen, and keeps out of
// the island until the spell is over. The cards are a small Activity
// Monitor, live while open: what is at its limit, and the apps behind it,
// one with a window quit from there.
//
// None of it needs to be on time to the second, and the laptop runs on
// battery, so the shell looks only every 30 s (one read of /proc/stat,
// /proc/meminfo and the CPU's sensor) and calls something unusual only after
// two looks in a row. Memory running out is the exception: it freezes a
// machine within seconds, and the kernel says so on its own — pressure stall
// information (PSI), a trigger that fires once the tasks spend a share of
// their time waiting for memory. Nothing runs between the looks and the
// kernel's calls, but for an open card, which looks every 2 s while it shows
// (as the Performance tab's gauges do).

const CHECK_SECONDS = 30
// The CPU is at its limit at this share of all its cores, two looks in a row
// (a minute), and stays so down to the second. One app keeping a core or
// two busy is significant energy (below), not this.
const BUSY = 0.95
const STILL_BUSY = 0.85
// an open card's looks
const CARD_SECONDS = 2
// An app (one with a desktop entry) uses significant energy from this share
// of one core, all its processes together, averaged over the last 5 minutes
// (ten looks), and stops below half of it. A minute or two of hard work isn't enough, music
// playing in the background (a few %) is nowhere near: Spotify drawing its
// looping videos where no one sees them (a whole core) is. The CPU's time
// stands in for energy; macOS counts the GPU, wake-ups and the disk too.
const SIGNIFICANT = 0.4
const INSIGNIFICANT = 0.2
const ENERGY_LOOKS = 10
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

/** What a process is part of: its app, when its command line names one; and its processes. */
export type Group = { key: string; name: string; entry: string | null; value: number; pids: number[] }

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
        const sum = groups.get(g.key) ?? { ...g, value: 0, pids: [] }
        sum.value += item.value
        sum.pids.push(item.pid)
        groups.set(g.key, sum)
    }
    return [...groups.values()].sort((a, b) => b.value - a.value)
}

/** CPU time between two looks, as shares of one core: by app, busiest first. */
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

// each core's [idle, total]
function readCores(): [number, number][] {
    return (readText("/proc/stat") ?? "").split("\n").filter(l => /^cpu\d/.test(l)).map(line => {
        const parts = line.split(/\s+/).slice(1).map(Number)
        return [parts[3] + (parts[4] || 0), parts.reduce((a, b) => a + (b || 0), 0)] as [number, number]
    })
}

const busyBetween = (before: [number, number] | null | undefined, after: [number, number] | null) =>
    before && after && after[1] > before[1] ? 1 - (after[0] - before[0]) / (after[1] - before[1]) : 0

function readMemory(): { used: number; available: number; total: number } | null {
    const info = readText("/proc/meminfo")
    const kb = (key: string) => Number(info?.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1])
    const total = kb("MemTotal"), available = kb("MemAvailable")
    if (!(total > 0) || !Number.isFinite(available)) return null
    return { used: 1 - available / total, available: available / total, total: total * 1024 }
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
let hotLooks = 0

let lastCores = readCores()

// The CPU at its limit: the load of all its cores and of each, its
// temperature, the busiest apps, and since when.
type CpuState = { load: number; perCore: number[]; degrees: number | null; top: Group[]; since: number }
type MemoryState = { used: number; total: number; top: Group[]; pressured: boolean; since: number }
type HeatState = { degrees: number; top: Group[]; since: number }

let atLimit: CpuState | null = null
// its card opened in this spell: out of the island until it is over
let cpuSeen = false
let cpuCardOpen = false
// over while its card was open, which shows on until it closes
let cpuOver = false
const [cpu, setCpu] = createState<CpuState | null>(null)
const showCpu = () => setCpu(atLimit && !cpuSeen ? atLimit : null)
const [memory, setMemory] = createState<MemoryState | null>(null)
const [heat, setHeat] = createState<HeatState | null>(null)

// the busiest apps between the last two looks
let lastTop: Group[] = []

function look() {
    const now = GLib.get_monotonic_time()
    const seconds = (now - lastLookAt) / 1e6
    lastLookAt = now

    const ticks = readCpu()
    const load = busyBetween(lastCpu, ticks)
    lastCpu = ticks
    const coreTicks = readCores()
    const perCore = coreTicks.map((core, i) => busyBetween(lastCores[i], core))
    lastCores = coreTicks
    const degrees = readTemperature()

    // apps are only looked at while the CPU does enough that one of them
    // could matter: below that, none can, and each counts nothing
    const working = load * cores >= INSIGNIFICANT
    const procs = working ? processes() : null
    const between = procs && snapshot ? cpuBetween(snapshot, procs, seconds) : null
    lastTop = between ?? []
    snapshot = procs
    // apps only, as macOS lists: the compositor or the shell itself working
    // hard (a genie spammed) is nothing to quit, nor is a daemon
    if (between) weigh(between.filter(group => group.entry))
    else if (!working) weigh([])

    busyLooks = load >= BUSY ? busyLooks + 1 : 0
    if (busyLooks >= 2 || (atLimit && load >= STILL_BUSY)) {
        atLimit = { load, perCore, degrees, top: lastTop.length ? lastTop : atLimit?.top ?? [], since: atLimit?.since ?? now }
        // on again before the open card was closed: the same spell
        cpuOver = false
    } else if (atLimit && cpuCardOpen) {
        cpuOver = true
    } else if (atLimit) {
        atLimit = null
        cpuSeen = false
    }
    showCpu()

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
    setMemory({ used: mem.used, total: mem.total, top, pressured, since: memory()?.since ?? GLib.get_monotonic_time() })
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

// ─── Significant energy ───────────────────────────────────────────────────────
// Each look adds each app's share of a core to its last ten; an app not seen
// adds nothing, and goes once it has added nothing ten times, or at once when
// none of its processes is left: one quit is gone from the list.

const hyprland = Hyprland.get_default()

const running = (group: Group) => group.pids.some(pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS))

const usage = new Map<string, { group: Group; shares: number[] }>()
const [energy, setEnergy] = createState<Group[]>([])

/** The apps using significant energy, most first, each at its average. */
export const significantEnergy: Accessor<Group[]> = energy
/** Whether anyone is looking (the island's performance activities on). */
export const weighingEnergy: Accessor<boolean> = conf(c => !!c.island.performance)

function weigh(apps: Group[]) {
    const seen = new Map(apps.map(g => [g.key, g]))
    for (const g of apps) if (!usage.has(g.key)) usage.set(g.key, { group: g, shares: [] })
    const listed = new Set(energy().map(g => g.key))
    const significant: Group[] = []
    for (const [key, app] of usage) {
        const now = seen.get(key)
        if (now) app.group = now
        else if (!running(app.group)) {
            usage.delete(key)
            continue
        }
        app.shares.push(now?.value ?? 0)
        if (app.shares.length > ENERGY_LOOKS) app.shares.shift()
        const average = app.shares.reduce((a, b) => a + b, 0) / ENERGY_LOOKS
        if (average >= SIGNIFICANT || (listed.has(key) && average >= INSIGNIFICANT))
            significant.push({ ...app.group, value: average })
        if (app.shares.every(share => share === 0)) usage.delete(key)
    }
    significant.sort((a, b) => b.value - a.value)
    const names = (groups: Group[]) => groups.map(g => `${g.key}=${g.name}`).join(";")
    if (names(significant) !== names(energy())) setEnergy(significant)
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
        if (pressureOver) GLib.source_remove(pressureOver)
        pressureOver = pressureFrom = 0
        pressureStream?.close(null)
        pressureStream = null
        snapshot = null
        busyLooks = hotLooks = 0
        usage.clear()
        atLimit = null
        cpuSeen = cpuOver = false
        setEnergy([])
        setCpu(null)
        setMemory(null)
        setHeat(null)
    }
}

const enabled = weighingEnergy
enabled.subscribe(() => setWatching(enabled()))
setWatching(enabled())

// ─── An open card ─────────────────────────────────────────────────────────────
// Live while it shows: a look of its own every CARD_SECONDS, measured from the
// last look at first, and none once it closes. The CPU's card closing has
// been seen: out of the island until the spell is over (or at once, over).

let cardSource = 0
let card: { at: number; procs: Map<number, Proc> | null; cpu: [number, number] | null; cores: [number, number][] } | null = null

function cardLook(id: string) {
    const now = GLib.get_monotonic_time()
    if (id === "memory") {
        const state = memory(), mem = readMemory()
        if (state && mem) setMemory({ ...state, used: mem.used, total: mem.total, top: memoryByApp() })
        return
    }
    if (!card || (now - card.at) / 1e6 < 1) return
    const procs = processes()
    const top = card.procs ? cpuBetween(card.procs, procs, (now - card.at) / 1e6) : []
    const ticks = readCpu(), coreTicks = readCores()
    const load = busyBetween(card.cpu, ticks)
    const perCore = coreTicks.map((core, i) => busyBetween(card!.cores[i], core))
    card = { at: now, procs, cpu: ticks, cores: coreTicks }
    const degrees = readTemperature()
    if (atLimit) {
        atLimit = { ...atLimit, load, perCore, degrees, top }
        showCpu()
    }
    const h = heat()
    if (h) setHeat({ ...h, degrees: degrees ?? h.degrees, top })
}

opened.subscribe(() => {
    const id = opened()?.id ?? ""
    const open = id === "cpu"
    if (open !== cpuCardOpen) {
        cpuCardOpen = open
        if (!open && atLimit) {
            if (cpuOver) atLimit = null
            cpuSeen = !cpuOver
            cpuOver = false
            showCpu()
        }
    }
    const live = id === "cpu" || id === "temperature" || id === "memory"
    if (cardSource) GLib.source_remove(cardSource)
    cardSource = 0
    if (!live) {
        card = null
        return
    }
    card = { at: lastLookAt, procs: snapshot, cpu: lastCpu, cores: lastCores }
    cardLook(id)
    cardSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CARD_SECONDS, () => {
        cardLook(id)
        return GLib.SOURCE_CONTINUE
    })
})

// ─── Views ────────────────────────────────────────────────────────────────────
// No sentences: what is at its limit and how far, a line of figures, and the
// apps behind it. The rows stay while the card is open and only their
// figures change, so a pointer on one keeps it (and its quit button).

const percent = (share: number) => `${Math.round(share * 100)}%`

function bytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
    return `${Math.round(n / 1024 ** 2)} MB`
}

function minutes(since: number): string {
    const m = Math.round((GLib.get_monotonic_time() - since) / 60e6)
    return m < 1 ? "<1 min" : `${m} min`
}

const stats = (...parts: (string | null | false)[]) => parts.filter(Boolean).join("  ·  ")

const iconOf = (group: Group | undefined) =>
    group?.entry ? giconForEntry(group.entry) : Gio.ThemedIcon.new("am-cpu-symbolic")

export function GroupIcon({ group, size, cssClass = "" }: { group: Group | undefined; size: number; cssClass?: string }) {
    return <Gtk.Image class={cssClass} gicon={iconOf(group)} pixelSize={size} />
}

// an app's windows, by the app its process is part of
const windowsOf = (group: Group) =>
    hyprland.get_clients().filter(client => groupOf(client.get_pid(), "").key === group.key)

const TOP_ROWS = 5

/**
 * The apps behind it, busiest first; one with a window quit from its row (on
 * hover). While the pointer is on them they keep their order, only their
 * figures changing: re-sorted under it, a click meant for one app's quit
 * could land on another's.
 */
function Top({ groups, value }: { groups: Accessor<Group[]>; value: (g: Group) => string }) {
    const [rows, setRows] = createState<Group[]>(groups().slice(0, TOP_ROWS))
    let pointed = false
    const update = () => {
        const all = groups()
        if (!pointed) return setRows(all.slice(0, TOP_ROWS))
        // the same apps, as they are now; one gone at nothing
        const now = new Map(all.map(g => [g.key, g]))
        setRows(rows().map(g => now.get(g.key) ?? { ...g, value: 0 }))
    }
    const list = (
        <box class="top" orientation={Gtk.Orientation.VERTICAL}>
            {Array.from({ length: TOP_ROWS }, (_, i) => {
                const group = rows(all => all[i] as Group | undefined)
                const quittable = (g: Group | undefined) => !!g?.entry && windowsOf(g).length > 0
                return (
                    <box class="app" visible={group(g => !!g)}>
                        <Gtk.Image gicon={group(iconOf)} pixelSize={18} />
                        <label class="name" label={group(g => g?.name ?? "")} xalign={0} hexpand
                            ellipsize={Pango.EllipsizeMode.END} maxWidthChars={1} />
                        <label class="value" label={group(g => g ? value(g) : "")} />
                        {/* on every row, so the figures line up; usable on an app's */}
                        <button valign={Gtk.Align.CENTER}
                            class={group(g => quittable(g) ? "quit can" : "quit")}
                            sensitive={group(quittable)}
                            tooltipText={group(g => quittable(g) ? `Quit ${g!.name}` : "")}
                            onClicked={() => {
                                const g = rows()[i]
                                if (g) for (const client of windowsOf(g)) closeWindow(clientSelector(client))
                            }}>
                            <Gtk.Image iconName="window-close-symbolic" pixelSize={10} />
                        </button>
                    </box>
                )
            })}
        </box>
    ) as Gtk.Widget
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { pointed = true })
    motion.connect("leave", () => {
        pointed = false
        update()
    })
    list.add_controller(motion)
    onCleanup(groups.subscribe(update))
    return list
}

// each core a bar, filled as far as it is busy, in the card's colour
const CoreBars = GObject.registerClass(
    { GTypeName: "KiwiCoreBars" },
    class CoreBars extends Gtk.Widget {
        loads: number[] = []

        vfunc_measure(orientation: Gtk.Orientation): [number, number, number, number] {
            return orientation === Gtk.Orientation.VERTICAL ? [26, 26, -1, -1] : [0, 0, -1, -1]
        }

        vfunc_snapshot(snapshot: Gtk.Snapshot): void {
            const n = this.loads.length
            if (!n) return
            const width = this.get_width(), height = this.get_height()
            const gap = n > 24 ? 2 : 3
            const bar = (width - gap * (n - 1)) / n
            const color = this.get_color()
            const trough = color.copy()
            trough.alpha *= 0.16
            const radius = new Graphene.Size().init(Math.min(2, bar / 2), Math.min(2, bar / 2))
            const rounded = (x: number, y: number, h: number) =>
                new Gsk.RoundedRect().init(new Graphene.Rect().init(x, y, bar, h), radius, radius, radius, radius)
            this.loads.forEach((load, i) => {
                const x = i * (bar + gap)
                for (const [rect, paint] of [[rounded(x, 0, height), trough], [rounded(x, height - Math.max(2, height * load), Math.max(2, height * load)), color]] as const) {
                    snapshot.push_rounded_clip(rect)
                    snapshot.append_color(paint, rect.bounds)
                    snapshot.pop()
                }
            })
        }
    },
)

function Cores({ loads }: { loads: Accessor<number[]> }) {
    const bars = new CoreBars({ cssClasses: ["cores"], hexpand: true })
    const update = () => {
        bars.loads = loads()
        bars.queue_draw()
    }
    update()
    onCleanup(loads.subscribe(update))
    return bars
}

function Card({ tone, icon, title, value, line, children }: {
    tone: string; icon: string; title: string; value: Accessor<string>; line: Accessor<string>; children?: JSX.Element | JSX.Element[]
}) {
    return (
        <box class={`island-card island-performance ${tone}`} orientation={Gtk.Orientation.VERTICAL}>
            <box class="head">
                <Gtk.Image class="symbol" iconName={icon} pixelSize={22} valign={Gtk.Align.CENTER} />
                <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
                    <label class="title" label={title} xalign={0} />
                    <label class="stats" label={line} xalign={0} />
                </box>
                <label class="big" label={value} valign={Gtk.Align.CENTER} />
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

// apps' CPU as shares of all of it, as the load is
const ofAll = (g: Group) => percent(g.value / cores)

addActivitySource(createComputed(get => {
    if (!get(cpuActivity)) return null
    return {
        id: "cpu",
        priority: PRIORITY.cpu,
        leading: () => <Symbol icon={CPU_ICON} tone="busy" />,
        trailing: () => <Value text={cpu(c => c ? percent(c.load) : "")} tone="busy" />,
        minimal: () => <Symbol icon={CPU_ICON} tone="busy" />,
        expanded: () => (
            <Card tone="busy" icon={CPU_ICON} title="CPU" value={cpu(c => c ? percent(c.load) : "")}
                line={cpu(c => c ? stats(`${cores} cores`, c.degrees !== null && `${Math.round(c.degrees)}°`, minutes(c.since)) : "")}>
                <Cores loads={cpu(c => c?.perCore ?? [])} />
                <Top groups={cpu(c => c?.top ?? [])} value={ofAll} />
            </Card>
        ) as Gtk.Widget,
    } satisfies Activity
}))

addActivitySource(createComputed(get => {
    if (!get(heatActivity)) return null
    const degrees = heat(h => h ? `${Math.round(h.degrees)}°` : "")
    return {
        id: "temperature",
        priority: PRIORITY.temperature,
        leading: () => <Symbol icon={HEAT_ICON} tone="hot" />,
        trailing: () => <Value text={degrees} tone="hot" />,
        minimal: () => <Symbol icon={HEAT_ICON} tone="hot" />,
        expanded: () => (
            <Card tone="hot" icon={HEAT_ICON} title="CPU temperature" value={degrees}
                line={heat(h => h ? stats("slowing down", minutes(h.since)) : "")}>
                <Top groups={heat(h => h?.top ?? [])} value={ofAll} />
            </Card>
        ) as Gtk.Widget,
    } satisfies Activity
}))

addActivitySource(createComputed(get => {
    if (!get(memoryActivity)) return null
    const used = memory(m => m ? percent(m.used) : "")
    return {
        id: "memory",
        priority: PRIORITY.memory,
        leading: () => <Symbol icon={MEMORY_ICON} tone="full" />,
        trailing: () => <Value text={used} tone="full" />,
        minimal: () => <Symbol icon={MEMORY_ICON} tone="full" />,
        expanded: () => (
            <Card tone="full" icon={MEMORY_ICON} title="Memory" value={used}
                line={memory(m => m ? stats(`${bytes(m.used * m.total)} of ${bytes(m.total)}`, m.pressured && "apps waiting", minutes(m.since)) : "")}>
                <Top groups={memory(m => m?.top ?? [])} value={g => bytes(g.value)} />
            </Card>
        ) as Gtk.Widget,
    } satisfies Activity
}))
