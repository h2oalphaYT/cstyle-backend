import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { AuditLog, PayrollPeriod } from '../models/index.js';

// All HR dates are calendar days in the organisation's local time zone.
const TZ = process.env.HR_TZ_OFFSET || '+05:30';
const tzMinutes = (() => {
    const m = TZ.match(/^([+-])(\d{2}):(\d{2})$/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 330;
})();

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidDay = (s) => DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** "2026-10-05" + "08:30" → Date at that local time. */
export const toDateTime = (day, time) => new Date(`${day}T${time}:00${TZ}`);

/** Date → local "YYYY-MM-DD" */
export const localDay = (d) => new Date(new Date(d).getTime() + tzMinutes * 60000).toISOString().slice(0, 10);
/** Date → local "HH:mm" */
export const localTime = (d) => (d ? new Date(new Date(d).getTime() + tzMinutes * 60000).toISOString().slice(11, 16) : '');

export const today = () => localDay(new Date());

export const addDays = (day, n) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export const eachDay = (from, to) => {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
};

export const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

export const periodBounds = (code) => {
    const [y, m] = code.split('-').map(Number);
    const start = `${code}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { start, end };
};

export const periodOf = (day) => day.slice(0, 7);

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Runs fn inside a MongoDB transaction when the server supports it (replica set / Atlas). */
let txSupported;
export const withTransaction = async (fn) => {
    if (txSupported === undefined) {
        try {
            const hello = await mongoose.connection.db.admin().command({ hello: 1 });
            txSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
        } catch {
            txSupported = false;
        }
    }
    if (!txSupported) return fn(null);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => { result = await fn(session); });
        return result;
    } finally {
        await session.endSession();
    }
};

// ── Audit ───────────────────────────────────────────────────────────
const SENSITIVE = new Set(['passwordHash', 'apiKeyHash', 'tokenVersion', '__v', 'updatedAt', 'createdAt', 'updatedBy', 'createdBy']);

const plain = (doc) => {
    if (!doc) return null;
    const obj = typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true, virtuals: false }) : { ...doc };
    for (const k of SENSITIVE) delete obj[k];
    return JSON.parse(JSON.stringify(obj));
};

const diff = (before, after, prefix = '') => {
    const changes = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of keys) {
        if (SENSITIVE.has(k) || k === '_id' || k === 'id') continue;
        const a = before?.[k];
        const b = after?.[k];
        const path = prefix ? `${prefix}.${k}` : k;
        if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
            changes.push(...diff(a, b, path));
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            changes.push({ field: path, from: a ?? null, to: b ?? null });
        }
    }
    return changes;
};

/**
 * Writes an audit record. Pass the documents before/after a change; the field-level diff is stored
 * so "who changed the bank account / salary / attendance" is answerable later.
 */
export const audit = async (req, { action, entity, record, before = null, after = null, label = '', note = '', session = null }) => {
    const oldValue = plain(before);
    const newValue = plain(after);
    await AuditLog.create([{
        user: req?.user?._id || null,
        userName: req?.user?.name || 'system',
        action,
        entity,
        recordId: record?._id || after?._id || before?._id || null,
        label,
        oldValue,
        newValue,
        changes: oldValue && newValue ? diff(oldValue, newValue) : [],
        ip: req?.ip || '',
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 200),
        note,
    }], session ? { session } : undefined);
};

// ── Period locking ──────────────────────────────────────────────────
/**
 * Throws if the day falls in a finalized or locked payroll period. Attendance, overtime, leave,
 * salary and one-off entries all call this before changing data.
 */
export const assertPeriodOpen = async (dayOrPeriod, what = 'This record') => {
    const code = dayOrPeriod.length === 7 ? dayOrPeriod : periodOf(dayOrPeriod);
    const period = await PayrollPeriod.findOne({ code, deletedAt: null }).lean();
    if (period && ['finalized', 'locked'].includes(period.status)) {
        throw ApiError.conflict(`${what} falls in payroll period ${code}, which is ${period.status}. Use a payroll adjustment instead.`);
    }
};

export const assertRangeOpen = async (from, to, what) => {
    const codes = [...new Set(eachDay(from, to).map(periodOf))];
    for (const c of codes) await assertPeriodOpen(c, what);
};

export const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));

export const notDeleted = { deletedAt: null };

/**
 * Throws if the employee's payroll for the day's period is already finalized (even when other
 * departments of the same period are still being processed).
 */
export const assertEmployeePeriodOpen = async (employeeId, dayOrPeriod, what = 'This record') => {
    await assertPeriodOpen(dayOrPeriod, what);
    const code = dayOrPeriod.length === 7 ? dayOrPeriod : periodOf(dayOrPeriod);
    const { PayrollRunEmployee, PayrollRun } = await import('../models/index.js');
    const lines = await PayrollRunEmployee.find({ employee: employeeId, periodCode: code, status: 'active' }).select('run').lean();
    if (!lines.length) return;
    const finalized = await PayrollRun.findOne({ _id: { $in: lines.map(l => l.run) }, status: { $in: ['approved', 'finalized', 'paid'] } }).lean();
    if (finalized) {
        throw ApiError.conflict(`${what} is in payroll ${finalized.runNumber}, which is ${finalized.status}. ${finalized.status === 'approved' ? 'Send the payroll back for changes first.' : 'Use a payroll adjustment instead.'}`);
    }
};
