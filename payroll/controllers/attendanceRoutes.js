import express from 'express';
import rateLimit from 'express-rate-limit';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, isObjectId, paginationMeta, parsePagination } from '../../utils/helpers.js';
import { optionalAuth, protect } from '../../middleware/auth.js';
import {
    Attendance, AttendanceEvent, BiometricDevice, Employee, ImportBatch, LeaveRequest, LeaveType, OvertimeEntry, OvertimeType,
} from '../models/index.js';
import { can, hasPermission, loadAccess } from '../permissions.js';
import { canSeeEmployee, scopeFilter } from '../services/scope.js';
import { upsertAttendance } from '../services/attendanceService.js';
import { cancelLeave, createLeaveRequest, decideLeave } from '../services/leaveService.js';
import { deviceFromKey, ingestEvents, processPendingEvents, syncDevice } from '../services/biometricService.js';
import { attendanceTemplate, readSheet, sendExport, validateAttendanceImport } from '../services/excelService.js';
import { hrUpload, saveHrFile, sendHrFile, spreadsheetUpload } from '../services/files.js';
import { commitMonthlySheet, revertMonthlySheet, validateMonthlySheet } from '../services/monthlySheet.js';
import { assertEmployeePeriodOpen, audit, isValidDay, localTime, round2, today } from '../services/util.js';

const router = express.Router();

// ── Attendance ──────────────────────────────────────────────────────
const attendanceQuery = async (req) => {
    const q = { deletedAt: null };
    if (req.query.from || req.query.to) q.date = { $gte: req.query.from || '0000-00-00', $lte: req.query.to || '9999-12-31' };
    if (req.query.date) q.date = req.query.date;
    for (const k of ['status', 'source']) if (req.query[k]) q[k] = req.query[k];
    if (req.query.employee) q.employee = req.query.employee;
    if (req.query.late === 'true') q.lateMinutes = { $gt: 0 };
    if (req.query.missingCheckout === 'true') q.missingCheckout = true;
    const orgFilter = {};
    for (const k of ['department', 'branch', 'hub', 'company', 'group']) if (req.query[k]) orgFilter[k] = req.query[k];
    if (Object.keys(orgFilter).length) {
        const ids = (await Employee.find({ ...orgFilter, deletedAt: null }).select('_id').lean()).map(e => e._id);
        q.employee = q.employee ? (ids.some(i => String(i) === String(q.employee)) ? q.employee : null) : { $in: ids };
    }
    return scopeFilter(req, q);
};

router.get('/attendance', protect, can('attendance.view'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 1000 });
    const q = await attendanceQuery(req);
    const [rows, total] = await Promise.all([
        Attendance.find(q).populate({ path: 'employee', select: 'fullName employeeCode department', populate: { path: 'department', select: 'name' } })
            .populate('updatedBy', 'name').sort({ date: -1, _id: 1 }).skip(skip).limit(limit).lean(),
        Attendance.countDocuments(q),
    ]);
    res.json({
        success: true,
        data: rows.map(r => ({ ...r, id: String(r._id), inTime: localTime(r.checkIn), outTime: localTime(r.checkOut) })),
        pagination: paginationMeta(page, limit, total),
    });
}));

router.get('/attendance/export', protect, can('attendance.view'), asyncHandler(async (req, res) => {
    const q = await attendanceQuery(req);
    const rows = await Attendance.find(q).populate('employee', 'fullName employeeCode').sort({ date: 1 }).limit(50000).lean();
    const data = rows.map(r => ({
        employeeCode: r.employee?.employeeCode, employeeName: r.employee?.fullName, date: r.date, in: localTime(r.checkIn), out: localTime(r.checkOut),
        worked: r.workedHours, ot: r.otHours, late: r.lateMinutes, status: r.status, source: r.source, remarks: r.remarks,
    }));
    await audit(req, { action: 'export', entity: 'Attendance', note: `${data.length} rows ${req.query.from || ''}–${req.query.to || ''}` });
    await sendExport(res, req.query.format || 'xlsx', 'Attendance', `${req.query.from || ''} to ${req.query.to || ''}`, [
        { key: 'employeeCode', header: 'Employee ID' }, { key: 'employeeName', header: 'Employee Name', width: 26 }, { key: 'date', header: 'Date' },
        { key: 'in', header: 'In' }, { key: 'out', header: 'Out' }, { key: 'worked', header: 'Worked Hours', type: 'number' },
        { key: 'ot', header: 'OT', type: 'number' }, { key: 'late', header: 'Late (min)', type: 'number' }, { key: 'status', header: 'Status' },
        { key: 'source', header: 'Source' }, { key: 'remarks', header: 'Remarks', width: 24 },
    ], data);
}));

