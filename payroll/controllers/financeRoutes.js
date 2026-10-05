import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, isObjectId, paginationMeta, parsePagination } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import { Advance, Employee, ExternalPayment, HrCounter, Installment, PayrollAdjustment, PayrollEntry, SalaryComponent } from '../models/index.js';
import { can } from '../permissions.js';
import { canSeeEmployee, scopeFilter } from '../services/scope.js';
import { hrUpload, saveHrFile, sendHrFile } from '../services/files.js';
import { assertEmployeePeriodOpen, audit, isValidDay, pick, round2 } from '../services/util.js';

const router = express.Router();
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const addMonths = (period, n) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
};

const listHandler = (Model, populate, baseFilter = {}) => asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const q = { deletedAt: null, ...baseFilter };
    for (const k of ['status', 'employee', 'period', 'component', 'paymentType', 'targetPeriod', 'payrollTreatment']) if (req.query[k]) q[k] = req.query[k];
    if (req.query.from || req.query.to) q.date = { $gte: req.query.from || '0000-00-00', $lte: req.query.to || '9999-12-31' };
    const sq = await scopeFilter(req, q);
    const [rows, total] = await Promise.all([
        Model.find(sq).populate(populate).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Model.countDocuments(sq),
    ]);
    res.json({ success: true, data: rows, pagination: paginationMeta(page, limit, total) });
});

const empPopulate = { path: 'employee', select: 'fullName employeeCode' };

