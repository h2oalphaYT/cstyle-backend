/**
 * Safe payroll formula engine.
 *
 * Formulas are parsed into an AST by a small hand-written parser and evaluated by walking the tree.
 * Nothing from the database is ever passed to eval/Function. Only numbers, known variables,
 * arithmetic/comparison/logical operators, the ternary operator and a whitelist of functions are allowed.
 *
 *   BasicSalary / WorkingDays
 *   OTHours * OTRate
 *   max(0, AbsentDays - 1) * DailyRate
 *   if(LateCount > 3, 1000, 0)
 *   slab(TaxableGross, "APIT")         // progressive table lookup (TaxTable collection)
 */

export class FormulaError extends Error {
    constructor(message, position) {
        super(message);
        this.position = position;
    }
}

const MAX_LENGTH = 1000;
const MAX_DEPTH = 60;

// ── Tokenizer ────────────────────────────────────────────────────────
const tokenize = (input) => {
    if (typeof input !== 'string') throw new FormulaError('Formula must be text');
    if (input.length > MAX_LENGTH) throw new FormulaError(`Formula is longer than ${MAX_LENGTH} characters`);
    const tokens = [];
    let i = 0;
    const two = ['<=', '>=', '==', '!=', '&&', '||'];
    while (i < input.length) {
        const ch = input[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        if (/[0-9.]/.test(ch)) {
            const m = input.slice(i).match(/^(\d+(\.\d+)?|\.\d+)/);
            if (!m) throw new FormulaError(`Invalid number at position ${i + 1}`, i);
            tokens.push({ t: 'num', v: Number(m[0]), p: i });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const m = input.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
            tokens.push({ t: 'id', v: m[0], p: i });
            i += m[0].length;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const end = input.indexOf(ch, i + 1);
            if (end < 0) throw new FormulaError('Unclosed text value', i);
            const text = input.slice(i + 1, end);
            if (!/^[A-Za-z0-9_ -]{0,40}$/.test(text)) throw new FormulaError('Text values may only contain letters, numbers, spaces, - and _', i);
            tokens.push({ t: 'str', v: text, p: i });
            i = end + 1;
            continue;
        }
        const pair = input.slice(i, i + 2);
        if (two.includes(pair)) { tokens.push({ t: 'op', v: pair, p: i }); i += 2; continue; }
        if ('+-*/%()<>,?:!'.includes(ch)) { tokens.push({ t: 'op', v: ch, p: i }); i += 1; continue; }
        throw new FormulaError(`Unexpected character "${ch}" at position ${i + 1}`, i);
    }
    tokens.push({ t: 'eof', p: input.length });
    return tokens;
};

// ── Parser (precedence climbing) ─────────────────────────────────────
// ternary < || < && < equality < comparison < additive < multiplicative < unary < primary
export const parse = (input) => {
    const tokens = tokenize(input);
    let pos = 0;
    let depth = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expectOp = (v) => {
        const tok = next();
        if (tok.t !== 'op' || tok.v !== v) throw new FormulaError(`Expected "${v}" at position ${tok.p + 1}`, tok.p);
    };
    const isOp = (...vs) => peek().t === 'op' && vs.includes(peek().v);

    const binary = (sub, ops) => () => {
        let left = sub();
        while (isOp(...ops)) {
            const op = next().v;
            left = { type: 'bin', op, left, right: sub() };
        }
        return left;
    };

    let ternary;
    const primary = () => {
        depth += 1;
        if (depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply');
        const tok = next();
        let node;
        if (tok.t === 'num') node = { type: 'num', value: tok.v };
        else if (tok.t === 'str') node = { type: 'str', value: tok.v };
        else if (tok.t === 'id') {
            if (isOp('(')) {
                next();
                const args = [];
                if (!isOp(')')) {
                    do { args.push(ternary()); } while (isOp(',') && next());
                }
                expectOp(')');
                node = { type: 'call', name: tok.v.toLowerCase(), args, pos: tok.p };
            } else {
                node = { type: 'var', name: tok.v, pos: tok.p };
            }
        } else if (tok.t === 'op' && tok.v === '(') {
            node = ternary();
            expectOp(')');
        } else {
            throw new FormulaError(tok.t === 'eof' ? 'Formula ended unexpectedly' : `Unexpected "${tok.v}" at position ${tok.p + 1}`, tok.p);
        }
        depth -= 1;
        return node;
    };
    const unary = () => {
        if (isOp('-', '+', '!')) {
            const op = next().v;
            return { type: 'unary', op, arg: unary() };
        }
        return primary();
    };
    const mul = binary(unary, ['*', '/', '%']);
    const add = binary(mul, ['+', '-']);
    const cmp = binary(add, ['<', '>', '<=', '>=']);
    const eq = binary(cmp, ['==', '!=']);
    const and = binary(eq, ['&&']);
    const or = binary(and, ['||']);
    ternary = () => {
        const cond = or();
        if (isOp('?')) {
            next();
            const a = ternary();
            expectOp(':');
            const b = ternary();
            return { type: 'if', cond, a, b };
        }
        return cond;
    };

    const ast = ternary();
    if (peek().t !== 'eof') throw new FormulaError(`Unexpected "${peek().v}" at position ${peek().p + 1}`, peek().p);
    return ast;
};

// ── Evaluation ───────────────────────────────────────────────────────
const round = (n, d = 2) => {
    const f = 10 ** d;
    return Math.round((n + Number.EPSILON) * f) / f;
};

const progressive = (amount, brackets) => {
    let tax = 0;
    for (const b of brackets) {
        const upper = b.to == null ? Infinity : b.to;
        if (amount > b.from) tax += (Math.min(amount, upper) - b.from) * (b.rate / 100);
    }
    return tax;
};

const FUNCTIONS = {
    min: { min: 1, max: 20, fn: (...a) => Math.min(...a) },
    max: { min: 1, max: 20, fn: (...a) => Math.max(...a) },
    round: { min: 1, max: 2, fn: (x, d = 0) => round(x, d) },
    floor: { min: 1, max: 1, fn: Math.floor },
    ceil: { min: 1, max: 1, fn: Math.ceil },
    abs: { min: 1, max: 1, fn: Math.abs },
    if: { min: 3, max: 3, lazy: true },
    // slab(amount, "TABLE") — progressive tax/contribution table defined in the TaxTable collection.
    slab: { min: 2, max: 2, table: true },
};

export const ALLOWED_FUNCTIONS = Object.keys(FUNCTIONS);

/** Variables a formula refers to (used for validation and dependency checks). */
export const collectVariables = (ast, out = new Set()) => {
    if (!ast) return out;
    if (ast.type === 'var') out.add(ast.name);
    ['left', 'right', 'arg', 'cond', 'a', 'b'].forEach(k => ast[k] && collectVariables(ast[k], out));
    (ast.args || []).forEach(a => collectVariables(a, out));
    return out;
};

const evaluateAst = (ast, ctx) => {
    switch (ast.type) {
        case 'num': return ast.value;
        case 'str': return ast.value;
        case 'var': {
            if (!Object.prototype.hasOwnProperty.call(ctx.variables, ast.name)) {
                throw new FormulaError(`Unknown variable "${ast.name}"`, ast.pos);
            }
            const v = Number(ctx.variables[ast.name]);
            ctx.used[ast.name] = v;
            return Number.isFinite(v) ? v : 0;
        }
        case 'unary': {
            const v = evaluateAst(ast.arg, ctx);
            if (ast.op === '-') return -v;
            if (ast.op === '!') return v ? 0 : 1;
            return +v;
        }
        case 'bin': {
            const l = evaluateAst(ast.left, ctx);
            if (ast.op === '&&') return l ? (evaluateAst(ast.right, ctx) ? 1 : 0) : 0;
            if (ast.op === '||') return l ? 1 : (evaluateAst(ast.right, ctx) ? 1 : 0);
            const r = evaluateAst(ast.right, ctx);
            switch (ast.op) {
                case '+': return l + r;
                case '-': return l - r;
                case '*': return l * r;
                case '/': return r === 0 ? 0 : l / r; // division by zero yields 0 (e.g. no working days)
                case '%': return r === 0 ? 0 : l % r;
                case '<': return l < r ? 1 : 0;
                case '>': return l > r ? 1 : 0;
                case '<=': return l <= r ? 1 : 0;
                case '>=': return l >= r ? 1 : 0;
                case '==': return l === r ? 1 : 0;
                case '!=': return l !== r ? 1 : 0;
                default: throw new FormulaError(`Unsupported operator ${ast.op}`);
            }
        }
        case 'if': return evaluateAst(ast.cond, ctx) ? evaluateAst(ast.a, ctx) : evaluateAst(ast.b, ctx);
        case 'call': {
            const def = FUNCTIONS[ast.name];
            if (!def) throw new FormulaError(`Unknown function "${ast.name}". Allowed: ${ALLOWED_FUNCTIONS.join(', ')}`, ast.pos);
            if (ast.args.length < def.min || ast.args.length > def.max) {
                throw new FormulaError(`${ast.name}() takes ${def.min === def.max ? def.min : `${def.min}–${def.max}`} argument(s)`, ast.pos);
            }
            if (def.lazy) return evaluateAst(ast.args[0], ctx) ? evaluateAst(ast.args[1], ctx) : evaluateAst(ast.args[2], ctx);
            if (def.table) {
                const amount = evaluateAst(ast.args[0], ctx);
                const code = String(evaluateAst(ast.args[1], ctx)).toUpperCase();
                const table = ctx.tables?.[code];
                if (!table) throw new FormulaError(`Tax table "${code}" not found or inactive`, ast.pos);
                return progressive(amount, table.brackets);
            }
            const args = ast.args.map(a => evaluateAst(a, ctx));
            if (args.some(a => typeof a !== 'number')) throw new FormulaError(`${ast.name}() needs numbers`, ast.pos);
            return def.fn(...args);
        }
        default: throw new FormulaError('Invalid formula');
    }
};

const parseCache = new Map();
const parseCached = (formula) => {
    if (!parseCache.has(formula)) {
        if (parseCache.size > 2000) parseCache.clear();
        parseCache.set(formula, parse(formula));
    }
    return parseCache.get(formula);
};

/**
 * Evaluates a formula. Returns { value, used, expression } where used holds the variables the
 * formula read and expression is the formula with those values substituted, for audit display.
 */
export const evaluate = (formula, variables = {}, { tables = {} } = {}) => {
    const ast = parseCached(String(formula).trim());
    const ctx = { variables, used: {}, tables };
    const raw = evaluateAst(ast, ctx);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new FormulaError('Formula did not produce a number');
    const expression = String(formula).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => (
        Object.prototype.hasOwnProperty.call(ctx.used, name) ? String(round(ctx.used[name], 4)) : name));
    return { value: raw, used: ctx.used, expression };
};

/** Checks a formula against the variables that will exist at calculation time. */
export const validateFormula = (formula, allowedVariables) => {
    try {
        const ast = parse(String(formula || '').trim());
        const unknown = [...collectVariables(ast)].filter(v => !allowedVariables.includes(v));
        if (unknown.length) return { ok: false, error: `Unknown variable(s): ${unknown.join(', ')}` };
        return { ok: true, variables: [...collectVariables(ast)] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
};

export { round };