/** Manual / office-sheet attendance entry (also used for corrections). A reason is required. */
router.post('/attendance', protect, can('attendance.edit'), asyncHandler(async (req, res) => {
    const { employee, date, inTime, outTime, status, breakMinutes, otHours, remarks, reason, source = 'manual' } = req.body || {};
    if (!isObjectId(employee) || !(await canSeeEmployee(req, employee))) throw ApiError.notFound('Employee not found');
    if (!isValidDay(date)) throw ApiError.unprocessable('Enter a valid date');
    if (date > today()) throw ApiError.unprocessable('Attendance cannot be recorded for a future date');
    if (!reason && source === 'manual') throw ApiError.unprocessable('Give a reason for the manual entry (e.g. "Signed attendance sheet")');
    if (!inTime && !status) throw ApiError.unprocessable('Give an in time or a status');
    const doc = await upsertAttendance(req, {
        employee, date, checkIn: inTime || null, checkOut: outTime || null, status: status || undefined,
        breakMinutes: breakMinutes === '' || breakMinutes == null ? undefined : Number(breakMinutes),
        otHours: otHours === '' || otHours == null ? undefined : Number(otHours), remarks, reason,
    }, { overwrite: req.body.overwrite !== false, source: ['manual', 'web', 'mobile'].includes(source) ? source : 'manual' });
    res.status(201).json({ success: true, message: 'Attendance saved', data: doc });
}));

router.delete('/attendance/:id', protect, can('attendance.edit'), asyncHandler(async (req, res) => {
    const doc = await Attendance.findOne({ _id: req.params.id, deletedAt: null });
    if (!doc || !(await canSeeEmployee(req, doc.employee))) throw ApiError.notFound('Attendance not found');
    if (doc.leaveRequest) throw ApiError.conflict('This day comes from an approved leave request; cancel the leave instead');
    await assertEmployeePeriodOpen(doc.employee, doc.date, 'Attendance');
    if (!req.body?.reason) throw ApiError.unprocessable('Give a reason for deleting attendance');
    const before = doc.toObject();
    doc.deletedAt = new Date();
    doc.updatedBy = req.user._id;
    await doc.save();
    await OvertimeEntry.updateMany({ attendance: doc._id, status: { $ne: 'approved' } }, { deletedAt: new Date() });
    await audit(req, { action: 'delete', entity: 'Attendance', before, label: doc.date, note: req.body.reason });
    res.json({ success: true, message: 'Attendance deleted' });
}));

/** Today's headcount for the dashboard and attendance screen. */
router.get('/attendance/today', protect, can('attendance.view', 'hr.dashboard.view'), asyncHandler(async (req, res) => {
    const day = req.query.date && isValidDay(req.query.date) ? req.query.date : today();
    const active = await Employee.countDocuments(await scopeFilter(req, { deletedAt: null, status: { $in: ['active', 'probation'] } }, '_id'));
    const rows = await Attendance.find(await scopeFilter(req, { date: day, deletedAt: null })).select('status lateMinutes').lean();
    const count = (s) => rows.filter(r => s.includes(r.status)).length;
    const present = count(['present', 'late', 'early_leave', 'half_day', 'remote']);
    res.json({
        success: true,
        data: {
            date: day, activeEmployees: active, present, late: rows.filter(r => r.lateMinutes > 0).length, onLeave: count(['leave']),
            absent: count(['absent']), notRecorded: Math.max(0, active - rows.length), recorded: rows.length,
        },
    });
}));

// ── Excel import ────────────────────────────────────────────────────
router.get('/attendance/import/template', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const buf = await attendanceTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-import-template.xlsx"');
    res.send(Buffer.from(buf));
}));

router.post('/attendance/import/validate', protect, can('attendance.import'), spreadsheetUpload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Upload the attendance file in the "file" field');
    let rows;
    try {
        rows = await readSheet(req.file.buffer, req.file.originalname);
    } catch {
        throw ApiError.unprocessable('The file could not be read. Use the template (.xlsx) or a CSV export of it.');
    }
    if (!rows.length) throw ApiError.unprocessable('The file has no data rows');
    const batch = await validateAttendanceImport(req, rows, req.file.originalname, { overwrite: req.body.overwrite === 'true' });
    res.status(201).json({ success: true, data: batch });
}));

