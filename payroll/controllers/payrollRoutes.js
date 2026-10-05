import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, escapeRegex, isObjectId, paginationMeta, parsePagination } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import User from '../../models/User.js';
import {
    Attendance, AuditLog, Employee, LeaveBalance, LeaveRequest, LeaveType, OrgUnit, OvertimeEntry, PayrollPeriod, PayrollRun,
    PayrollRunEmployee, PayrollSetting, StaffRole,
} from '../models/index.js';
import { ALL_PERMISSIONS, can, hasPermission, loadAccess } from '../permissions.js';
import { allowedEmployeeIds, canSeeEmployee } from '../services/scope.js';
import { calculateEmployeePayroll } from '../services/payrollEngine.js';
import { calculateRun, cancelRun, createRun, ensurePeriod, finalizeRun, recordPayments, transitionRun } from '../services/payrollService.js';
import { DEFAULT_SETTINGS, getGlobalSettings, resolveSettings, sanitizeSettings } from '../services/settingsService.js';
import { payslipPdf } from '../services/payslipPdf.js';
import { ensureBalance } from '../services/leaveService.js';
import { REPORT_LIST, REPORTS, runReport } from '../services/reportService.js';
import { sendExport } from '../services/excelService.js';
import { audit, periodBounds, round2, today } from '../services/util.js';

const router = express.Router();
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Periods ─────────────────────────────────────────────────────────
router.get('/payroll/periods', protect, can('payroll.view', 'payroll.process'), asyncHandler(async (req, res) => {
    const periods = await PayrollPeriod.find({ deletedAt: null }).sort({ code: -1 }).limit(60).populate('lockedBy', 'name');
    res.json({ success: true, data: periods });
}));

router.post('/payroll/periods', protect, can('payroll.process'), asyncHandler(async (req, res) => {
    const code = String(req.body?.code || '');
    if (!PERIOD_RE.test(code)) throw ApiError.unprocessable('Period must look like 2026-10');
    const exists = await PayrollPeriod.findOne({ code, deletedAt: null });
    if (exists) throw ApiError.conflict(`Period ${code} already exists`);
    const period = await ensurePeriod(code, req.user._id);
    if (req.body.payDate) { period.payDate = req.body.payDate; await period.save(); }
    await audit(req, { action: 'create', entity: 'PayrollPeriod', after: period, label: code });
    res.status(201).json({ success: true, data: period });
}));

router.patch('/payroll/periods/:id/:action(lock|unlock)', protect, can('payroll.lock'), asyncHandler(async (req, res) => {
    const period = await PayrollPeriod.findOne({ _id: req.params.id, deletedAt: null });
    if (!period) throw ApiError.notFound('Period not found');
    const before = period.toObject();
    if (req.params.action === 'lock') {
        const open = await PayrollRun.countDocuments({ period: period._id, status: { $in: ['draft', 'calculated', 'under_review', 'approved'] }, deletedAt: null });
        if (open) throw ApiError.conflict(`${open} payroll run(s) in this period are not finalized or cancelled`);
        period.status = 'locked';
        period.lockedBy = req.user._id;
        period.lockedAt = new Date();
    } else {
        if (!req.body?.reason) throw ApiError.unprocessable('Unlocking a period requires a reason');
        const finalized = await PayrollRun.countDocuments({ period: period._id, status: { $in: ['finalized', 'paid'] } });
        period.status = finalized ? 'finalized' : 'open';
        period.lockedBy = null;
        period.lockedAt = null;
    }
    await period.save();
    await audit(req, { action: req.params.action, entity: 'PayrollPeriod', before, after: period, label: period.code, note: req.body?.reason || '' });
    res.json({ success: true, data: period });
}));

// ── Runs ────────────────────────────────────────────────────────────
router.get('/payroll/runs', protect, can('payroll.view', 'payroll.process'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 200 });
    const q = { deletedAt: null };
    if (req.query.period) q.periodCode = req.query.period;
    if (req.query.status) q.status = req.query.status;
    const [rows, total] = await Promise.all([
        PayrollRun.find(q).populate('filters.company filters.branch filters.hub filters.department', 'name').populate('filters.group', 'name')
            .populate('createdBy calculatedBy approvedBy finalizedBy', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
        PayrollRun.countDocuments(q),
    ]);
    await loadAccess(req);
    const hide = !hasPermission(req, 'salary.view');
    res.json({ success: true, data: rows.map(r => { const o = r.toJSON(); if (hide) delete o.totals; return o; }), pagination: paginationMeta(page, limit, total) });
}));

