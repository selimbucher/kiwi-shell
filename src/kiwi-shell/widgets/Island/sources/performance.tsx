import { Gtk } from "ags/gtk4"
import { createComputed, createState, With, type Accessor } from "ags"
import Hyprland from "gi://AstalHyprland"
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
// running out, the CPU running hot, the CPU busy. And macOS's "Apps Using
// Significant Energy": an app that has kept a lot of the CPU busy for
// minutes, listed in the system menu's Performance tab (a Mac lists them in
// its battery menu, which kiwi doesn't have). macOS has nothing in the
// island's place; Activity Monitor and the battery menu are where a Mac shows
// all this, and only when asked.
//
// The CPU is busy when all of it is, or when an app out of sight keeps a lot
// of it busy (one on screen works for whoever is looking at it). Either is
// news that matters, and a burst of it is easily missed: the CPU stays in the
// island until its card has been opened, past tense once it's over, and then
// keeps away while the same goes on.
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
// The CPU counts as busy at this share of all its cores, two looks in a
// row, and stays busy down to the second: the extreme case only, the machine
// as good as full. One app keeping a core or two busy is significant energy
// (below), not this.
const BUSY = 0.9
const STILL_BUSY = 0.7
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
let hotLooks = 0

// One spell of the CPU busy: all of it (no app), or an app out of sight.
// `value` the load now, of all the cores or of one; `over` when it ended,
// while it waits to be seen; `seen` once its card has been opened.
type Spell = {
    app: Group | null; value: number; peak: number; top: Group[]
    since: number; over: number | null; seen: boolean
}
let full: Spell | null = null
const spells = new Map<string, Spell>()

// what the island shows: the spells not yet seen, all the CPU first
type CpuState = { spells: Spell[] }
type MemoryState = { used: number; top: Group[]; pressured: boolean; since: number }
type HeatState = { degrees: number; top: Group[]; since: number }

const [cpu, setCpu] = createState<CpuState | null>(null)

function showCpu() {
    const unseen = [full, ...[...spells.values()].sort((a, b) => b.value - a.value)]
        .filter((spell): spell is Spell => !!spell && !spell.seen)
    setCpu(unseen.length ? { spells: unseen.map(spell => ({ ...spell })) } : null)
}

// a spell that has ended goes once seen, or is kept until it is
function ended(spell: Spell, now: number): boolean {
    if (spell.seen) return true
    spell.over ??= now
    return false
}
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
    const going = full !== null && full.over === null
    if (busyLooks >= 2 || (going && load >= STILL_BUSY)) {
        if (!going) full = { app: null, value: load, peak: load, top: lastTop, since: now, over: null, seen: false }
        else full = { ...full!, value: load, peak: Math.max(full!.peak, load), top: lastTop.length ? lastTop : full!.top }
    } else if (going && ended(full!, now)) {
        full = null
    }
    showCpu()

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

// ─── Significant energy ───────────────────────────────────────────────────────
// Each look adds each app's share of a core to its last ten; an app not seen
// adds nothing, and goes once it has added nothing ten times.

const hyprland = Hyprland.get_default()

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

    // the CPU busy, for an app out of sight; one already going on keeps on
    // wherever it is now. Its average is over the last five minutes, so that
    // is how long it has been at it, at least.
    const now = GLib.get_monotonic_time()
    const onScreen = appsOnScreen()
    for (const app of significant) {
        const spell = spells.get(app.key)
        if (spell) {
            spells.set(app.key, { ...spell, app, value: app.value, peak: Math.max(spell.peak, app.value), over: null })
        } else if (!onScreen.has(app.key)) {
            log.info(`performance: ${app.name} keeps the CPU busy out of sight (${percent(app.value)} of a core, averaged over 5 minutes)`)
            spells.set(app.key, {
                app, value: app.value, peak: app.value, top: [],
                since: now - ENERGY_LOOKS * CHECK_SECONDS * 1e6, over: null, seen: false,
            })
        }
    }
    for (const [key, spell] of spells)
        if (!significant.some(app => app.key === key) && ended(spell, now)) spells.delete(key)
    showCpu()
}

// the apps with a window on a desktop that a monitor shows (minimized ones
// are on a hidden one)
function appsOnScreen(): Set<string> {
    const shown = new Set(hyprland.get_monitors().map(m => m.get_active_workspace()?.get_id()))
    const apps = new Set<string>()
    for (const client of hyprland.get_clients()) {
        if (shown.has(client.get_workspace()?.get_id())) apps.add(groupOf(client.get_pid(), "").key)
    }
    return apps
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
        busyLooks = hotLooks = 0
        usage.clear()
        full = null
        spells.clear()
        setEnergy([])
        setCpu(null)
        setMemory(null)
        setHeat(null)
    }
}

