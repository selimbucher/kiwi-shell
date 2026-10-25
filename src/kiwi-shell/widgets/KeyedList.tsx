import { Gtk } from "ags/gtk4"
import { createComputed, createRoot, onCleanup } from "ags"

export function KeyedList<T>({
    each,
    keyFn,
    children,
    enterClass,
    enterDuration = 700,
    shouldEnter,
    exitClass,
    exitDuration = 500,
    exitDelay = 0,
    shouldExit,
    onCount,
    appendOnly,
    orientation = Gtk.Orientation.HORIZONTAL,
    spacing = 0,
}: {
    each: ReturnType<typeof createComputed<T[]>>
    keyFn: (item: T) => string
    children: (item: T) => Gtk.Widget
    enterClass?: string
    enterDuration?: number
    shouldEnter?: (item: T) => boolean
    exitClass?: string
    exitDuration?: number
    /** how long an entry gone stays as it was before it plays its exit: back
     *  within it, nothing happened */
    exitDelay?: number
    /** false for an entry gone elsewhere (another list has it now): no exit,
     *  it is just taken out */
    shouldExit?: (key: string) => boolean
    /** the widgets there, those leaving included, and those staying */
    onCount?: (present: number, staying: number) => void
    appendOnly?: boolean
    orientation?: Gtk.Orientation
    spacing?: number
}) {
    return (
        <box
            orientation={orientation}
            spacing={spacing}
            $={(self: Gtk.Box) => {
                const widgetMap = new Map<string, Gtk.Widget>()
                const disposeMap = new Map<string, () => void>()
                const exiting = new Map<string, ReturnType<typeof setTimeout>>()
                const waiting = new Map<string, ReturnType<typeof setTimeout>>()
                // back while playing their exit: in again once it is over
                const returning = new Set<string>()
                const latest = new Map<string, T>()
                let prevKeys: string[] = []
                let initialized = false

                const count = () => onCount?.(widgetMap.size, widgetMap.size - exiting.size)

                const exit = (k: string) => {
                    const w = widgetMap.get(k)
                    if (!w) return
                    if (enterClass) w.remove_css_class(enterClass)
                    w.remove_css_class("shown")
                    w.add_css_class(exitClass!)
                    exiting.set(k, setTimeout(() => {
                        exiting.delete(k)
                        const after = widgetMap.get(k)?.get_prev_sibling() ?? null
                        removeNow(k)
                        // Back while it went: in again where it was. Its exit
                        // can't be turned round halfway (a CSS animation only
                        // starts from its start), and snapping it back whole
                        // was a jump; it shrinks away and grows back instead.
                        const item = latest.get(k)
                        if (returning.delete(k) && item !== undefined) create(item, after)
                        count()
                    }, exitDuration))
                    count()
                }

                const create = (item: T, after?: Gtk.Widget | null) => createRoot(dispose => {
                    const k = keyFn(item)
                    const w = children(item)
                    widgetMap.set(k, w)
                    disposeMap.set(k, dispose)
                    if (after === undefined) self.append(w)
                    else self.insert_child_after(w, after)
                    if (!initialized) return
                    if (enterClass && (shouldEnter ? shouldEnter(item) : true)) {
                        w.add_css_class(enterClass)
                        // settle to .shown once the enter animation is
                        // done, so it can never replay on this widget
                        setTimeout(() => {
                            if (!w.get_parent()) return
                            w.remove_css_class(enterClass)
                            w.add_css_class("shown")
                        }, enterDuration)
                    } else {
                        w.add_css_class("shown")
                    }
                })

                const removeNow = (k: string) => {
                    const w = widgetMap.get(k)
                    if (w && w.get_parent() === self) self.remove(w)
                    disposeMap.get(k)?.()
                    disposeMap.delete(k)
                    widgetMap.delete(k)
                }

                const sync = (items: T[]) => {
                    if (!items) return

                    const nextKeys = items.map(keyFn)
                    const nextKeySet = new Set(nextKeys)
                    latest.clear()
                    for (const item of items) latest.set(keyFn(item), item)

                    // 1. Remove widgets whose entries disappeared. With exitClass the
                    //    widget stays around playing its exit animation first.
                    for (const k of prevKeys) {
                        if (!nextKeySet.has(k)) returning.delete(k)
                        if (nextKeySet.has(k) || exiting.has(k) || waiting.has(k)) continue
                        if (!exitClass || !initialized || (shouldExit && !shouldExit(k))) removeNow(k)
                        else if (exitDelay > 0) waiting.set(k, setTimeout(() => {
                            waiting.delete(k)
                            exit(k)
                        }, exitDelay))
                        else exit(k)
                    }

                    // 2. Create widgets for new entries inside a reactive root so that
                    //    onCleanup / createState inside children have a tracking context.
                    for (const item of items) {
                        const k = keyFn(item)
                        // back before its exit began: it never left
                        const waitTimer = waiting.get(k)
                        if (waitTimer !== undefined) {
                            clearTimeout(waitTimer)
                            waiting.delete(k)
                        }
                        // re-added while playing its exit animation
                        if (exiting.has(k)) returning.add(k)
                        else if (!widgetMap.has(k)) create(item)
                    }

                    // 3. Reorder forward to match array order without touching widget state.
                    //    Skipped when appendOnly is set — new widgets are always appended at
                    //    the end so existing widgets are never shuffled (which would restart
                    //    their CSS animations).
                    if (!appendOnly) {
                        let prev: Gtk.Widget | null = null
                        for (let i = 0; i < nextKeys.length; i++) {
                            const w = widgetMap.get(nextKeys[i])
                            if (!w) continue
                            self.reorder_child_after(w, prev)
                            prev = w
                        }
                    }

                    prevKeys = nextKeys
                    initialized = true
                    count()
                }

                sync(each.get() ?? [])

                const unsub = each.subscribe(() => sync(each.get() ?? []))

                onCleanup(() => {
                    unsub()
                    for (const timer of exiting.values()) clearTimeout(timer)
                    exiting.clear()
                    for (const timer of waiting.values()) clearTimeout(timer)
                    waiting.clear()
                    returning.clear()
                    latest.clear()
                    for (const dispose of disposeMap.values()) dispose()
                    disposeMap.clear()
                    widgetMap.clear()
                })
            }}
        />
    )
}