router.post('/payroll/runs', protect, can('payroll.process'), asyncHandler(async (req, res) => {
    const { period, filters = {}, name, notes, calculate = true } = req.body || {};
    if (!PERIOD_RE.test(period || '')) throw ApiError.unprocessable('Choose a payroll period like 2026-10');
    const clean = {};
    for (const k of ['company', 'branch', 'hub', 'department', 'group']) if (isObjectId(filters[k])) clean[k] = filters[k];
    if (Array.isArray(filters.employees)) clean.employees = filters.employees.filter(isObjectId);
    let run = await createRun(req, { period, filters: clean, name, notes });
    let skipped = [];
    if (calculate) ({ run, skipped } = await calculateRun(req, run));
    res.status(201).json({ success: true, message: calculate ? `Payroll calculated for ${run.totals.employees} employee(s)` : 'Payroll run created', data: run, skipped });
}));

// Alias matching the documented /api/payroll/calculate
router.post('/payroll/calculate', protect, can('payroll.process'), asyncHandler(async (req, res) => {
    const run = await PayrollRun.findOne({ _id: req.body?.run, deletedAt: null });
    if (!run) throw ApiError.notFound('Payroll run not found');
    const result = await calculateRun(req, run);
    res.json({ success: true, data: result.run, skipped: result.skipped });
}));

/** Preview one employee's payroll for a period without saving anything. */
router.post('/payroll/preview', protect, can('payroll.process', 'salary.view'), asyncHandler(async (req, res) => {
    const { employee, period } = req.body || {};
    if (!PERIOD_RE.test(period || '')) throw ApiError.unprocessable('Choose a period like 2026-10');
    if (!(await canSeeEmployee(req, employee))) throw ApiError.notFound('Employee not found');
    const emp = await Employee.findOne({ _id: employee, deletedAt: null }).populate('company branch hub department designation group', 'name code settings').lean();
    if (!emp) throw ApiError.notFound('Employee not found');
    const { start, end } = periodBounds(period);
    const result = await calculateEmployeePayroll(emp, { code: period, startDate: start, endDate: end }, {});
    if (result.skip) throw ApiError.unprocessable(result.reason);
    const { revision, structure, settings, sources, ...rest } = result;
    res.json({ success: true, data: { ...rest, structure: structure.name, revision: { effectiveFrom: revision.effectiveFrom, basicSalary: revision.basicSalary } } });
}));

const loadRun = async (req) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
    const run = await PayrollRun.findOne({ _id: req.params.id, deletedAt: null });
    if (!run) throw ApiError.notFound('Payroll run not found');
    return run;
};

router.get('/payroll/runs/:id', protect, can('payroll.view', 'payroll.process'), asyncHandler(async (req, res) => {
    const run = await PayrollRun.findOne({ _id: req.params.id, deletedAt: null })
        .populate('period').populate('filters.company filters.branch filters.hub filters.department filters.group', 'name')
        .populate('history.by createdBy calculatedBy approvedBy finalizedBy', 'name');
    if (!run) throw ApiError.notFound('Payroll run not found');
    await loadAccess(req);
    const o = run.toJSON();
    if (!hasPermission(req, 'salary.view')) delete o.totals;
    res.json({ success: true, data: o });
}));