// ── Advances & loans ────────────────────────────────────────────────
const advanceRoutes = (kind, perm) => {
    const base = kind === 'advance' ? '/advances' : '/loans';

    router.get(base, protect, can(perm, 'salary.view'), listHandler(Advance, [empPopulate, { path: 'approvedBy', select: 'name' }], { kind }));

    router.get(`${base}/:id/schedule`, protect, can(perm, 'salary.view'), asyncHandler(async (req, res) => {
        const adv = await Advance.findOne({ _id: req.params.id, kind, deletedAt: null });
        if (!adv || !(await canSeeEmployee(req, adv.employee))) throw ApiError.notFound('Not found');
        res.json({ success: true, data: await Installment.find({ source: adv._id }).sort({ sequence: 1 }) });
    }));

    router.post(base, protect, can(perm), asyncHandler(async (req, res) => {
        const b = req.body || {};
        if (!isObjectId(b.employee) || !(await canSeeEmployee(req, b.employee))) throw ApiError.notFound('Employee not found');
        const emp = await Employee.findOne({ _id: b.employee, deletedAt: null }).lean();
        if (!emp) throw ApiError.notFound('Employee not found');
        const amount = Number(b.amount);
        if (!(amount > 0)) throw ApiError.unprocessable('Amount must be greater than zero');
        if (!isValidDay(b.date)) throw ApiError.unprocessable('Enter a valid date');
        if (!PERIOD_RE.test(b.startPeriod || '')) throw ApiError.unprocessable('Start month must look like 2026-10');
        const rate = kind === 'loan' ? Math.max(0, Number(b.interestRate) || 0) : 0;
        const total = round2(amount * (1 + rate / 100));
        let count = Math.max(1, parseInt(b.installmentCount, 10) || 0);
        let installment = Number(b.installmentAmount) || 0;
        if (installment > 0 && !b.installmentCount) count = Math.ceil(total / installment);
        if (!(installment > 0)) installment = round2(total / count);
        if (installment > total) installment = total;
        const seq = await HrCounter.next(kind);
        const adv = await Advance.create({
            kind, employee: emp._id, reference: `${kind === 'loan' ? 'LN' : 'ADV'}-${String(seq).padStart(5, '0')}`, loanType: b.loanType || '',
            amount, interestRate: rate, totalPayable: total, installmentCount: count, installmentAmount: installment, date: b.date,
            startPeriod: b.startPeriod, endPeriod: addMonths(b.startPeriod, count - 1), reason: b.reason || '', status: 'pending', createdBy: req.user._id,
        });
        await audit(req, { action: 'create', entity: kind === 'loan' ? 'Loan' : 'Advance', after: adv, label: `${emp.employeeCode} ${adv.reference}` });
        res.status(201).json({ success: true, message: `${kind === 'loan' ? 'Loan' : 'Advance'} recorded — approve it to schedule deductions`, data: adv });
    }));

    /** Approval creates the installment schedule that payroll deducts automatically. */
    router.patch(`${base}/:id/approve`, protect, can(perm), asyncHandler(async (req, res) => {
        const adv = await Advance.findOne({ _id: req.params.id, kind, deletedAt: null });
        if (!adv) throw ApiError.notFound('Not found');
        if (adv.status !== 'pending') throw ApiError.conflict(`Already ${adv.status}`);
        await assertEmployeePeriodOpen(adv.employee, adv.startPeriod, 'The first installment month');
        const before = adv.toObject();
        let remaining = adv.totalPayable || adv.amount;
        const docs = [];
        for (let i = 0; i < adv.installmentCount && remaining > 0.004; i += 1) {
            const amt = i === adv.installmentCount - 1 ? round2(remaining) : Math.min(adv.installmentAmount, round2(remaining));
            docs.push({ source: adv._id, kind, employee: adv.employee, sequence: i + 1, period: addMonths(adv.startPeriod, i), amount: amt });
            remaining = round2(remaining - amt);
        }
        await Installment.insertMany(docs);
        adv.status = 'approved';
        adv.approvedBy = req.user._id;
        adv.approvedAt = new Date();
        await adv.save();
        await audit(req, { action: 'approve', entity: kind === 'loan' ? 'Loan' : 'Advance', before, after: adv, label: adv.reference });
        res.json({ success: true, message: `${docs.length} installment(s) scheduled`, data: adv });
    }));

    router.patch(`${base}/:id/cancel`, protect, can(perm), asyncHandler(async (req, res) => {
        const adv = await Advance.findOne({ _id: req.params.id, kind, deletedAt: null });
        if (!adv) throw ApiError.notFound('Not found');
        if (['settled', 'cancelled', 'rejected'].includes(adv.status)) throw ApiError.conflict(`Already ${adv.status}`);
        const before = adv.toObject();
        await Installment.updateMany({ source: adv._id, status: 'scheduled' }, { status: 'cancelled' });
        adv.status = adv.status === 'pending' ? 'rejected' : (adv.recovered > 0 ? 'settled' : 'cancelled');
        await adv.save();
        await audit(req, { action: 'cancel', entity: kind === 'loan' ? 'Loan' : 'Advance', before, after: adv, label: adv.reference, note: req.body?.reason || '' });
        res.json({ success: true, data: adv });
    }));

    /** Skip one month (e.g. hardship); the schedule is extended by a month. */
    router.patch(`${base}/:id/installments/:instId/skip`, protect, can(perm), asyncHandler(async (req, res) => {
        const inst = await Installment.findOne({ _id: req.params.instId, source: req.params.id, status: 'scheduled' });
        if (!inst) throw ApiError.notFound('Scheduled installment not found');
        await assertEmployeePeriodOpen(inst.employee, inst.period, 'This installment');
        const last = await Installment.findOne({ source: inst.source }).sort({ sequence: -1 });
        inst.status = 'skipped';
        await inst.save();
        await Installment.create({ source: inst.source, kind: inst.kind, employee: inst.employee, sequence: last.sequence + 1, period: addMonths(last.period, 1), amount: inst.amount });
        await Advance.updateOne({ _id: inst.source }, { endPeriod: addMonths(last.period, 1) });
        await audit(req, { action: 'skip-installment', entity: 'Installment', record: inst, label: inst.period, note: req.body?.reason || '' });
        res.json({ success: true, message: `Installment for ${inst.period} skipped and added to the end` });
    }));
};
advanceRoutes('advance', 'advance.manage');
advanceRoutes('loan', 'loan.manage');

// ── One-off allowances / bonuses / deductions ──────────────────────
router.get('/payroll-entries', protect, can('payrollEntry.manage', 'salary.view'), listHandler(PayrollEntry, [empPopulate, { path: 'component', select: 'name code type category' }]));