router.get('/attendance/import/:id', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const batch = await ImportBatch.findById(req.params.id).lean();
    if (!batch) throw ApiError.notFound('Import not found');
    res.json({ success: true, data: batch });
}));

router.get('/attendance/import/:id/errors', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const batch = await ImportBatch.findById(req.params.id).lean();
    if (!batch) throw ApiError.notFound('Import not found');
    const rows = batch.rows.filter(r => r.problems.length || r.warnings.length).map(r => ({
        row: r.row, employeeCode: r.data.employeeCode, date: r.data.date, inTime: r.data.inTime, outTime: r.data.outTime,
        status: r.data.status, errors: r.problems.join('; '), warnings: r.warnings.join('; '),
    }));
    await sendExport(res, req.query.format || 'xlsx', 'Attendance import errors', batch.fileName, [
        { key: 'row', header: 'Row', type: 'number' }, { key: 'employeeCode', header: 'Employee Code' }, { key: 'date', header: 'Date' },
        { key: 'inTime', header: 'In' }, { key: 'outTime', header: 'Out' }, { key: 'status', header: 'Status' },
        { key: 'errors', header: 'Errors', width: 50 }, { key: 'warnings', header: 'Warnings', width: 40 },
    ], rows);
}));

/** Saves the valid rows of a validated batch. Rows with errors are skipped. */
router.post('/attendance/import/:id/commit', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const batch = await ImportBatch.findById(req.params.id);
    if (!batch) throw ApiError.notFound('Import not found');
    if (batch.status !== 'validated') throw ApiError.conflict(`This import is already ${batch.status}`);
    if (batch.kind !== 'attendance') throw ApiError.badRequest('Use the monthly sheet import to confirm this file');
    let imported = 0;
    const failed = [];
    for (const r of batch.rows) {
        if (r.problems.length) continue;
        try {
            await upsertAttendance(req, {
                employee: r.data.employee, date: r.data.date, checkIn: r.data.inTime || null, checkOut: r.data.outTime || null,
                status: r.data.status || undefined, otHours: r.data.otHours ?? undefined, remarks: r.data.remarks, reason: `Excel import ${batch.fileName}`,
                importBatch: batch._id,
            }, { overwrite: batch.overwrite, source: 'excel' });
            imported += 1;
        } catch (err) {
            failed.push({ row: r.row, error: err.message });
            r.problems.push(err.message);
        }
    }
    batch.status = 'imported';
    batch.importedCount = imported;
    batch.importedAt = new Date();
    batch.errorRows = batch.rows.filter(r => r.problems.length).length;
    batch.markModified('rows');
    await batch.save();
    await audit(req, { action: 'import', entity: 'Attendance', record: batch, label: batch.fileName, note: `${imported} imported, ${failed.length} failed` });
    res.json({ success: true, message: `${imported} attendance record(s) imported`, data: { imported, failed, batchId: batch._id } });
}));

router.delete('/attendance/import/:id', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    await ImportBatch.updateOne({ _id: req.params.id, status: 'validated' }, { status: 'discarded' });
    res.json({ success: true });
}));

// ── Monthly salary sheet (day columns 1–31 + monthly totals) ────────
router.post('/attendance/monthly-sheet/validate', protect, can('attendance.import'), spreadsheetUpload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Upload the sheet in the "file" field');
    res.status(201).json({ success: true, data: await validateMonthlySheet(req, req.file.buffer, req.file.originalname, req.body.period) });
}));

router.get('/attendance/monthly-sheet', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const rows = await ImportBatch.find({ kind: 'monthly_sheet', status: { $in: ['imported', 'reverted'] } })
        .select('period fileName status totalRows importedCount importedAt revertedAt').sort({ createdAt: -1 }).limit(50).lean();
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id) })) });
}));

const loadSheetBatch = async (req) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
    const batch = await ImportBatch.findOne({ _id: req.params.id, kind: 'monthly_sheet' });
    if (!batch) throw ApiError.notFound('Import not found');
    return batch;
};

router.post('/attendance/monthly-sheet/:id/commit', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const result = await commitMonthlySheet(req, await loadSheetBatch(req));
    res.json({ success: true, message: `${result.imported} employee(s) imported`, data: result });
}));

router.post('/attendance/monthly-sheet/:id/revert', protect, can('attendance.import'), asyncHandler(async (req, res) => {
    const result = await revertMonthlySheet(req, await loadSheetBatch(req));
    res.json({ success: true, message: `Import undone; ${result.removed} attendance record(s) removed`, data: result });
}));