router.get('/payroll/runs/:id/employees', protect, can('payroll.view', 'payroll.process'), asyncHandler(async (req, res) => {
    const run = await loadRun(req);
    await loadAccess(req);
    if (!hasPermission(req, 'salary.view')) throw ApiError.forbidden('Salary amounts are not visible to your role');
    const q = { run: run._id };
    if (req.query.search) {
        const re = new RegExp(escapeRegex(String(req.query.search).slice(0, 60)), 'i');
        q.$or = [{ 'snapshot.fullName': re }, { 'snapshot.employeeCode': re }, { 'snapshot.department': re }];
    }
    if (req.query.issues === 'true') q.$or = [{ 'blockers.0': { $exists: true } }, { 'warnings.0': { $exists: true } }];
    const ids = await allowedEmployeeIds(req);
    if (ids) q.employee = { $in: ids };
    const rows = await PayrollRunEmployee.find(q).sort({ 'snapshot.employeeCode': 1 }).lean();
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id) })) });
}));

router.get('/payroll/runs/:id/employees/:lineId', protect, can('payroll.view', 'payroll.process'), asyncHandler(async (req, res) => {
    await loadAccess(req);
    if (!hasPermission(req, 'salary.view')) throw ApiError.forbidden('Salary amounts are not visible to your role');
    const line = await PayrollRunEmployee.findOne({ _id: req.params.lineId, run: req.params.id }).lean();
    if (!line || !(await canSeeEmployee(req, line.employee))) throw ApiError.notFound('Not found');
    res.json({ success: true, data: { ...line, id: String(line._id) } });
}));

router.post('/payroll/runs/:id/calculate', protect, can('payroll.process'), asyncHandler(async (req, res) => {
    const result = await calculateRun(req, await loadRun(req));
    res.json({ success: true, message: `Recalculated ${result.run.totals.employees} employee(s)`, data: result.run, skipped: result.skipped });
}));
router.post('/payroll/runs/:id/submit', protect, can('payroll.process'), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await transitionRun(req, await loadRun(req), 'under_review', req.body?.note) });
}));
router.post('/payroll/runs/:id/approve', protect, can('payroll.approve'), asyncHandler(async (req, res) => {
    const run = await loadRun(req);
    if (String(run.calculatedBy) === String(req.user._id) && req.user.role !== 'admin') {
        throw ApiError.forbidden('The person who calculated a payroll cannot approve it');
    }
    res.json({ success: true, data: await transitionRun(req, run, 'approved', req.body?.note) });
}));
router.post('/payroll/runs/:id/return', protect, can('payroll.approve'), asyncHandler(async (req, res) => {
    if (!req.body?.note) throw ApiError.unprocessable('Explain what needs to change');
    res.json({ success: true, data: await transitionRun(req, await loadRun(req), 'calculated', req.body.note) });
}));
router.post('/payroll/runs/:id/finalize', protect, can('payroll.finalize'), asyncHandler(async (req, res) => {
    res.json({ success: true, message: 'Payroll finalized and locked', data: await finalizeRun(req, await loadRun(req), req.body?.note) });
}));
// Alias matching the documented /api/payroll/finalize
router.post('/payroll/finalize', protect, can('payroll.finalize'), asyncHandler(async (req, res) => {
    req.params.id = req.body?.run;
    res.json({ success: true, data: await finalizeRun(req, await loadRun(req), req.body?.note) });
}));
router.post('/payroll/runs/:id/cancel', protect, can('payroll.finalize', 'payroll.process'), asyncHandler(async (req, res) => {
    const run = await loadRun(req);
    await loadAccess(req);
    if (run.status === 'finalized' && !hasPermission(req, 'payroll.finalize')) throw ApiError.forbidden();
    res.json({ success: true, data: await cancelRun(req, run, req.body?.reason) });
}));

router.post('/payroll/runs/:id/payments', protect, can('payroll.pay'), asyncHandler(async (req, res) => {
    const { lineIds = [], status, method, date, reference, note } = req.body || {};
    if (!['pending', 'processing', 'paid', 'failed', 'cancelled'].includes(status)) throw ApiError.unprocessable('Invalid payment status');
    if (status === 'paid' && !date) throw ApiError.unprocessable('Payment date is required');
    const result = await recordPayments(req, await loadRun(req), { lineIds: lineIds.filter(isObjectId), status, method, date, reference, note });
    res.json({ success: true, message: `${result.updated} payment(s) updated`, data: result.run });
}));
router.get('/payroll/payments', protect, can('payroll.pay', 'payroll.view'), asyncHandler(async (req, res) => {
    const q = { status: 'active' };
    if (req.query.period) q.periodCode = req.query.period;
    if (req.query.status) q['payment.status'] = req.query.status;
    const runs = await PayrollRun.find({ status: { $in: ['finalized', 'paid'] } }).select('_id').lean();
    q.run = { $in: runs.map(r => r._id) };
    const rows = await PayrollRunEmployee.find(q).select('periodCode snapshot.employeeCode snapshot.fullName snapshot.bankName snapshot.accountNumber net payment payslipNumber run').sort({ periodCode: -1 }).limit(2000).lean();
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id) })) });
}));

