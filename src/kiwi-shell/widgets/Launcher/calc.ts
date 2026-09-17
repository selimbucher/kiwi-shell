// A calculator for the launcher's search box: the one thing every launcher
// grows first, because the alternative is opening an app to add two numbers.
//
// Hand-parsed rather than handed to a JS eval: the entry is a text field the
// user types anything into, and `new Function(text)` on that is a shell.

type Token = { kind: "num", value: number }
    | { kind: "name", value: string }
    | { kind: "op", value: string }

const CONSTANTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
}

const FUNCTIONS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
    ceil: Math.ceil, ln: Math.log, log: Math.log10, log2: Math.log2,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp,
}

// binding power per operator; ^ is the only right-associative one
const BINARY: Record<string, { power: number, right?: boolean, apply: (a: number, b: number) => number }> = {
    "+": { power: 1, apply: (a, b) => a + b },
    "-": { power: 1, apply: (a, b) => a - b },
    "*": { power: 2, apply: (a, b) => a * b },
    "/": { power: 2, apply: (a, b) => a / b },
    "%": { power: 2, apply: (a, b) => a % b },
    "^": { power: 3, right: true, apply: (a, b) => a ** b },
}

function tokenize(text: string): Token[] | null {
    const tokens: Token[] = []
    let i = 0
    while (i < text.length) {
        const c = text[i]
        if (c === " ") { i++; continue }
        if (/[\d.]/.test(c)) {
            // thousands separators belong to the number, not between numbers:
            // skipping them in this loop splits "1,234" into 1 and 234
            const match = /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
            if (!match || !match[0]) return null
            tokens.push({ kind: "num", value: parseFloat(match[0].replace(/,/g, "")) })
            i += match[0].length
            continue
        }
        if (/[a-zA-Z]/.test(c)) {
            const match = /^[a-zA-Z][a-zA-Z0-9]*/.exec(text.slice(i))!
            tokens.push({ kind: "name", value: match[0].toLowerCase() })
            i += match[0].length
            continue
        }
        if ("+-*/%^()".includes(c)) {
            tokens.push({ kind: "op", value: c })
            i++
            continue
        }
        // × and ÷ as typed on a numeric keypad layout
        if (c === "×") { tokens.push({ kind: "op", value: "*" }); i++; continue }
        if (c === "÷") { tokens.push({ kind: "op", value: "/" }); i++; continue }
        return null
    }
    return tokens
}

function parse(tokens: Token[]): number | null {
    let at = 0
    const peek = () => tokens[at]

    function primary(): number | null {
        const token = peek()
        if (!token) return null
        if (token.kind === "num") { at++; return token.value }
        if (token.kind === "op" && token.value === "-") { at++; const v = primary(); return v === null ? null : -v }
        if (token.kind === "op" && token.value === "+") { at++; return primary() }
        if (token.kind === "op" && token.value === "(") {
            at++
            const value = expression(0)
            const close = peek()
            if (value === null || !close || close.kind !== "op" || close.value !== ")") return null
            at++
            return value
        }
        if (token.kind === "name") {
            at++
            if (token.value in CONSTANTS) return CONSTANTS[token.value]
            const fn = FUNCTIONS[token.value]
            if (!fn) return null
            const argument = primary()
            return argument === null ? null : fn(argument)
        }
        return null
    }

    function expression(minPower: number): number | null {
        let left = primary()
        if (left === null) return null
        for (;;) {
            const token = peek()
            if (!token || token.kind !== "op") break
            const op = BINARY[token.value]
            if (!op || op.power < minPower) break
            at++
            const right = expression(op.right ? op.power : op.power + 1)
            if (right === null) return null
            left = op.apply(left, right)
        }
        return left
    }

    const value = expression(0)
    return value !== null && at === tokens.length ? value : null
}

// Trailing binary operators are how a half-typed sum looks ("12 *"), and a
// bare number is not a calculation worth showing a row for.
function worthEvaluating(text: string): boolean {
    if (!/[-+*/%^×÷]|sqrt|log|ln|sin|cos|tan|abs|round|floor|ceil|exp/i.test(text)) return false
    return /[\d)pie]$/i.test(text.trim())
}

/** The value of `text` as arithmetic, or null when it is not a sum. */
export function evaluate(text: string): number | null {
    const trimmed = text.trim().replace(/^=/, "").trim()
    if (!trimmed || !worthEvaluating(trimmed)) return null
    const tokens = tokenize(trimmed)
    if (!tokens || tokens.length === 0) return null
    const value = parse(tokens)
    return value === null || !isFinite(value) ? null : value
}

/** Enough digits to be exact, without 0.30000000000000004. */
export function formatNumber(value: number): string {
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString("en-US")
    const rounded = parseFloat(value.toPrecision(12))
    if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)) {
        return rounded.toExponential(6).replace(/\.?0+e/, "e")
    }
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 10 })
}