router.post('/payroll-entries', protect, can('payrollEntry.manage'), asyncHandler(async (req, res) => {
    const b = pick(req.body || {}, ['employee', 'period', 'component', 'amount', 'quantity', 'rate', 'note']);
    if (!isObjectId(b.employee) || !(await canSeeEmployee(req, b.employee))) throw ApiError.notFound('Employee not found');
    if (!PERIOD_RE.test(b.period || '')) throw ApiError.unprocessable('Period must look like 2026-10');
    const comp = await SalaryComponent.findOne({ _id: b.component, deletedAt: null, active: true });
    if (!comp) throw ApiError.unprocessable('Choose an active salary component');
    if (b.quantity != null && b.rate != null && b.amount == null) b.amount = round2(Number(b.quantity) * Number(b.rate));
    if (!Number.isFinite(Number(b.amount)) || Number(b.amount) < 0) throw ApiError.unprocessable('Amount cannot be negative');
    await assertEmployeePeriodOpen(b.employee, b.period, 'This entry');
    const entry = await PayrollEntry.create({ ...b, amount: round2(b.amount), status: 'approved', approvedBy: req.user._id, createdBy: req.user._id });
    await audit(req, { action: 'create', entity: 'PayrollEntry', after: entry, label: `${comp.code} ${b.period}` });
    res.status(201).json({ success: true, data: entry });
}));

router.delete('/payroll-entries/:id', protect, can('payrollEntry.manage'), asyncHandler(async (req, res) => {
    const entry = await PayrollEntry.findOne({ _id: req.params.id, deletedAt: null });
    if (!entry) throw ApiError.notFound('Entry not found');
    if (entry.status === 'processed') throw ApiError.conflict('Already included in a finalized payroll; use an adjustment');
    await assertEmployeePeriodOpen(entry.employee, entry.period, 'This entry');
    const before = entry.toObject();
    entry.deletedAt = new Date();
    await entry.save();
    await audit(req, { action: 'delete', entity: 'PayrollEntry', before, label: entry.period });
    res.json({ success: true });
}));

// ── External payments ───────────────────────────────────────────────
router.get('/external-payments', protect, can('externalPayment.manage', 'externalPayment.approve'), listHandler(ExternalPayment, [empPopulate, { path: 'approvedBy', select: 'name' }]));

router.post('/external-payments', protect, can('externalPayment.manage'), hrUpload.array('attachments', 3), asyncHandler(async (req, res) => {
    const b = pick(req.body || {}, ['employee', 'paymentType', 'amount', 'date', 'paymentMethod', 'referenceNumber', 'reason', 'period', 'payrollTreatment', 'taxable']);
    if (!isObjectId(b.employee) || !(await canSeeEmployee(req, b.employee))) throw ApiError.notFound('Employee not found');
    if (!isValidDay(b.date)) throw ApiError.unprocessable('Enter a valid date');
    if (b.period && !PERIOD_RE.test(b.period)) throw ApiError.unprocessable('Period must look like 2026-10');
    if (b.payrollTreatment && b.payrollTreatment !== 'none' && !b.period) throw ApiError.unprocessable('Choose the payroll period it belongs to');
    if (b.period && b.payrollTreatment !== 'none') await assertEmployeePeriodOpen(b.employee, b.period, 'This payment');
    const attachments = [];
    for (const f of req.files || []) attachments.push(await saveHrFile(f, `external/${b.employee}`, req.user._id));
    const pay = await ExternalPayment.create({ ...b, taxable: b.taxable === true || b.taxable === 'true', amount: Number(b.amount), attachments, status: 'pending', createdBy: req.user._id });
    await audit(req, { action: 'create', entity: 'ExternalPayment', after: pay, label: `${b.paymentType} ${b.date}` });
    res.status(201).json({ success: true, data: pay });
}));