/** Payroll Excel / CSV / PDF export for a run. */
router.get('/payroll/runs/:id/export', protect, can('payroll.export'), asyncHandler(async (req, res) => {
    const run = await loadRun(req);
    const lines = await PayrollRunEmployee.find({ run: run._id, status: 'active' }).sort({ 'snapshot.employeeCode': 1 }).lean();
    const codes = [...new Set(lines.flatMap(l => l.items.map(i => `${i.type}:${i.code}:${i.name}`)))];
    const comps = codes.map(c => { const [type, code, ...name] = c.split(':'); return { type, code, name: name.join(':') }; })
        .sort((a, b) => ({ earning: 0, deduction: 1, employer: 2 }[a.type] - { earning: 0, deduction: 1, employer: 2 }[b.type]));
    const detailed = req.query.detail !== 'false';
    const columns = [
        { key: 'employeeCode', header: 'Employee ID' }, { key: 'name', header: 'Employee Name', width: 26 }, { key: 'department', header: 'Department', width: 18 },
        ...(detailed ? comps.map(c => ({ key: `c_${c.code}`, header: c.name, type: 'money' })) : [
            { key: 'basic', header: 'Basic', type: 'money' }, { key: 'allowances', header: 'Allowances', type: 'money' }, { key: 'ot', header: 'OT', type: 'money' },
        ]),
        { key: 'gross', header: 'Gross', type: 'money' }, { key: 'deductions', header: 'Deductions', type: 'money' }, { key: 'net', header: 'Net', type: 'money' },
        { key: 'paymentStatus', header: 'Payment Status' },
    ];
    const rows = lines.map(l => {
        const r = {
            employeeCode: l.snapshot.employeeCode, name: l.snapshot.fullName, department: l.snapshot.department, gross: l.gross, deductions: l.totalDeductions, net: l.net,
            paymentStatus: l.payment?.status,
            basic: round2(l.items.filter(i => i.category === 'basic').reduce((s, i) => s + i.amount, 0)),
            allowances: round2(l.items.filter(i => i.type === 'earning' && !['basic', 'overtime'].includes(i.category)).reduce((s, i) => s + i.amount, 0)),
            ot: round2(l.items.filter(i => i.category === 'overtime').reduce((s, i) => s + i.amount, 0)),
        };
        l.items.forEach(i => { r[`c_${i.code}`] = i.amount; });
        return r;
    });
    await audit(req, { action: 'export', entity: 'PayrollRun', record: run, label: run.runNumber, note: req.query.format || 'xlsx' });
    await sendExport(res, req.query.format || 'xlsx', `Payroll ${run.runNumber}`, `${run.periodCode} · ${run.status}`, columns, rows, {
        summary: [['Employees', rows.length], ['Total gross', run.totals.gross], ['Total deductions', run.totals.deductions], ['Total net', run.totals.net]],
    });
}));

// ── Payslips ────────────────────────────────────────────────────────
const canViewPayslip = async (req, line) => {
    await loadAccess(req);
    if (hasPermission(req, 'payslip.view') && (await canSeeEmployee(req, line.employee))) return true;
    return hasPermission(req, 'payslip.view.own') && req.user.employee && String(req.user.employee) === String(line.employee);
};

