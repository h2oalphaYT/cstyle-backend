import ApiError from '../../utils/ApiError.js';
import { Attendance, Employee, Holiday, LeaveBalance, LeaveRequest, LeaveType, OBSERVED } from '../models/index.js';
import { resolveSettings } from './settingsService.js';
import { assertRangeOpen, audit, eachDay, isValidDay, periodBounds, round2, weekday } from './util.js';

/** Working days a leave request consumes (weekly off days and holidays are skipped unless configured). */
export const leaveDays = async (employee, type, fromDate, toDate, halfDay) => {
    if (halfDay) return { days: 0.5, dates: [fromDate] };
    const settings = await resolveSettings(employee);
    const holidays = new Set((await Holiday.find({ date: { $gte: fromDate, $lte: toDate }, deletedAt: null, ...OBSERVED }).lean()).map(h => h.date));
    const dates = eachDay(fromDate, toDate).filter(d => type.countWeekends
        || (!(settings.weeklyOffDays || []).includes(weekday(d)) && !holidays.has(d)));
    return { days: dates.length, dates };
};

const entitlementFor = (employee, type) => {
    const override = employee.leaveEntitlements?.find(e => String(e.leaveType) === String(type._id));
    return override ? override.days : type.annualEntitlement;
};

/** Gets (creating if needed) the balance row for an employee, leave type and year. */
export const ensureBalance = async (employee, type, year) => {
    let bal = await LeaveBalance.findOne({ employee: employee._id, leaveType: type._id, year });
    if (!bal) {
        let opening = 0;
        if (type.carryForward) {
            const prev = await LeaveBalance.findOne({ employee: employee._id, leaveType: type._id, year: year - 1 });
            if (prev) opening = Math.max(0, Math.min(prev.remaining, type.maxCarryForward || prev.remaining));
        }
        bal = await LeaveBalance.create({ employee: employee._id, leaveType: type._id, year, opening, accrued: entitlementFor(employee, type) });
    }
    return bal;
};

const ACTIVE = ['pending', 'supervisor_approved', 'approved'];

/** Days of a leave request that must not be taken from the leave balance. Older requests have no split. */
export const balanceDays = (request) => (request.paidDays ?? request.days);

/**
 * Leave already requested or taken per calendar month, split into paid and no-pay days.
 * Returns Map("2026-10" → { paid, noPay, requests }).
 */
