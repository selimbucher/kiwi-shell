// ─── Spreading a desktop's windows out ────────────────────────────────────────
// Mission Control shows every window of a desktop at once, none covering
// another, each roughly where it was: windows high up on the screen stay in
// the upper rows, windows on the left stay towards the left.
//
// Rows, as GNOME Shell's overview lays them out (its UnalignedLayoutStrategy):
// the windows go into rows by how high their middles are, each row filled to
// an even share of their total width, and within a row they are put in order
// of how far left their middles are. Every row count from one up is tried, and
// the one that shows the windows largest wins, with the share of the area it
// fills breaking ties. A small window is given more room than its size, so a
// dialog next to a maximized browser is still something to click on.

export type Box = { x: number; y: number; width: number; height: number }

export type Slot<T> = Box & { item: T }

export type SpreadOptions = {
    // between two windows in a row, and between rows (the title goes there)
    columnSpacing: number
    rowSpacing: number
    // never larger than this share of the window's own size
    maxScale: number
}

// how much the area's fill counts against the windows' size
const SPACE_WEIGHT = 0.1

type Sized<T> = { item: T; box: Box; boost: number }
type Row<T> = { windows: Sized<T>[]; width: number; height: number }

const middleX = (b: Box) => b.x + b.width / 2
const middleY = (b: Box) => b.y + b.height / 2

// A row takes one window more while that brings it closer to its share.
function keepInRow(rowWidth: number, width: number, share: number): boolean {
    if (rowWidth + width <= share) return true
    return Math.abs(1 - (rowWidth + width) / share) < Math.abs(1 - rowWidth / share)
}

function rowsOf<T>(windows: Sized<T>[], count: number): Row<T>[] {
    const total = windows.reduce((sum, w) => sum + w.box.width * w.boost, 0)
    const share = total / count
    const rows: Row<T>[] = []
    let next = 0
    for (let r = 0; r < count && next < windows.length; r++) {
        const row: Row<T> = { windows: [], width: 0, height: 0 }
        for (; next < windows.length; next++) {
            const w = windows[next]
            const width = w.box.width * w.boost
            const last = r === count - 1
            if (row.windows.length > 0 && !last && !keepInRow(row.width, width, share)) break
            row.windows.push(w)
            row.width += width
            row.height = Math.max(row.height, w.box.height * w.boost)
        }
        row.windows.sort((a, b) => middleX(a.box) - middleX(b.box))
        rows.push(row)
    }
    return rows
}

function fit<T>(rows: Row<T>[], area: Box, options: SpreadOptions) {
    const columns = Math.max(...rows.map(r => r.windows.length))
    const hspacing = (columns - 1) * options.columnSpacing
    const vspacing = (rows.length - 1) * options.rowSpacing
    const gridWidth = Math.max(...rows.map(r => r.width))
    const gridHeight = rows.reduce((sum, r) => sum + r.height, 0)
    const scale = Math.max(0, Math.min(
        (area.width - hspacing) / gridWidth,
        (area.height - vspacing) / gridHeight,
        options.maxScale,
    ))
    const space = ((gridWidth * scale + hspacing) * (gridHeight * scale + vspacing))
        / (area.width * area.height)
    return { scale, space }
}

/**
 * Where each window goes in `area`. `screen` is the size the windows' own
 * boxes are measured against: their monitor.
 */
export function spread<T>(
    windows: { item: T; box: Box }[],
    area: Box,
    screen: { width: number; height: number },
    options: SpreadOptions,
): Slot<T>[] {
    if (windows.length === 0 || area.width <= 0 || area.height <= 0) return []

    // up to half as large again for the smallest windows
    const sized: Sized<T>[] = windows
        .filter(w => w.box.width > 0 && w.box.height > 0)
        .map(w => ({ ...w, boost: 1.5 - 0.5 * Math.min(1, w.box.height / screen.height) }))
        .sort((a, b) => middleY(a.box) - middleY(b.box))
    if (sized.length === 0) return []

    let best: { rows: Row<T>[]; scale: number; score: number } | null = null
    for (let count = 1; count <= sized.length; count++) {
        const rows = rowsOf(sized, count)
        const { scale, space } = fit(rows, area, options)
        const score = scale + space * SPACE_WEIGHT
        if (!best || score > best.score) best = { rows, scale, score }
    }
    const { rows, scale } = best!

    // each window at the common scale, its boost capped where that would
    // show it larger than allowed
    const placed = rows.map(row => {
        const windows = row.windows.map(w => {
            const s = Math.min(scale * w.boost, options.maxScale)
            return { item: w.item, width: w.box.width * s, height: w.box.height * s }
        })
        return {
            windows,
            width: windows.reduce((sum, w) => sum + w.width, 0) + (windows.length - 1) * options.columnSpacing,
            height: Math.max(...windows.map(w => w.height)),
        }
    })

    const height = placed.reduce((sum, r) => sum + r.height, 0) + (placed.length - 1) * options.rowSpacing
    let y = area.y + Math.max(0, (area.height - height) / 2)
    const slots: Slot<T>[] = []
    for (const row of placed) {
        let x = area.x + Math.max(0, (area.width - row.width) / 2)
        for (const w of row.windows) {
            slots.push({
                item: w.item,
                x: Math.round(x),
                y: Math.round(y + (row.height - w.height) / 2),
                width: Math.round(w.width),
                height: Math.round(w.height),
            })
            x += w.width + options.columnSpacing
        }
        y += row.height + options.rowSpacing
    }
    return slots
}