router.get('/payslips', protect, can('payslip.view', 'payslip.view.own'), asyncHandler(async (req, res) => {
    await loadAccess(req);
    const q = { status: 'active', payslipNumber: { $ne: '' } };
    if (req.query.period) q.periodCode = req.query.period;
    if (req.query.run) q.run = req.query.run;
    if (!hasPermission(req, 'payslip.view') || req.query.mine === 'true') q.employee = req.user.employee || null;
    else {
        const ids = await allowedEmployeeIds(req);
        if (ids) q.employee = { $in: ids };
        if (req.query.employee) q.employee = req.query.employee;
    }
    const rows = await PayrollRunEmployee.find(q).select('periodCode payslipNumber snapshot.employeeCode snapshot.fullName snapshot.department net gross payment.status run')
        .sort({ periodCode: -1, 'snapshot.employeeCode': 1 }).limit(1000).lean();
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id) })) });
}));

router.get('/payslips/:lineId/pdf', protect, can('payslip.view', 'payslip.view.own'), asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.lineId)) throw ApiError.badRequest('Invalid id');
    const line = await PayrollRunEmployee.findById(req.params.lineId).lean();
    if (!line || !(await canViewPayslip(req, line))) throw ApiError.notFound('Payslip not found');
    const run = await PayrollRun.findById(line.run).lean();
    // Employees only see payslips of finalized payroll; HR may preview drafts.
    if (!['finalized', 'paid'].includes(run.status) && !hasPermission(req, 'payroll.view')) throw ApiError.notFound('Payslip not found');
    const period = await PayrollPeriod.findById(line.period).lean();
    const emp = await Employee.findById(line.employee).lean();
    const settings = await resolveSettings(emp);
    const pdf = await payslipPdf([line], { settings, period });
    await audit(req, { action: 'view-payslip', entity: 'PayrollRunEmployee', record: line, label: `${line.snapshot.employeeCode} ${line.periodCode}` });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="payslip-${line.snapshot.employeeCode}-${line.periodCode}.pdf"`);
    res.send(pdf);
}));

router.get('/payroll/runs/:id/payslips.pdf', protect, can('payslip.view'), asyncHandler(async (req, res) => {
    const run = await loadRun(req);
    const q = { run: run._id, status: 'active' };
    const ids = await allowedEmployeeIds(req);
    if (ids) q.employee = { $in: ids };
    const lines = await PayrollRunEmployee.find(q).sort({ 'snapshot.employeeCode': 1 }).lean();
    if (!lines.length) throw ApiError.notFound('No payslips in this payroll');
    const period = await PayrollPeriod.findById(run.period).lean();
    const settings = await getGlobalSettings();
    const pdf = await payslipPdf(lines, { settings, period });
    await audit(req, { action: 'export-payslips', entity: 'PayrollRun', record: run, label: run.runNumber });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-${run.runNumber}.pdf"`);
    res.send(pdf);
}));

// ── Reports ─────────────────────────────────────────────────────────
router.get('/payroll/reports', protect, can('reports.view'), asyncHandler(async (req, res) => {
    await loadAccess(req);
    res.json({ success: true, data: REPORT_LIST.filter(r => !r.sensitive || hasPermission(req, 'salary.view')) });
}));

router.get('/payroll/reports/:type', protect, can('reports.view'), asyncHandler(async (req, res) => {
    const def = REPORTS[req.params.type];
    if (!def) throw ApiError.notFound('Unknown report');
    await loadAccess(req);
    if (def.sensitive && !hasPermission(req, 'salary.view')) throw ApiError.forbidden('This report contains salary information');
    const filters = {};
    for (const k of ['from', 'to', 'employee', 'company', 'branch', 'hub', 'department', 'group', 'status']) if (req.query[k]) filters[k] = String(req.query[k]);
    const result = await runReport(req.params.type, filters, await allowedEmployeeIds(req));
    if (req.query.format) {
        if (!hasPermission(req, 'payroll.export') && !hasPermission(req, 'reports.view')) throw ApiError.forbidden();
        await audit(req, { action: 'export', entity: 'Report', label: req.params.type, note: `${req.query.format} ${JSON.stringify(filters)}` });
        const subtitle = [filters.from && `From ${filters.from}`, filters.to && `to ${filters.to}`].filter(Boolean).join(' ');
        return sendExport(res, req.query.format, result.title, subtitle, result.columns, result.rows, { summary: result.summary || [] });
    }
    res.json({ success: true, data: result });
}));