// ── Biometric events ────────────────────────────────────────────────
const deviceLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

/**
 * Device push endpoint. Devices (or a local middleware next to them) authenticate with
 *   X-Device-Code: <device code>    X-Device-Key: <key issued in the admin panel>
 * Admin users may also post here with their normal login (e.g. to replay a log).
 * Body: { events: [{ biometricUserId, timestamp, eventType? }] }
 */
const biometricPush = asyncHandler(async (req, res) => {
    let device = await deviceFromKey(req.get('X-Device-Code'), req.get('X-Device-Key'));
    if (!device) {
        if (!req.user) throw ApiError.unauthorized('Invalid device credentials');
        await loadAccess(req);
        if (!hasPermission(req, 'biometric.manage')) throw ApiError.forbidden();
        if (req.body.device) device = await BiometricDevice.findOne({ _id: req.body.device, deletedAt: null });
    }
    const events = Array.isArray(req.body) ? req.body : req.body.events || (req.body.biometricUserId ? [req.body] : []);
    const result = await ingestEvents(device, events, device ? 'fingerprint' : 'api');
    const processed = req.query.process === 'false' ? null : await processPendingEvents(req, { deviceId: device?._id });
    res.status(202).json({ success: true, data: { ...result, processed } });
});
router.post('/biometric/events', deviceLimiter, optionalAuth, biometricPush);
router.post('/biometric/attendance', deviceLimiter, optionalAuth, biometricPush);

router.get('/biometric/events', protect, can('biometric.manage', 'attendance.view'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const q = {};
    for (const k of ['status', 'device', 'employee']) if (req.query[k]) q[k] = req.query[k];
    if (req.query.biometricUserId) q.biometricUserId = String(req.query.biometricUserId);
    const [rows, total] = await Promise.all([
        AttendanceEvent.find(q).populate('device', 'deviceCode name').populate('employee', 'fullName employeeCode').sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
        AttendanceEvent.countDocuments(q),
    ]);
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id), localTime: localTime(r.timestamp) })), pagination: paginationMeta(page, limit, total) });
}));

router.post('/biometric/process', protect, can('biometric.manage'), asyncHandler(async (req, res) => {
    const result = await processPendingEvents(req, { deviceId: req.body?.device || null });
    await audit(req, { action: 'process-events', entity: 'AttendanceEvent', note: JSON.stringify(result) });
    res.json({ success: true, data: result });
}));

router.post('/biometric/sync', protect, can('biometric.manage'), asyncHandler(async (req, res) => {
    const device = await BiometricDevice.findOne({ _id: req.body?.device, deletedAt: null });
    if (!device) throw ApiError.notFound('Device not found');
    const result = await syncDevice(req, device);
    res.json({ success: true, data: result });
}));

/** Upload a punch log exported from a device: columns User ID, Timestamp (YYYY-MM-DD HH:MM), Type. */
router.post('/biometric/events/upload', protect, can('biometric.manage'), spreadsheetUpload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Upload the device log in the "file" field');
    const device = req.body.device ? await BiometricDevice.findOne({ _id: req.body.device, deletedAt: null }) : null;
    const rows = await readSheet(req.file.buffer, req.file.originalname);
    const tz = process.env.HR_TZ_OFFSET || '+05:30';
    const events = rows.map(r => {
        const raw = r.Timestamp || r['Date Time'] || r.DateTime || `${r.Date || ''} ${r.Time || ''}`;
        const ts = raw instanceof Date ? raw : new Date(String(raw).trim().replace(' ', 'T') + (String(raw).includes('+') || String(raw).endsWith('Z') ? '' : `:00${tz}`).replace('::', ':'));
        return { biometricUserId: r['User ID'] || r.UserID || r['Employee ID'] || r.ID, timestamp: ts, eventType: r.Type || r.State || r['Event Type'] };
    });
    const result = await ingestEvents(device, events, 'file');
    const processed = await processPendingEvents(req, { deviceId: device?._id });
    await audit(req, { action: 'upload-log', entity: 'AttendanceEvent', note: `${req.file.originalname}: ${result.stored} stored` });
    res.json({ success: true, data: { ...result, processed } });
}));

