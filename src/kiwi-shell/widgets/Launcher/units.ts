import { formatNumber } from "./calc"

// ─── Units ────────────────────────────────────────────────────────────────────
// "5 km in mi", "100 f to c", "2.5 GiB in MB", "90 min in h": the other half
// of what people type a sum into Spotlight for. A unit alone ("5 mi") is put
// into its usual other (km), as a Mac's Spotlight does. No currencies: their
// rates would need the network at every keystroke.

type Unit = { family: string, factor: number, symbol: string, names: string[] }

// factor: the unit in its family's base (m, kg, l, s, B, m/s, m²)
const UNITS: Unit[] = [
    { family: "length", factor: 0.001, symbol: "mm", names: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"] },
    { family: "length", factor: 0.01, symbol: "cm", names: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"] },
    { family: "length", factor: 1, symbol: "m", names: ["m", "meter", "meters", "metre", "metres"] },
    { family: "length", factor: 1000, symbol: "km", names: ["km", "kilometer", "kilometers", "kilometre", "kilometres"] },
    { family: "length", factor: 0.0254, symbol: "in", names: ["in", "inch", "inches", "\""] },
    { family: "length", factor: 0.3048, symbol: "ft", names: ["ft", "foot", "feet", "'"] },
    { family: "length", factor: 0.9144, symbol: "yd", names: ["yd", "yard", "yards"] },
    { family: "length", factor: 1609.344, symbol: "mi", names: ["mi", "mile", "miles"] },
    { family: "length", factor: 1852, symbol: "nmi", names: ["nmi", "nautical mile", "nautical miles"] },
    { family: "mass", factor: 1e-6, symbol: "mg", names: ["mg", "milligram", "milligrams"] },
    { family: "mass", factor: 0.001, symbol: "g", names: ["g", "gram", "grams", "gramme", "grammes"] },
    { family: "mass", factor: 1, symbol: "kg", names: ["kg", "kilo", "kilos", "kilogram", "kilograms"] },
    { family: "mass", factor: 1000, symbol: "t", names: ["t", "tonne", "tonnes", "ton", "tons"] },
    { family: "mass", factor: 0.028349523125, symbol: "oz", names: ["oz", "ounce", "ounces"] },
    { family: "mass", factor: 0.45359237, symbol: "lb", names: ["lb", "lbs", "pound", "pounds"] },
    { family: "mass", factor: 6.35029318, symbol: "st", names: ["st", "stone", "stones"] },
    { family: "volume", factor: 0.001, symbol: "ml", names: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"] },
    { family: "volume", factor: 0.1, symbol: "dl", names: ["dl", "deciliter", "deciliters", "decilitre", "decilitres"] },
    { family: "volume", factor: 1, symbol: "l", names: ["l", "liter", "liters", "litre", "litres"] },
    { family: "volume", factor: 1000, symbol: "m³", names: ["m3", "m³", "cubic meter", "cubic meters"] },
    { family: "volume", factor: 0.00492892159, symbol: "tsp", names: ["tsp", "teaspoon", "teaspoons"] },
    { family: "volume", factor: 0.0147867648, symbol: "tbsp", names: ["tbsp", "tablespoon", "tablespoons"] },
    { family: "volume", factor: 0.0295735296, symbol: "fl oz", names: ["floz", "fl oz", "fluid ounce", "fluid ounces"] },
    { family: "volume", factor: 0.2365882365, symbol: "cups", names: ["cup", "cups"] },
    { family: "volume", factor: 0.473176473, symbol: "pt", names: ["pt", "pint", "pints"] },
    { family: "volume", factor: 3.785411784, symbol: "gal", names: ["gal", "gallon", "gallons"] },
    { family: "time", factor: 0.001, symbol: "ms", names: ["ms", "millisecond", "milliseconds"] },
    { family: "time", factor: 1, symbol: "s", names: ["s", "sec", "secs", "second", "seconds"] },
    { family: "time", factor: 60, symbol: "min", names: ["min", "mins", "minute", "minutes"] },
    { family: "time", factor: 3600, symbol: "h", names: ["h", "hr", "hrs", "hour", "hours"] },
    { family: "time", factor: 86400, symbol: "days", names: ["d", "day", "days"] },
    { family: "time", factor: 604800, symbol: "weeks", names: ["wk", "week", "weeks"] },
    { family: "time", factor: 31556952, symbol: "years", names: ["yr", "yrs", "year", "years"] },
    { family: "data", factor: 1, symbol: "B", names: ["b", "byte", "bytes"] },
    { family: "data", factor: 1e3, symbol: "kB", names: ["kb", "kilobyte", "kilobytes"] },
    { family: "data", factor: 1e6, symbol: "MB", names: ["mb", "megabyte", "megabytes"] },
    { family: "data", factor: 1e9, symbol: "GB", names: ["gb", "gigabyte", "gigabytes"] },
    { family: "data", factor: 1e12, symbol: "TB", names: ["tb", "terabyte", "terabytes"] },
    { family: "data", factor: 1024, symbol: "KiB", names: ["kib", "kibibyte", "kibibytes"] },
    { family: "data", factor: 1024 ** 2, symbol: "MiB", names: ["mib", "mebibyte", "mebibytes"] },
    { family: "data", factor: 1024 ** 3, symbol: "GiB", names: ["gib", "gibibyte", "gibibytes"] },
    { family: "data", factor: 1024 ** 4, symbol: "TiB", names: ["tib", "tebibyte", "tebibytes"] },
    { family: "speed", factor: 1, symbol: "m/s", names: ["m/s", "mps"] },
    { family: "speed", factor: 1 / 3.6, symbol: "km/h", names: ["km/h", "kmh", "kph"] },
    { family: "speed", factor: 0.44704, symbol: "mph", names: ["mph"] },
    { family: "speed", factor: 0.514444, symbol: "kn", names: ["kn", "kt", "knot", "knots"] },
    { family: "area", factor: 1, symbol: "m²", names: ["m2", "m²", "sqm", "square meter", "square meters"] },
    { family: "area", factor: 1e6, symbol: "km²", names: ["km2", "km²", "square kilometer", "square kilometers"] },
    { family: "area", factor: 10000, symbol: "ha", names: ["ha", "hectare", "hectares"] },
    { family: "area", factor: 4046.8564224, symbol: "acres", names: ["acre", "acres"] },
    { family: "area", factor: 0.09290304, symbol: "ft²", names: ["ft2", "ft²", "sqft", "square foot", "square feet"] },
]

// temperatures aren't a factor apart: to and from kelvin
const TEMPERATURES: Record<string, { symbol: string, toK: (v: number) => number, fromK: (k: number) => number }> = {
    c: { symbol: "°C", toK: v => v + 273.15, fromK: k => k - 273.15 },
    f: { symbol: "°F", toK: v => (v - 32) * 5 / 9 + 273.15, fromK: k => (k - 273.15) * 9 / 5 + 32 },
    k: { symbol: "K", toK: v => v, fromK: k => k },
}
const TEMPERATURE_NAMES: Record<string, string> = {
    c: "c", "°c": "c", celsius: "c", centigrade: "c",
    f: "f", "°f": "f", fahrenheit: "f",
    k: "k", kelvin: "k", kelvins: "k",
}

// what a unit alone is put into: the other system's nearest
const USUAL: Record<string, string> = {
    km: "mi", mi: "km", m: "ft", ft: "m", cm: "in", in: "cm", mm: "in", yd: "m",
    kg: "lb", lb: "kg", g: "oz", oz: "g", st: "kg",
    l: "gal", gal: "l", ml: "fl oz", "fl oz": "ml", cups: "ml", pt: "l",
    "km/h": "mph", mph: "km/h", kn: "km/h",
    "m²": "ft²", "ft²": "m²", ha: "acres", acres: "ha",
    "°C": "°F", "°F": "°C", K: "°C",
}

const bySymbol = new Map(UNITS.map(u => [u.symbol, u]))
// "MB" and "mb" alike; "m" and "M" alike, but "mi" is never "Mi"…
function unitNamed(name: string): Unit | null {
    const n = name.trim().toLowerCase()
    return UNITS.find(u => u.names.includes(n)) ?? null
}

const COMMA_DECIMAL = new Intl.NumberFormat().formatToParts(1.5).find(p => p.type === "decimal")?.value === ","
const number = (text: string) => parseFloat(COMMA_DECIMAL ? text.replace(",", ".") : text.replace(/,/g, ""))

const PATTERN = /^(-?\d[\d.,]*)\s*([^\d\s][^]*?)(?:\s+(?:to|in|into|as|=|->|→)\s+(.+))?$/i

export type Conversion = { name: string, detail: string, value: string }

/** The answer to "5 km in mi", "100 f" and the like, or null. */
export function convert(text: string): Conversion | null {
    const match = PATTERN.exec(text.trim())
    if (!match) return null
    const value = number(match[1])
    if (!isFinite(value)) return null
    const from = match[2].trim()
    const to = match[3]?.trim()

    const fromT = TEMPERATURE_NAMES[from.toLowerCase()]
    if (fromT) {
        const source = TEMPERATURES[fromT]
        const targetKey = to ? TEMPERATURE_NAMES[to.toLowerCase()]
            : Object.keys(TEMPERATURES).find(k => TEMPERATURES[k].symbol === USUAL[source.symbol])
        // a bare "5 k" or "3 c" is far likelier something else: only with a target,
        // or a degree sign or the word
        if (!targetKey || (!to && from.length === 1)) return null
        const target = TEMPERATURES[targetKey]
        const result = target.fromK(source.toK(value))
        return answer(value, source.symbol, result, target.symbol)
    }

    const source = unitNamed(from)
    if (!source) return null
    const target = to ? unitNamed(to) : bySymbol.get(USUAL[source.symbol]) ?? null
    if (!target || target.family !== source.family || target === source) return null
    // "5 m" alone, "3 s", "2 t": a single letter is too often the start of a word
    if (!to && from.length === 1) return null
    return answer(value, source.symbol, value * source.factor / target.factor, target.symbol)
}

function answer(value: number, from: string, result: number, to: string): Conversion {
    const shown = formatNumber(parseFloat(result.toPrecision(6)))
    return {
        name: `${shown} ${to}`,
        detail: `${formatNumber(value)} ${from} in ${to}`,
        value: shown,
    }
}