// ── Dashboard ───────────────────────────────────────────────────────
router.get('/payroll/dashboard', protect, can('hr.dashboard.view'), asyncHandler(async (req, res) => {
    await loadAccess(req);
    const showMoney = hasPermission(req, 'salary.view');
    const ids = await allowedEmployeeIds(req);
    const empQ = { deletedAt: null, ...(ids ? { _id: { $in: ids } } : {}) };
    const day = today();
    const month = day.slice(0, 7);
    const { start } = periodBounds(month);

    const [total, active, todayRows, pendingLeave, pendingOt, onLeaveToday] = await Promise.all([
        Employee.countDocuments(empQ),
        Employee.countDocuments({ ...empQ, status: { $in: ['active', 'probation'] } }),
        Attendance.find({ date: day, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) }).select('status lateMinutes').lean(),
        LeaveRequest.countDocuments({ status: { $in: ['pending', 'supervisor_approved'] }, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) }),
        OvertimeEntry.countDocuments({ status: 'pending', deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) }),
        LeaveRequest.countDocuments({ status: 'approved', fromDate: { $lte: day }, toDate: { $gte: day }, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) }),
    ]);
    const present = todayRows.filter(r => ['present', 'late', 'early_leave', 'half_day', 'remote'].includes(r.status)).length;

    // Attendance trend (last 14 days)
    const from14 = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const trend = await Attendance.aggregate([
        { $match: { date: { $gte: from14, $lte: day }, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) } },
        { $group: { _id: '$date', present: { $sum: { $cond: [{ $in: ['$status', ['present', 'late', 'early_leave', 'half_day', 'remote']] }, 1, 0] } }, absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } }, leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } }, late: { $sum: { $cond: [{ $gt: ['$lateMinutes', 0] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
    ]);

    const leaveStats = await LeaveRequest.aggregate([
        { $match: { status: 'approved', fromDate: { $gte: `${day.slice(0, 4)}-01-01` }, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) } },
        { $lookup: { from: 'leavetypes', localField: 'leaveType', foreignField: '_id', as: 't' } },
        { $group: { _id: { $first: '$t.name' }, days: { $sum: '$days' } } },
    ]);
    const otStats = await OvertimeEntry.aggregate([
        { $match: { status: 'approved', date: { $gte: start }, deletedAt: null, ...(ids ? { employee: { $in: ids } } : {}) } },
        { $lookup: { from: 'overtimetypes', localField: 'overtimeType', foreignField: '_id', as: 't' } },
        { $group: { _id: { $first: '$t.name' }, hours: { $sum: '$hours' } } },
    ]);

    const data = {
        employees: { total, active, presentToday: present, absentToday: todayRows.filter(r => r.status === 'absent').length, lateToday: todayRows.filter(r => r.lateMinutes > 0).length, onLeaveToday, notMarkedToday: Math.max(0, active - todayRows.length) },
        pending: { leave: pendingLeave, overtime: pendingOt },
        attendanceTrend: trend.map(t => ({ date: t._id, present: t.present, absent: t.absent, leave: t.leave, late: t.late })),
        leaveStats: leaveStats.map(l => ({ type: l._id || 'Other', days: l.days })),
        overtimeStats: otStats.map(o => ({ type: o._id || 'Other', hours: round2(o.hours) })),
    };

    if (showMoney) {
        const runs = await PayrollRun.find({ status: { $ne: 'cancelled' }, deletedAt: null }).select('_id status periodCode').lean();
        const runIds = runs.map(r => r._id);
        const lineQ = { run: { $in: runIds }, status: 'active', ...(ids ? { employee: { $in: ids } } : {}) };
        const monthly = await PayrollRunEmployee.aggregate([
            { $match: lineQ },
            { $group: { _id: '$periodCode', gross: { $sum: '$gross' }, net: { $sum: '$net' }, deductions: { $sum: '$totalDeductions' }, employer: { $sum: '$employerContributions' }, employees: { $sum: 1 } } },
            { $sort: { _id: -1 } }, { $limit: 12 },
        ]);
        const current = monthly.find(m => m._id === month) || monthly[0] || null;
        const currentCode = current?._id || month;
        const lines = await PayrollRunEmployee.find({ ...lineQ, periodCode: currentCode }).select('items snapshot.department net payment.status').lean();
        const sumCat = (pred) => round2(lines.reduce((s, l) => s + l.items.filter(pred).reduce((a, i) => a + i.amount, 0), 0));
        const byDept = new Map();
        lines.forEach(l => byDept.set(l.snapshot.department || '(none)', round2((byDept.get(l.snapshot.department || '(none)') || 0) + l.net)));
        const buckets = [[0, 50000], [50000, 100000], [100000, 150000], [150000, 250000], [250000, Infinity]];
        data.payroll = {
            period: currentCode,
            gross: round2(current?.gross || 0),
            net: round2(current?.net || 0),
            overtime: sumCat(i => i.category === 'overtime'),
            deductions: round2(current?.deductions || 0),
            allowances: sumCat(i => i.type === 'earning' && !['basic', 'overtime'].includes(i.category)),
            pendingRuns: runs.filter(r => ['draft', 'calculated', 'under_review', 'approved'].includes(r.status)).length,
            pendingPayments: await PayrollRunEmployee.countDocuments({ ...lineQ, run: { $in: runs.filter(r => r.status === 'finalized').map(r => r._id) }, 'payment.status': { $in: ['pending', 'processing', 'failed'] } }),
            monthly: monthly.reverse().map(m => ({ period: m._id, gross: round2(m.gross), net: round2(m.net), employer: round2(m.employer) })),
            byDepartment: [...byDept.entries()].map(([department, net]) => ({ department, net })),
            distribution: buckets.map(([a, b]) => ({ range: b === Infinity ? `${a / 1000}k+` : `${a / 1000}k–${b / 1000}k`, employees: lines.filter(l => l.net >= a && l.net < b).length })),
        };
    }
    res.json({ success: true, data });
}));