const enabled = weighingEnergy
enabled.subscribe(() => setWatching(enabled()))
setWatching(enabled())

// The CPU's card closed: what it showed has been seen. Spells over are done
// with; the ones going on keep out of the island until they end.
let cpuCardOpen = false
opened.subscribe(() => {
    const open = opened()?.id === "cpu"
    if (open === cpuCardOpen) return
    cpuCardOpen = open
    if (open) return
    if (full) full = full.over === null ? { ...full, seen: true } : null
    for (const [key, spell] of spells) {
        if (spell.over !== null) spells.delete(key)
        else spells.set(key, { ...spell, seen: true })
    }
    showCpu()
})

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
    const h = heat()
    if (full && full.over === null) {
        full = { ...full, top }
        showCpu()
    }
    if (h) setHeat({ ...h, top })
})

// ─── Views ────────────────────────────────────────────────────────────────────

const percent = (share: number) => `${Math.round(share * 100)}%`

function bytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
    return `${Math.round(n / 1024 ** 2)} MB`
}

function minutes(since: number, until = GLib.get_monotonic_time()): string {
    const m = Math.round((until - since) / 60e6)
    return m < 1 ? "under a minute" : m === 1 ? "a minute" : `${m} minutes`
}

function ago(at: number): string {
    const m = Math.round((GLib.get_monotonic_time() - at) / 60e6)
    return m < 1 ? "just now" : `${minutes(at)} ago`
}

export function GroupIcon({ group, size, cssClass = "" }: { group: Group | undefined; size: number; cssClass?: string }) {
    return group?.entry
        ? <Gtk.Image class={cssClass} gicon={giconForEntry(group.entry)} pixelSize={size} />
        : <Gtk.Image class={cssClass} iconName="am-cpu-symbolic" pixelSize={size} />
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

// The spell the island is about: all the CPU before any app, then the app
// keeping the most of it busy. Its load, as Activity Monitor counts: of all
// the cores for all the CPU, of one core for an app.
const first = (c: CpuState | null) => c?.spells[0] ?? null
const shownValue = (spell: Spell | null) => spell ? percent(spell.over === null ? spell.value : spell.peak) : ""
// a spell over is greyed until seen
const toneOf = (spell: Spell | null) => spell?.over === null ? "busy" : "was"

function CpuCard({ spells }: { spells: Spell[] }) {
    const [spell] = spells
    const over = spell.over !== null
    if (!spell.app) return (
        <Card tone={toneOf(spell)} icon={CPU_ICON} title={over ? "CPU was busy" : "CPU busy"}
            detail={over
                ? `Up to ${percent(spell.peak)} of all ${cores} cores for ${minutes(spell.since, spell.over!)}, until ${ago(spell.over!)}`
                : `${percent(spell.value)} of all ${cores} cores, for ${minutes(spell.since)}`}>
            <Top groups={spell.top} value={g => percent(g.value)} />
        </Card>
    )
    const apps = spells.filter(s => s.app)
    const name = spell.app.name
    return (
        <Card tone={toneOf(spell)} icon={CPU_ICON} title={over ? `${name} was busy` : `${name} is busy`}
            detail={over
                ? `It kept up to ${percent(spell.peak)} of a core busy out of sight for ${minutes(spell.since, spell.over!)}, until ${ago(spell.over!)}. 100% is one core.`
                : `It has kept ${percent(spell.value)} of a core busy out of sight for ${minutes(spell.since)}. 100% is one core.`}>
            {apps.length > 1
                ? <Top groups={apps.map(s => ({ ...s.app!, value: s.over === null ? s.value : s.peak }))} value={g => percent(g.value)} />
                : <box />}
        </Card>
    )
}

addActivitySource(createComputed(get => {
    if (!get(cpuActivity)) return null
    const spell = cpu(first)
    return {
        id: "cpu",
        priority: PRIORITY.cpu,
        leading: () => <With value={spell(toneOf)}>{(tone: string) => <Symbol icon={CPU_ICON} tone={tone} />}</With> as Gtk.Widget,
        trailing: () => <With value={spell(toneOf)}>{(tone: string) => <Value text={spell(shownValue)} tone={tone} />}</With> as Gtk.Widget,
        minimal: () => <With value={spell(toneOf)}>{(tone: string) => <Symbol icon={CPU_ICON} tone={tone} />}</With> as Gtk.Widget,
        expanded: () => <With value={cpu}>{(c: CpuState | null) => !c ? <box /> : <CpuCard spells={c.spells} />}</With> as Gtk.Widget,
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