export const leaveByMonth = async (employee, months, { excludeId = null, settings = null } = {}) => {
    const out = new Map(months.map(m => [m, { paid: 0, noPay: 0, requests: 0 }]));
    if (!months.length) return out;
    const sorted = [...months].sort();
    const from = periodBounds(sorted[0]).start;
    const to = periodBounds(sorted[sorted.length - 1]).end;
    const requests = await LeaveRequest.find({
        employee: employee._id, deletedAt: null, status: { $in: ACTIVE }, fromDate: { $lte: to }, toDate: { $gte: from },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).populate('leaveType', 'paid countWeekends').lean();
    if (!requests.length) return out;
    const cfg = settings || await resolveSettings(employee);
    const offDays = cfg.weeklyOffDays || [];
    const holidays = new Set((await Holiday.find({ date: { $gte: from, $lte: to }, deletedAt: null, ...OBSERVED }).lean()).map(h => h.date));
    for (const r of requests) {
        const weight = r.halfDay ? 0.5 : 1;
        const dates = r.halfDay ? [r.fromDate] : eachDay(r.fromDate, r.toDate)
            .filter(d => r.leaveType?.countWeekends || (!offDays.includes(weekday(d)) && !holidays.has(d)));
        const counted = new Set();
        for (const d of dates) {
            const month = out.get(d.slice(0, 7));
            if (!month) continue;
            const unpaid = r.leaveType?.paid === false || (r.noPayDates || []).includes(d);
            month[unpaid ? 'noPay' : 'paid'] += weight;
            if (!counted.has(d.slice(0, 7))) { month.requests += 1; counted.add(d.slice(0, 7)); }
        }
    }
    for (const m of out.values()) { m.paid = round2(m.paid); m.noPay = round2(m.noPay); }
    return out;
};

/**
 * Works out how a leave request would be paid before it is saved:
 *   - an unpaid leave type (e.g. No Pay Leave) is no-pay for every day;
 *   - days beyond the remaining balance are no-pay (setting excessLeaveAsNoPay) unless allowLeaveBeyondBalance;
 *   - with monthlyPaidLeaveLimit, paid days beyond that many per calendar month are no-pay.
 * Also returns the employee's leave count for each month the request touches, so the screen can show it.
 */
export const leavePreview = async (employee, type, { fromDate, toDate, halfDay = false, excludeId = null }) => {
    const settings = await resolveSettings(employee);
    const { days, dates } = await leaveDays(employee, type, fromDate, toDate, halfDay);
    const weight = halfDay ? 0.5 : 1;
    const months = [...new Set([fromDate.slice(0, 7), ...dates.map(d => d.slice(0, 7))])].sort();
    const usage = await leaveByMonth(employee, months, { excludeId, settings });
    const limit = Number(settings.monthlyPaidLeaveLimit) || 0;

    let balance = null;
    if (type.trackBalance) {
        const b = await ensureBalance(employee, type, Number(fromDate.slice(0, 4)));
        balance = { year: b.year, entitled: round2(b.opening + b.accrued + b.adjusted), used: b.used, pending: b.pending, remaining: b.remaining };
    }
    const paidBeyondBalance = Boolean(settings.allowLeaveBeyondBalance || type.allowNegativeBalance);
    let paidLeft = balance && !paidBeyondBalance ? Math.max(0, balance.remaining) : Infinity;

    const noPayDates = [];
    const reasons = new Set();
    const added = new Map(months.map(m => [m, { paid: 0, noPay: 0 }]));
    for (const d of dates) {
        const month = d.slice(0, 7);
        const thisMonth = added.get(month);
        let why = null;
        if (!type.paid) why = `${type.name} is unpaid`;
        else if (paidLeft < weight) why = balance ? `only ${balance.remaining} day(s) of ${type.name} left` : 'no balance left';
        else if (limit && usage.get(month).paid + thisMonth.paid + weight > limit) why = `more than ${limit} paid leave day(s) in ${month}`;
        if (why) {
            noPayDates.push(d);
            reasons.add(why);
            thisMonth.noPay += weight;
        } else {
            paidLeft -= weight;
            thisMonth.paid += weight;
        }
    }
    const noPayDays = round2(noPayDates.length * weight);
    const beyondBalance = [...reasons].some(r => r.includes('left'));
    return {
        days,
        dates,
        paidDays: round2(days - noPayDays),
        noPayDays,
        noPayDates,
        noPay: noPayDays > 0,
        noPayReason: [...reasons].join('; '),
        refused: beyondBalance && !settings.excessLeaveAsNoPay
            ? `Not enough ${type.name} balance: ${balance?.remaining ?? 0} day(s) available, ${days} requested` : null,
        leaveType: { id: type._id, name: type.name, code: type.code, paid: type.paid },
        balance,
        monthlyLimit: limit,
        months: months.map(m => {
            const before = usage.get(m);
            const add = added.get(m);
            return {
                month: m,
                before: { paid: before.paid, noPay: before.noPay, total: round2(before.paid + before.noPay), requests: before.requests },
                thisRequest: { paid: round2(add.paid), noPay: round2(add.noPay) },
                after: { paid: round2(before.paid + add.paid), noPay: round2(before.noPay + add.noPay), total: round2(before.paid + before.noPay + add.paid + add.noPay) },
            };
        }),
    };
};

export const createLeaveRequest = async (req, body) => {
    const { employee: employeeId, leaveType: typeId, fromDate, toDate, halfDay = false, reason = '' } = body;
    if (!isValidDay(fromDate) || !isValidDay(toDate)) throw ApiError.unprocessable('Invalid leave dates');
    if (toDate < fromDate) throw ApiError.unprocessable('Leave end date is before the start date');
    if (halfDay && fromDate !== toDate) throw ApiError.unprocessable('A half-day leave must start and end on the same day');
    await assertRangeOpen(fromDate, toDate, 'Leave');

    const employee = await Employee.findOne({ _id: employeeId, deletedAt: null }).lean();
    if (!employee) throw ApiError.notFound('Employee not found');
    const type = await LeaveType.findOne({ _id: typeId, active: true, deletedAt: null });
    if (!type) throw ApiError.notFound('Leave type not found');
    if (halfDay && !type.allowHalfDay) throw ApiError.unprocessable(`${type.name} cannot be taken as a half day`);

    const overlap = await LeaveRequest.findOne({
        employee: employee._id, deletedAt: null, status: { $in: ['pending', 'supervisor_approved', 'approved'] },
        fromDate: { $lte: toDate }, toDate: { $gte: fromDate },
    });
    if (overlap) throw ApiError.conflict(`Overlaps an existing leave request (${overlap.fromDate} – ${overlap.toDate})`);

    const { days } = await leaveDays(employee, type, fromDate, toDate, halfDay);
    if (days <= 0) throw ApiError.unprocessable('The selected dates contain no working days');
    if (type.maxDaysPerRequest && days > type.maxDaysPerRequest) {
        throw ApiError.unprocessable(`${type.name} allows at most ${type.maxDaysPerRequest} day(s) per request`);
    }
    const docsNeeded = type.documentRequired && days > (type.documentRequiredAfterDays || 0);
    if (docsNeeded && !(body.documents || []).length) {
        throw ApiError.unprocessable(`${type.name} requires a supporting document`);
    }

    const preview = await leavePreview(employee, type, { fromDate, toDate, halfDay });
    if (preview.refused) throw ApiError.unprocessable(preview.refused);
    const balance = type.trackBalance ? await ensureBalance(employee, type, Number(fromDate.slice(0, 4))) : null;

    const needsApproval = type.approvalRequired;
    const request = await LeaveRequest.create({
        employee: employee._id, leaveType: type._id, fromDate, toDate, halfDay, days, reason,
        paidDays: preview.paidDays, noPayDays: preview.noPayDays, noPayDates: preview.noPayDates, noPayReason: preview.noPayReason,
        documents: body.documents || [],
        status: needsApproval ? 'pending' : 'approved',
        requestedBy: req.user._id, createdBy: req.user._id,
    });
    if (balance && preview.paidDays) {
        balance[needsApproval ? 'pending' : 'used'] += preview.paidDays;
        await balance.save();
    }
    if (!needsApproval) await applyApprovedLeave(req, request, type);
    await audit(req, { action: 'create', entity: 'LeaveRequest', after: request, label: `${employee.employeeCode} ${type.code} ${fromDate}` });
    return request;
};

/** Writes leave onto attendance so payroll sees paid / unpaid leave days. */
const applyApprovedLeave = async (req, request, type) => {
    const employee = await Employee.findById(request.employee).lean();
    const { dates } = await leaveDays(employee, type, request.fromDate, request.toDate, request.halfDay);
    for (const date of dates) {
        const existing = await Attendance.findOne({ employee: employee._id, date, deletedAt: null });
        const before = existing?.toObject() || null;
        const doc = existing || new Attendance({ employee: employee._id, date, createdBy: req.user._id });
        // A half-day leave keeps any worked hours and marks the day as half worked.
        doc.set({
            status: request.halfDay ? 'half_day' : 'leave',
            dayValue: request.halfDay ? 0.5 : 0,
            leaveRequest: request._id,
            leavePaid: type.paid && !(request.noPayDates || []).includes(date),
            source: existing ? existing.source : 'leave',
            remarks: `${type.name}${request.halfDay ? ' (half day)' : ''}${type.paid && (request.noPayDates || []).includes(date) ? ' — no-pay' : ''}`,
            updatedBy: req.user._id,
        });
        await doc.save();
        await audit(req, { action: existing ? 'update' : 'create', entity: 'Attendance', before, after: doc, label: `${employee.employeeCode} ${date}`, note: 'Approved leave' });
    }
};

export const decideLeave = async (req, request, { decision, note = '', level }) => {
    if (!['pending', 'supervisor_approved'].includes(request.status)) throw ApiError.conflict(`This request is already ${request.status}`);
    await assertRangeOpen(request.fromDate, request.toDate, 'Leave');
    const type = await LeaveType.findById(request.leaveType);
    const employee = await Employee.findById(request.employee).lean();
    const balance = type.trackBalance ? await ensureBalance(employee, type, Number(request.fromDate.slice(0, 4))) : null;
    const before = request.toObject();

    request.approvals.push({ level, decision, by: req.user._id, note });
    if (decision === 'rejected') {
        request.status = 'rejected';
        if (balance) { balance.pending = Math.max(0, balance.pending - balanceDays(request)); await balance.save(); }
    } else if (level === 'supervisor' && type.supervisorApproval && request.status === 'pending') {
        request.status = 'supervisor_approved';
    } else {
        request.status = 'approved';
        if (balance) {
            balance.pending = Math.max(0, balance.pending - balanceDays(request));
            balance.used += balanceDays(request);
            await balance.save();
        }
        await applyApprovedLeave(req, request, type);
    }
    request.updatedBy = req.user._id;
    await request.save();
    await audit(req, { action: decision === 'rejected' ? 'reject' : 'approve', entity: 'LeaveRequest', before, after: request, label: `${employee.employeeCode} ${type.code}`, note });
    return request;
};

export const cancelLeave = async (req, request, note = '') => {
    if (['rejected', 'cancelled'].includes(request.status)) throw ApiError.conflict(`This request is already ${request.status}`);
    await assertRangeOpen(request.fromDate, request.toDate, 'Leave');
    const type = await LeaveType.findById(request.leaveType);
    const employee = await Employee.findById(request.employee).lean();
    const before = request.toObject();
    if (type.trackBalance) {
        const balance = await ensureBalance(employee, type, Number(request.fromDate.slice(0, 4)));
        if (request.status === 'approved') balance.used = Math.max(0, balance.used - balanceDays(request));
        else balance.pending = Math.max(0, balance.pending - balanceDays(request));
        await balance.save();
    }
    if (request.status === 'approved') {
        const rows = await Attendance.find({ leaveRequest: request._id, deletedAt: null });
        for (const row of rows) {
            const prev = row.toObject();
            if (row.checkIn) {
                row.set({ leaveRequest: null, leavePaid: null, status: 'present', dayValue: 1, remarks: '' });
            } else {
                row.deletedAt = new Date();
            }
            row.updatedBy = req.user._id;
            await row.save();
            await audit(req, { action: 'update', entity: 'Attendance', before: prev, after: row, label: `${employee.employeeCode} ${row.date}`, note: 'Leave cancelled' });
        }
    }
    request.status = 'cancelled';
    request.approvals.push({ level: 'hr', decision: 'rejected', by: req.user._id, note: note || 'Cancelled' });
    await request.save();
    await audit(req, { action: 'cancel', entity: 'LeaveRequest', before, after: request, label: `${employee.employeeCode} ${type.code}`, note });
    return request;
};