// ── Overtime ────────────────────────────────────────────────────────
router.get('/overtime', protect, can('overtime.view'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const q = { deletedAt: null };
    if (req.query.from || req.query.to) q.date = { $gte: req.query.from || '0000-00-00', $lte: req.query.to || '9999-12-31' };
    for (const k of ['status', 'employee', 'overtimeType', 'source']) if (req.query[k]) q[k] = req.query[k];
    const sq = await scopeFilter(req, q);
    const [rows, total] = await Promise.all([
        OvertimeEntry.find(sq).populate('employee', 'fullName employeeCode').populate('overtimeType', 'name code multiplier').populate('approvedBy', 'name')
            .sort({ date: -1 }).skip(skip).limit(limit),
        OvertimeEntry.countDocuments(sq),
    ]);
    res.json({ success: true, data: rows, pagination: paginationMeta(page, limit, total) });
}));

router.post('/overtime', protect, can('overtime.edit'), asyncHandler(async (req, res) => {
    const { employee, date, overtimeType, hours, remarks } = req.body || {};
    if (!isObjectId(employee) || !(await canSeeEmployee(req, employee))) throw ApiError.notFound('Employee not found');
    if (!isValidDay(date)) throw ApiError.unprocessable('Enter a valid date');
    const type = await OvertimeType.findOne({ _id: overtimeType, active: true, deletedAt: null });
    if (!type) throw ApiError.unprocessable('Choose an overtime type');
    let h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24) throw ApiError.unprocessable('Hours must be between 0 and 24');
    if (h * 60 < (type.minMinutes || 0)) throw ApiError.unprocessable(`Minimum ${type.minMinutes} minutes for ${type.name}`);
    if (type.roundingMinutes > 0) h = Math.floor((h * 60) / type.roundingMinutes) * type.roundingMinutes / 60;
    await assertEmployeePeriodOpen(employee, date, 'Overtime');
    const entry = await OvertimeEntry.create({
        employee, date, overtimeType: type._id, hours: round2(h), requestedHours: Number(hours), remarks, source: 'manual',
        status: type.approvalRequired ? 'pending' : 'approved', createdBy: req.user._id,
    });
    await audit(req, { action: 'create', entity: 'OvertimeEntry', after: entry, label: date });
    res.status(201).json({ success: true, data: entry });
}));

router.patch('/overtime/:id/:decision(approve|reject)', protect, can('overtime.approve'), asyncHandler(async (req, res) => {
    const entry = await OvertimeEntry.findOne({ _id: req.params.id, deletedAt: null });
    if (!entry || !(await canSeeEmployee(req, entry.employee))) throw ApiError.notFound('Overtime entry not found');
    await assertEmployeePeriodOpen(entry.employee, entry.date, 'Overtime');
    const before = entry.toObject();
    entry.status = req.params.decision === 'approve' ? 'approved' : 'rejected';
    if (req.body?.hours != null && entry.status === 'approved') entry.hours = round2(Number(req.body.hours));
    entry.approvedBy = req.user._id;
    entry.approvedAt = new Date();
    await entry.save();
    await audit(req, { action: req.params.decision, entity: 'OvertimeEntry', before, after: entry, label: entry.date, note: req.body?.note || '' });
    res.json({ success: true, data: entry });
}));

router.post('/overtime/bulk-approve', protect, can('overtime.approve'), asyncHandler(async (req, res) => {
    const ids = (req.body?.ids || []).filter(isObjectId);
    let n = 0;
    for (const id of ids) {
        const entry = await OvertimeEntry.findOne({ _id: id, status: 'pending', deletedAt: null });
        if (!entry || !(await canSeeEmployee(req, entry.employee))) continue;
        try { await assertEmployeePeriodOpen(entry.employee, entry.date, 'Overtime'); } catch { continue; }
        const before = entry.toObject();
        entry.status = 'approved'; entry.approvedBy = req.user._id; entry.approvedAt = new Date();
        await entry.save();
        await audit(req, { action: 'approve', entity: 'OvertimeEntry', before, after: entry, label: entry.date });
        n += 1;
    }
    res.json({ success: true, message: `${n} overtime entr${n === 1 ? 'y' : 'ies'} approved` });
}));

router.delete('/overtime/:id', protect, can('overtime.edit'), asyncHandler(async (req, res) => {
    const entry = await OvertimeEntry.findOne({ _id: req.params.id, deletedAt: null });
    if (!entry) throw ApiError.notFound('Overtime entry not found');
    await assertEmployeePeriodOpen(entry.employee, entry.date, 'Overtime');
    const before = entry.toObject();
    entry.deletedAt = new Date();
    await entry.save();
    await audit(req, { action: 'delete', entity: 'OvertimeEntry', before, label: entry.date });
    res.json({ success: true });
}));