router.patch('/external-payments/:id/:decision(approve|reject)', protect, can('externalPayment.approve'), asyncHandler(async (req, res) => {
    const pay = await ExternalPayment.findOne({ _id: req.params.id, deletedAt: null });
    if (!pay) throw ApiError.notFound('Payment not found');
    if (pay.status !== 'pending') throw ApiError.conflict(`Already ${pay.status}`);
    if (String(pay.createdBy) === String(req.user._id) && req.user.role !== 'admin') throw ApiError.forbidden('Another user must approve a payment you entered');
    const before = pay.toObject();
    pay.status = req.params.decision === 'approve' ? 'approved' : 'rejected';
    pay.approvedBy = req.user._id;
    pay.approvedAt = new Date();
    await pay.save();
    await audit(req, { action: req.params.decision, entity: 'ExternalPayment', before, after: pay, label: pay.referenceNumber || pay.date });
    res.json({ success: true, data: pay });
}));

router.get('/external-payments/:id/attachments/:fileId', protect, can('externalPayment.manage', 'externalPayment.approve'), asyncHandler(async (req, res) => {
    const pay = await ExternalPayment.findById(req.params.id).lean();
    const file = pay?.attachments?.find(a => String(a._id) === req.params.fileId);
    if (!file) throw ApiError.notFound('File not found');
    await sendHrFile(res, file);
}));

router.delete('/external-payments/:id', protect, can('externalPayment.manage'), asyncHandler(async (req, res) => {
    const pay = await ExternalPayment.findOne({ _id: req.params.id, deletedAt: null });
    if (!pay) throw ApiError.notFound('Payment not found');
    if (pay.status === 'processed') throw ApiError.conflict('Already included in a finalized payroll');
    const before = pay.toObject();
    pay.deletedAt = new Date();
    await pay.save();
    await audit(req, { action: 'delete', entity: 'ExternalPayment', before, label: pay.referenceNumber || pay.date });
    res.json({ success: true });
}));

// ── Post-finalization adjustments ──────────────────────────────────
router.get('/payroll/adjustments', protect, can('payroll.adjust', 'payroll.view'), listHandler(PayrollAdjustment, [empPopulate, { path: 'createdBy', select: 'name' }]));

router.post('/payroll/adjustments', protect, can('payroll.adjust'), hrUpload.array('attachments', 3), asyncHandler(async (req, res) => {
    const b = pick(req.body || {}, ['employee', 'originalPeriod', 'originalRunEmployee', 'targetPeriod', 'type', 'amount', 'reason']);
    if (!isObjectId(b.employee)) throw ApiError.notFound('Employee not found');
    if (!PERIOD_RE.test(b.targetPeriod || '') || !PERIOD_RE.test(b.originalPeriod || '')) throw ApiError.unprocessable('Periods must look like 2026-10');
    if (b.targetPeriod <= b.originalPeriod) throw ApiError.unprocessable('Corrections are applied in a later period');
    if (!['earning', 'deduction'].includes(b.type)) throw ApiError.unprocessable('Type must be earning or deduction');
    if (!(Number(b.amount) > 0)) throw ApiError.unprocessable('Amount must be greater than zero');
    if (!b.reason) throw ApiError.unprocessable('A reason is required');
    await assertEmployeePeriodOpen(b.employee, b.targetPeriod, 'The target period');
    const attachments = [];
    for (const f of req.files || []) attachments.push(await saveHrFile(f, `adjustments/${b.employee}`, req.user._id));
    const adj = await PayrollAdjustment.create({ ...b, amount: Number(b.amount), componentCode: b.type === 'earning' ? 'ADJ_EARN' : 'ADJ_DEDUCT', status: 'approved', attachments, createdBy: req.user._id });
    await audit(req, { action: 'create', entity: 'PayrollAdjustment', after: adj, label: `${b.originalPeriod} → ${b.targetPeriod}`, note: b.reason });
    res.status(201).json({ success: true, data: adj });
}));

router.patch('/payroll/adjustments/:id/cancel', protect, can('payroll.adjust'), asyncHandler(async (req, res) => {
    const adj = await PayrollAdjustment.findOne({ _id: req.params.id, deletedAt: null });
    if (!adj) throw ApiError.notFound('Adjustment not found');
    if (adj.status === 'applied') throw ApiError.conflict('Already applied in a finalized payroll');
    const before = adj.toObject();
    adj.status = 'cancelled';
    await adj.save();
    await audit(req, { action: 'cancel', entity: 'PayrollAdjustment', before, after: adj });
    res.json({ success: true });
}));

export default router;
