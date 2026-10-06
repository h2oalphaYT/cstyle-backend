import ApiError from '../../utils/ApiError.js';
import { Attendance, Employee, Holiday, OvertimeEntry, OvertimeType } from '../models/index.js';
import { resolveSettings } from './settingsService.js';
import { assertEmployeePeriodOpen, audit, isValidDay, localTime, round2, TIME_RE, toDateTime, weekday } from './util.js';

const WORKED_STATUSES = ['present', 'late', 'early_leave', 'half_day', 'remote'];

const minutesOf = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

export const isHoliday = async (day, employee) => {
    const holidays = await Holiday.find({ date: day, deletedAt: null }).lean();
    return holidays.find(h => !h.orgUnits?.length || h.orgUnits.some(u => [employee?.branch, employee?.hub, employee?.company, employee?.location]
        .filter(Boolean).map(String).includes(String(u)))) || null;
};

/**
 * Derives worked / normal / OT hours, late and early-leave minutes and the final status from the
 * raw check-in/out times and the employee's settings. Explicit statuses (leave, absent...) are kept.
 */
export const computeAttendance = (input, settings, { holiday = null, offDay = false } = {}) => {
    const out = { ...input };
    const { date } = input;
    const checkIn = input.checkIn ? new Date(input.checkIn) : null;
    const checkOut = input.checkOut ? new Date(input.checkOut) : null;
    if (checkIn && checkOut && checkOut <= checkIn) throw ApiError.unprocessable('Check-out time must be after check-in time');

    out.missingCheckout = Boolean(checkIn && !checkOut);
    const hoursPerDay = Number(settings.workingHoursPerDay) || 8;
    const breakMinutes = input.breakMinutes ?? (checkIn && checkOut ? settings.defaultBreakMinutes : 0);
    out.breakMinutes = breakMinutes;

    if (checkIn && checkOut) {
        let minutes = (checkOut - checkIn) / 60000 - breakMinutes;
        const roundTo = Number(settings.attendanceRoundingMinutes) || 0;
        if (roundTo > 0) minutes = Math.floor(minutes / roundTo) * roundTo;
        const worked = Math.max(0, minutes) / 60;
        out.workedHours = round2(worked);
        out.normalHours = round2(Math.min(worked, hoursPerDay));
        // OT hours may be given explicitly (e.g. Excel); otherwise anything beyond the normal day.
        // On holidays and weekly off days every hour worked is overtime.
        const extra = holiday || offDay ? worked : Math.max(0, worked - hoursPerDay);
        if (holiday || offDay) out.normalHours = 0;
        out.otHours = input.otHours != null ? round2(input.otHours) : round2(extra * 60 >= (settings.otMinimumMinutes || 0) ? extra : 0);
    } else {
        out.workedHours = input.workedHours ?? 0;
        out.normalHours = input.normalHours ?? 0;
        out.otHours = input.otHours ?? 0;
    }

    out.lateMinutes = 0;
    out.earlyLeaveMinutes = 0;
    if (checkIn && settings.workdayStart && TIME_RE.test(settings.workdayStart)) {
        const late = minutesOf(localTime(checkIn)) - minutesOf(settings.workdayStart);
        if (late > (settings.lateGraceMinutes || 0)) out.lateMinutes = late;
    }
    if (checkOut && settings.workdayEnd && TIME_RE.test(settings.workdayEnd)) {
        const early = minutesOf(settings.workdayEnd) - minutesOf(localTime(checkOut));
        if (early > (settings.earlyLeaveGraceMinutes || 0)) out.earlyLeaveMinutes = early;
    }
    // Without clock times, late minutes may be given directly (e.g. monthly sheet totals).
    if (!checkIn && input.lateMinutes != null) out.lateMinutes = Math.max(0, Math.round(Number(input.lateMinutes) || 0));

    if (holiday || offDay) {
        out.lateMinutes = 0;
        out.earlyLeaveMinutes = 0;
    }

    // Status: keep explicit non-work statuses; otherwise derive.
    if (!input.status || WORKED_STATUSES.includes(input.status)) {
        if (!checkIn && !input.status) out.status = 'absent';
        else if (input.status === 'remote') out.status = 'remote';
        else if (input.status === 'half_day' || (out.workedHours > 0 && out.workedHours < (settings.halfDayMinHours || 4))) out.status = 'half_day';
        else if (out.lateMinutes > 0) out.status = 'late';
        else if (out.earlyLeaveMinutes > 0) out.status = 'early_leave';
        else out.status = input.status || 'present';
    }
    if (holiday && !checkIn && !input.status) out.status = 'holiday';
    out.dayValue = out.status === 'half_day' ? 0.5 : ['absent', 'off_day', 'holiday'].includes(out.status) ? 0 : 1;
    out.date = date;
    return out;
};