// ── Settings ────────────────────────────────────────────────────────
router.get('/payroll/settings', protect, can('settings.manage', 'payroll.view', 'hr.dashboard.view'), asyncHandler(async (req, res) => {
    const global = await getGlobalSettings();
    const companies = await PayrollSetting.find({ scope: 'company' }).populate('scopeRef', 'name code').lean();
    res.json({ success: true, data: { defaults: DEFAULT_SETTINGS, global, companies } });
}));

router.put('/payroll/settings', protect, can('settings.manage'), asyncHandler(async (req, res) => {
    const { scope = 'global', scopeRef = null, values = {} } = req.body || {};
    if (!['global', 'company'].includes(scope)) throw ApiError.unprocessable('Invalid scope');
    if (scope === 'company' && !(await OrgUnit.exists({ _id: scopeRef, type: 'company', deletedAt: null }))) throw ApiError.unprocessable('Company not found');
    const clean = sanitizeSettings(values);
    for (const p of ['nicPattern', 'bankAccountPattern']) {
        if (clean[p]) { try { new RegExp(clean[p]); } catch { throw ApiError.unprocessable(`${p} is not a valid pattern`); } }
    }
    const doc = await PayrollSetting.findOne({ scope, scopeRef: scope === 'global' ? null : scopeRef }) || new PayrollSetting({ scope, scopeRef: scope === 'global' ? null : scopeRef, values: {} });
    const before = doc.toObject();
    doc.values = scope === 'global' ? { ...doc.values, ...clean } : clean;
    doc.markModified('values');
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, { action: 'update', entity: 'PayrollSetting', before, after: doc, label: scope });
    res.json({ success: true, message: 'Settings saved', data: doc });
}));

// ── Audit log ───────────────────────────────────────────────────────
router.get('/payroll/audit-logs', protect, can('audit.view'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const q = {};
    for (const k of ['entity', 'action', 'user']) if (req.query[k]) q[k] = req.query[k];
    if (req.query.recordId && isObjectId(req.query.recordId)) q.recordId = req.query.recordId;
    if (req.query.from || req.query.to) q.at = { $gte: new Date(req.query.from || 0), $lte: new Date(`${req.query.to || '9999-12-31'}T23:59:59Z`) };
    if (req.query.search) q.label = new RegExp(escapeRegex(String(req.query.search).slice(0, 60)), 'i');
    const [rows, total] = await Promise.all([AuditLog.find(q).sort({ at: -1 }).skip(skip).limit(limit).lean(), AuditLog.countDocuments(q)]);
    res.json({ success: true, data: rows.map(r => ({ ...r, id: String(r._id) })), pagination: paginationMeta(page, limit, total) });
}));

