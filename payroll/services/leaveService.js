import ApiError from '../../utils/ApiError.js';
import { Attendance, Employee, Holiday, LeaveBalance, LeaveRequest, LeaveType } from '../models/index.js';
import { resolveSettings } from './settingsService.js';
import { assertRangeOpen, audit, eachDay, isValidDay, weekday } from './util.js';

/** Working days a leave request consumes (weekly off days and holidays are skipped unless configured). */
export const leaveDays = async (employee, type, fromDate, toDate, halfDay) => {
    if (halfDay) return { days: 0.5, dates: [fromDate] };
    const settings = await resolveSettings(employee);
    const holidays = new Set((await Holiday.find({ date: { $gte: fromDate, $lte: toDate }, deletedAt: null }).lean()).map(h => h.date));
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

    let balance = null;
    if (type.trackBalance) {
        const settings = await resolveSettings(employee);
        balance = await ensureBalance(employee, type, Number(fromDate.slice(0, 4)));
        if (days > balance.remaining && !type.allowNegativeBalance && !settings.allowLeaveBeyondBalance) {
            throw ApiError.unprocessable(`Not enough ${type.name} balance: ${balance.remaining} day(s) available, ${days} requested`);
        }
    }

    const needsApproval = type.approvalRequired;
    const request = await LeaveRequest.create({
        employee: employee._id, leaveType: type._id, fromDate, toDate, halfDay, days, reason,
        documents: body.documents || [],
        status: needsApproval ? 'pending' : 'approved',
        requestedBy: req.user._id, createdBy: req.user._id,
    });
    if (balance) {
        balance[needsApproval ? 'pending' : 'used'] += days;
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
            leavePaid: type.paid,
            source: existing ? existing.source : 'leave',
            remarks: `${type.name}${request.halfDay ? ' (half day)' : ''}`,
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
        if (balance) { balance.pending = Math.max(0, balance.pending - request.days); await balance.save(); }
    } else if (level === 'supervisor' && type.supervisorApproval && request.status === 'pending') {
        request.status = 'supervisor_approved';
    } else {
        request.status = 'approved';
        if (balance) {
            balance.pending = Math.max(0, balance.pending - request.days);
            balance.used += request.days;
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
        if (request.status === 'approved') balance.used = Math.max(0, balance.used - request.days);
        else balance.pending = Math.max(0, balance.pending - request.days);
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