/** Picks the overtime type for a day: holiday → HOLIDAY, weekly off → WEEKEND, otherwise NORMAL. */
const otTypeFor = async (day, settings, holiday) => {
    const code = holiday ? 'HOLIDAY' : (settings.weeklyOffDays || []).includes(weekday(day)) ? 'WEEKEND' : 'NORMAL';
    return (await OvertimeType.findOne({ code, active: true, deletedAt: null }))
        || OvertimeType.findOne({ code: 'NORMAL', deletedAt: null });
};

/** Keeps the attendance-generated overtime entry in sync with the attendance record. */
const syncOvertime = async (req, attendance, settings, holiday) => {
    if (!settings.autoOvertimeFromAttendance) return;
    const existing = await OvertimeEntry.findOne({ attendance: attendance._id, source: { $in: ['attendance', 'excel', 'biometric'] }, deletedAt: null });
    if (!attendance.otHours) {
        if (existing && existing.status !== 'approved') {
            existing.deletedAt = new Date();
            await existing.save();
        }
        return;
    }
    if (existing?.status === 'approved' && existing.hours === attendance.otHours) return;
    const type = await otTypeFor(attendance.date, settings, holiday);
    if (!type) return;
    let hours = attendance.otHours;
    if (type.roundingMinutes > 0) hours = Math.floor((hours * 60) / type.roundingMinutes) * type.roundingMinutes / 60;
    if (hours * 60 < (type.minMinutes || 0)) hours = 0;
    const doc = existing || new OvertimeEntry({ employee: attendance.employee, date: attendance.date, attendance: attendance._id, createdBy: req?.user?._id });
    doc.set({
        overtimeType: type._id,
        hours: round2(hours),
        requestedHours: attendance.otHours,
        source: attendance.source === 'excel' ? 'excel' : attendance.source === 'fingerprint' ? 'biometric' : 'attendance',
        status: type.approvalRequired ? 'pending' : 'approved',
        updatedBy: req?.user?._id,
    });
    await doc.save();
};

/**
 * Creates or updates the attendance for one employee/day. Used by manual entry, Excel import and the
 * biometric processor so every path applies the same rules, locking and audit logging.
 */
export const upsertAttendance = async (req, payload, { overwrite = true, source } = {}) => {
    if (!isValidDay(payload.date)) throw ApiError.unprocessable('Invalid date');
    await assertEmployeePeriodOpen(payload.employee, payload.date, 'Attendance');
    const employee = await Employee.findOne({ _id: payload.employee, deletedAt: null }).lean();
    if (!employee) throw ApiError.notFound('Employee not found');

    const settings = await resolveSettings(employee);
    const holiday = await isHoliday(payload.date, employee);
    const toTime = (v) => (v instanceof Date ? v : v && TIME_RE.test(v) ? toDateTime(payload.date, v) : v ? new Date(v) : null);
    const offDay = (settings.weeklyOffDays || []).includes(weekday(payload.date));
    const computed = computeAttendance({
        ...payload,
        checkIn: toTime(payload.checkIn),
        checkOut: toTime(payload.checkOut),
    }, settings, { holiday, offDay });

    const existing = await Attendance.findOne({ employee: employee._id, date: payload.date, deletedAt: null });
    if (existing && !overwrite) throw ApiError.conflict(`Attendance for ${employee.employeeCode} on ${payload.date} already exists`);
    if (existing?.leaveRequest && computed.status !== 'leave' && source !== 'leave') {
        throw ApiError.conflict('This day is covered by an approved leave request. Cancel the leave first.');
    }

    const before = existing ? existing.toObject() : null;
    const doc = existing || new Attendance({ employee: employee._id, date: payload.date, createdBy: req?.user?._id });
    doc.set({
        checkIn: computed.checkIn || null,
        checkOut: computed.checkOut || null,
        breakMinutes: computed.breakMinutes || 0,
        workedHours: computed.workedHours || 0,
        normalHours: computed.normalHours || 0,
        otHours: computed.otHours || 0,
        lateMinutes: computed.lateMinutes || 0,
        earlyLeaveMinutes: computed.earlyLeaveMinutes || 0,
        status: computed.status,
        dayValue: computed.dayValue,
        missingCheckout: computed.missingCheckout,
        source: source || payload.source || 'manual',
        remarks: payload.remarks ?? doc.remarks ?? '',
        reason: payload.reason ?? '',
        leaveRequest: payload.leaveRequest ?? doc.leaveRequest ?? null,
        leavePaid: payload.leavePaid ?? doc.leavePaid ?? null,
        importBatch: payload.importBatch ?? null,
        updatedBy: req?.user?._id,
    });
    if (doc.source === 'manual' && req?.user) doc.approvedBy = req.user._id;
    await doc.save();
    await syncOvertime(req, doc, settings, holiday);
    await audit(req, {
        action: existing ? 'update' : 'create', entity: 'Attendance', before, after: doc,
        label: `${employee.employeeCode} ${payload.date}`, note: payload.reason || '',
    });
    return doc;
};