// ── Back-office users ───────────────────────────────────────────────
router.get('/payroll/staff-users', protect, can('roles.manage'), asyncHandler(async (req, res) => {
    const users = await User.find({ role: { $in: ['staff', 'admin'] } }).populate('staffRole', 'name code').populate('employee', 'fullName employeeCode').sort({ name: 1 }).lean();
    res.json({ success: true, data: users.map(u => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, active: u.active, staffRole: u.staffRole, employee: u.employee, lastLoginAt: u.lastLoginAt })) });
}));

router.post('/payroll/staff-users', protect, can('roles.manage'), asyncHandler(async (req, res) => {
    const { name, email, password, staffRole, employee } = req.body || {};
    if (!name || !email) throw ApiError.unprocessable('Name and email are required');
    const role = await StaffRole.findOne({ _id: staffRole, deletedAt: null });
    if (!role) throw ApiError.unprocessable('Choose a role');
    let user = await User.findOne({ email: String(email).toLowerCase() }).select('+tokenVersion');
    if (user?.role === 'admin') throw ApiError.conflict('That email belongs to an administrator');
    if (!user) {
        if (!password || String(password).length < 8) throw ApiError.unprocessable('Password must be at least 8 characters');
        user = new User({ name, email });
        await user.setPassword(password);
    }
    user.role = 'staff';
    user.staffRole = role._id;
    if (employee && isObjectId(employee)) {
        user.employee = employee;
        await Employee.updateOne({ _id: employee }, { user: user._id });
    }
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await audit(req, { action: 'grant-role', entity: 'User', record: user, label: user.email, note: role.name });
    res.status(201).json({ success: true, message: `${user.email} now has the ${role.name} role`, data: { id: user.id } });
}));

router.patch('/payroll/staff-users/:id', protect, can('roles.manage'), asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) throw ApiError.conflict('You cannot change your own access');
    const user = await User.findById(req.params.id).select('+tokenVersion');
    if (!user || user.role === 'admin') throw ApiError.notFound('Staff user not found');
    const before = { staffRole: user.staffRole, active: user.active, role: user.role };
    if (req.body.revoke) { user.role = 'customer'; user.staffRole = null; }
    if (req.body.staffRole) user.staffRole = req.body.staffRole;
    if (req.body.active != null) user.active = Boolean(req.body.active);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await audit(req, { action: 'update-access', entity: 'User', before, after: { staffRole: user.staffRole, active: user.active, role: user.role }, record: user, label: user.email });
    res.json({ success: true });
}));

// ── Self-service ────────────────────────────────────────────────────
router.get('/payroll/me', protect, asyncHandler(async (req, res) => {
    const access = await loadAccess(req);
    const emp = req.user.employee ? await Employee.findById(req.user.employee).populate('department designation branch', 'name').select('-bank -tax -documents').lean() : null;
    const year = Number(req.query.year) || new Date().getFullYear();
    if (emp) {
        const types = await LeaveType.find({ active: true, trackBalance: true, deletedAt: null });
        for (const t of types) await ensureBalance(emp, t, year);
    }
    const balances = emp ? await LeaveBalance.find({ employee: emp._id, year }).populate('leaveType', 'name code').lean({ virtuals: true }) : [];
    res.json({
        success: true,
        data: {
            permissions: [...access.permissions], dataScope: access.dataScope, roleName: access.roleName, isAdmin: access.isAdmin,
            employee: emp, leaveBalances: balances.map(b => ({ ...b, remaining: round2(b.opening + b.accrued + b.adjusted - b.used - b.pending) })),
            allPermissions: access.isAdmin ? ALL_PERMISSIONS.length : undefined,
        },
    });
}));

export default router;