// ── Leave requests ──────────────────────────────────────────────────
router.get('/leave-requests', protect, can('leave.view', 'leave.request'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    await loadAccess(req);
    const q = { deletedAt: null };
    for (const k of ['status', 'employee', 'leaveType']) if (req.query[k]) q[k] = req.query[k];
    if (req.query.from) q.toDate = { $gte: req.query.from };
    if (req.query.to) q.fromDate = { $lte: req.query.to };
    let sq = await scopeFilter(req, q);
    if (!hasPermission(req, 'leave.view') || req.query.mine === 'true') sq = { ...q, employee: req.user.employee || null };
    const [rows, total] = await Promise.all([
        LeaveRequest.find(sq).populate('employee', 'fullName employeeCode manager').populate('leaveType', 'name code paid color').populate('approvals.by', 'name')
            .sort({ createdAt: -1 }).skip(skip).limit(limit),
        LeaveRequest.countDocuments(sq),
    ]);
    res.json({ success: true, data: rows, pagination: paginationMeta(page, limit, total) });
}));

router.post('/leave-requests', protect, can('leave.request', 'leave.approve'), hrUpload.array('documents', 3), asyncHandler(async (req, res) => {
    await loadAccess(req);
    const employeeId = req.body.employee || req.user.employee;
    // Staff without leave.approve can only request leave for themselves.
    if (!hasPermission(req, 'leave.approve') && String(employeeId) !== String(req.user.employee)) throw ApiError.forbidden('You can only request leave for yourself');
    if (!(await canSeeEmployee(req, employeeId))) throw ApiError.notFound('Employee not found');
    const documents = [];
    for (const f of req.files || []) documents.push(await saveHrFile(f, `leave/${employeeId}`, req.user._id));
    const request = await createLeaveRequest(req, { ...req.body, employee: employeeId, halfDay: req.body.halfDay === true || req.body.halfDay === 'true', documents });
    res.status(201).json({ success: true, message: request.status === 'approved' ? 'Leave recorded' : 'Leave request submitted', data: request });
}));

router.get('/leave-requests/:id/documents/:docId', protect, can('leave.view', 'leave.request'), asyncHandler(async (req, res) => {
    const request = await LeaveRequest.findById(req.params.id).lean();
    if (!request || !(await canSeeEmployee(req, request.employee))) throw ApiError.notFound('Document not found');
    const doc = request.documents.find(d => String(d._id) === req.params.docId);
    if (!doc) throw ApiError.notFound('Document not found');
    await sendHrFile(res, doc);
}));

router.patch('/leave-requests/:id/:decision(approve|reject)', protect, can('leave.approve', 'leave.approve.supervisor'), asyncHandler(async (req, res) => {
    const request = await LeaveRequest.findOne({ _id: req.params.id, deletedAt: null });
    if (!request || !(await canSeeEmployee(req, request.employee))) throw ApiError.notFound('Leave request not found');
    if (String(request.employee) === String(req.user.employee)) throw ApiError.forbidden('You cannot approve your own leave');
    await loadAccess(req);
    const level = hasPermission(req, 'leave.approve') ? 'hr' : 'supervisor';
    if (level === 'supervisor' && request.status !== 'pending') throw ApiError.forbidden('This request now needs HR approval');
    const type = await LeaveType.findById(request.leaveType).lean();
    // HR can approve directly; the supervisor step is skipped when the type does not need it.
    const result = await decideLeave(req, request, { decision: req.params.decision === 'approve' ? 'approved' : 'rejected', note: req.body?.note || '', level: level === 'hr' || !type.supervisorApproval ? 'hr' : 'supervisor' });
    res.json({ success: true, message: `Leave ${result.status.replace('_', ' ')}`, data: result });
}));

router.patch('/leave-requests/:id/cancel', protect, can('leave.request', 'leave.approve'), asyncHandler(async (req, res) => {
    const request = await LeaveRequest.findOne({ _id: req.params.id, deletedAt: null });
    if (!request || !(await canSeeEmployee(req, request.employee))) throw ApiError.notFound('Leave request not found');
    await loadAccess(req);
    const own = String(request.employee) === String(req.user.employee);
    if (!hasPermission(req, 'leave.approve') && !(own && request.status === 'pending')) throw ApiError.forbidden('Only pending requests can be withdrawn');
    const result = await cancelLeave(req, request, req.body?.note || '');
    res.json({ success: true, message: 'Leave cancelled', data: result });
}));

export default router;
