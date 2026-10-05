import ApiError from '../../utils/ApiError.js';
import {
    Advance, Employee, EmployeeSalary, ExternalPayment, HrCounter, Installment, PayrollAdjustment, PayrollEntry,
    PayrollPeriod, PayrollRun, PayrollRunEmployee,
} from '../models/index.js';
import { calculateEmployeePayroll } from './payrollEngine.js';
import { audit, periodBounds, round2, withTransaction } from './util.js';

const EDITABLE_RUN = ['draft', 'calculated', 'under_review'];

export const ensurePeriod = async (code, userId) => {
    let period = await PayrollPeriod.findOne({ code, deletedAt: null });
    if (!period) {
        const { start, end } = periodBounds(code);
        const name = new Date(`${start}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        period = await PayrollPeriod.create({ code, name, startDate: start, endDate: end, createdBy: userId });
    }
    return period;
};

const employeeFilter = (filters = {}) => {
    const f = { deletedAt: null, status: { $nin: ['terminated', 'resigned', 'retired'] } };
    for (const key of ['company', 'branch', 'hub', 'department', 'group']) if (filters[key]) f[key] = filters[key];
    if (filters.employees?.length) f._id = { $in: filters.employees };
    return f;
};

export const createRun = async (req, { period: periodCode, filters = {}, name = '', notes = '' }) => {
    const period = await ensurePeriod(periodCode, req.user._id);
    if (period.status === 'locked') throw ApiError.conflict(`Payroll period ${period.code} is locked`);
    const seq = await HrCounter.next(`run-${period.code}`);
    const run = await PayrollRun.create({
        runNumber: `PR-${period.code}-${String(seq).padStart(2, '0')}`,
        period: period._id, periodCode: period.code, filters, name, notes,
        status: 'draft', history: [{ status: 'draft', by: req.user._id }],
        createdBy: req.user._id,
    });
    if (period.status === 'open') { period.status = 'processing'; await period.save(); }
    await audit(req, { action: 'create', entity: 'PayrollRun', after: run, label: run.runNumber });
    return run;
};

/**
 * Calculates (or recalculates) every employee in the run's scope inside one transaction, replacing
 * previous results. Employees already in another approved/finalized run for the period are skipped.
 */
export const calculateRun = async (req, run) => {
    if (!EDITABLE_RUN.includes(run.status)) throw ApiError.conflict(`A ${run.status} payroll cannot be recalculated`);
    const period = await PayrollPeriod.findById(run.period).lean();
    if (['finalized', 'locked'].includes(period.status)) throw ApiError.conflict(`Payroll period ${period.code} is ${period.status}`);

    const employees = await Employee.find(employeeFilter(run.filters))
        .populate('company branch hub department costCenter designation group', 'name code settings')
        .lean();
    const otherRuns = await PayrollRun.find({ period: run.period, _id: { $ne: run._id }, status: { $nin: ['cancelled'] }, deletedAt: null }).select('_id runNumber').lean();
    const taken = new Map((await PayrollRunEmployee.find({ run: { $in: otherRuns.map(r => r._id) }, status: 'active' }).select('employee run').lean())
        .map(r => [String(r.employee), otherRuns.find(o => String(o._id) === String(r.run))?.runNumber]));

    const cache = {};
    const rows = [];
    const skipped = [];
    for (const emp of employees) {
        if (taken.has(String(emp._id))) {
            skipped.push(`${emp.employeeCode}: already in ${taken.get(String(emp._id))}`);
            continue;
        }
        const r = await calculateEmployeePayroll(emp, period, { cache });
        if (r.skip) { skipped.push(r.reason); continue; }
        rows.push({
            run: run._id, period: run.period, periodCode: run.periodCode, employee: emp._id, salaryRevision: r.revision._id,
            snapshot: {
                employeeCode: emp.employeeCode, fullName: emp.fullName, nic: emp.nic, email: emp.email,
                company: emp.company?.name || '', branch: emp.branch?.name || '', hub: emp.hub?.name || '', department: emp.department?.name || '',
                designation: emp.designation?.name || '', group: emp.group?.name || '', costCenter: emp.costCenter?.name || '',
                companyId: emp.company?._id, branchId: emp.branch?._id, hubId: emp.hub?._id, departmentId: emp.department?._id, groupId: emp.group?._id,
                employmentType: emp.employmentType, joiningDate: emp.joiningDate, structure: r.structure.name, payBasis: r.structure.payBasis,
                paymentMethod: r.paymentMethod, bankName: emp.bank?.bankName, bankBranch: emp.bank?.branchName,
                accountNumber: emp.bank?.accountNumber, accountName: emp.bank?.accountName || emp.fullName,
                epfNumber: emp.statutory?.epfNumber, etfNumber: emp.statutory?.etfNumber,
            },
            variables: r.variables, attendance: r.attendance, leave: r.leave, items: r.items,
            gross: r.gross, totalEarnings: r.totalEarnings, totalDeductions: r.totalDeductions,
            employerContributions: r.employerContributions, net: r.net, warnings: r.warnings, blockers: r.blockers,
            payment: { status: 'pending', method: r.paymentMethod, amount: r.net },
            sources: r.sources,
        });
    }

    const before = run.toObject();
    await withTransaction(async (session) => {
        await PayrollRunEmployee.deleteMany({ run: run._id }, { session });
        if (rows.length) await PayrollRunEmployee.insertMany(rows.map(({ sources, ...rest }) => rest), { session });
        run.totals = {
            employees: rows.length,
            gross: round2(rows.reduce((s, r) => s + r.gross, 0)),
            deductions: round2(rows.reduce((s, r) => s + r.totalDeductions, 0)),
            net: round2(rows.reduce((s, r) => s + r.net, 0)),
            employer: round2(rows.reduce((s, r) => s + r.employerContributions, 0)),
            warnings: rows.reduce((s, r) => s + r.warnings.length, 0),
            errors: rows.reduce((s, r) => s + r.blockers.length, 0),
        };
        run.status = 'calculated';
        run.calculatedAt = new Date();
        run.calculatedBy = req.user._id;
        run.history.push({ status: 'calculated', by: req.user._id, note: skipped.length ? `${skipped.length} skipped` : '' });
        run.updatedBy = req.user._id;
        await run.save({ session });
        await audit(req, { action: 'calculate', entity: 'PayrollRun', before, after: run, label: run.runNumber, session });
    });
    return { run, skipped };
};

export const transitionRun = async (req, run, to, note = '') => {
    const allowed = {
        under_review: ['calculated'],
        approved: ['calculated', 'under_review'],
        calculated: ['under_review', 'approved'], // send back for changes
    };
    if (!allowed[to]?.includes(run.status)) throw ApiError.conflict(`Cannot move a ${run.status} payroll to ${to}`);
    if (to === 'approved') {
        const blocked = await PayrollRunEmployee.countDocuments({ run: run._id, status: 'active', 'blockers.0': { $exists: true } });
        if (blocked) throw ApiError.unprocessable(`${blocked} employee(s) have problems that must be fixed before approval`);
        run.approvedBy = req.user._id;
    }
    const before = run.toObject();
    run.status = to;
    run.history.push({ status: to, by: req.user._id, note });
    run.updatedBy = req.user._id;
    await run.save();
    await audit(req, { action: to === 'approved' ? 'approve' : to === 'calculated' ? 'return' : 'submit', entity: 'PayrollRun', before, after: run, label: run.runNumber, note });
    return run;
};

/**
 * Finalizes an approved run: locks it, marks installments / entries / external payments /
 * adjustments as processed, settles recovered advances & loans, and numbers the payslips.
 */
export const finalizeRun = async (req, run, note = '') => {
    if (run.status !== 'approved') throw ApiError.conflict('Only an approved payroll can be finalized');
    const lines = await PayrollRunEmployee.find({ run: run._id, status: 'active' });
    if (!lines.length) throw ApiError.unprocessable('This payroll has no employees');
    const blocked = lines.filter(l => l.blockers?.length);
    if (blocked.length) throw ApiError.unprocessable(`${blocked.length} employee(s) have unresolved problems`);
    const period = await PayrollPeriod.findById(run.period);
    if (period.status === 'locked') throw ApiError.conflict(`Payroll period ${period.code} is locked`);

    // Recalculate sources exactly as the engine would, to know which records this payroll consumed.
    const employeeIds = lines.map(l => l.employee);
    const before = run.toObject();
    await withTransaction(async (session) => {
        const opts = session ? { session } : {};
        const installments = await Installment.find({ employee: { $in: employeeIds }, period: run.periodCode, status: 'scheduled' }, null, opts);
        const activeSources = new Map((await Advance.find({ _id: { $in: installments.map(i => i.source) }, status: { $in: ['approved', 'active'] } }, null, opts))
            .map(a => [String(a._id), a]));
        for (const inst of installments) {
            const src = activeSources.get(String(inst.source));
            if (!src) continue;
            inst.status = 'deducted';
            inst.payrollRun = run._id;
            inst.deductedAt = new Date();
            await inst.save(opts);
            src.recovered = round2(src.recovered + inst.amount);
            src.status = src.recovered >= (src.totalPayable || src.amount) - 0.005 ? 'settled' : 'active';
            await src.save(opts);
        }
        await PayrollEntry.updateMany({ employee: { $in: employeeIds }, period: run.periodCode, status: 'approved', deletedAt: null },
            { status: 'processed', payrollRun: run._id }, opts);
        await ExternalPayment.updateMany({ employee: { $in: employeeIds }, period: run.periodCode, status: 'approved', payrollTreatment: { $ne: 'none' }, deletedAt: null },
            { status: 'processed', payrollRun: run._id }, opts);
        await PayrollAdjustment.updateMany({ employee: { $in: employeeIds }, targetPeriod: run.periodCode, status: 'approved', deletedAt: null },
            { status: 'applied', payrollRun: run._id }, opts);
        await EmployeeSalary.updateMany({ _id: { $in: lines.map(l => l.salaryRevision) } }, { usedInPayroll: true }, opts);

        for (const line of lines) {
            const n = await HrCounter.next(`payslip-${run.periodCode}`, session);
            line.payslipNumber = `PS-${run.periodCode.replace('-', '')}-${String(n).padStart(4, '0')}`;
            line.payment.amount = line.net;
            await line.save(opts);
        }

        run.status = 'finalized';
        run.finalizedBy = req.user._id;
        run.finalizedAt = new Date();
        run.history.push({ status: 'finalized', by: req.user._id, note });
        await run.save(opts);

        const open = await PayrollRun.countDocuments({ period: period._id, status: { $in: EDITABLE_RUN.concat('approved') }, deletedAt: null }, opts);
        if (!open && period.status !== 'locked') { period.status = 'finalized'; await period.save(opts); }
        await audit(req, { action: 'finalize', entity: 'PayrollRun', before, after: run, label: run.runNumber, note, session });
    });
    return run;
};

/**
 * Cancels a run. Draft/calculated/approved runs are simply cancelled. A finalized run can be reversed
 * only while its period is not locked and no salary was paid; consumed records are restored.
 */
export const cancelRun = async (req, run, reason) => {
    if (!reason) throw ApiError.unprocessable('A reason is required');
    if (['cancelled', 'paid'].includes(run.status)) throw ApiError.conflict(`A ${run.status} payroll cannot be cancelled`);
    const period = await PayrollPeriod.findById(run.period);
    const before = run.toObject();
    await withTransaction(async (session) => {
        const opts = session ? { session } : {};
        if (run.status === 'finalized') {
            if (period.status === 'locked') throw ApiError.conflict('The period is locked. Use payroll adjustments in the next period.');
            const paid = await PayrollRunEmployee.countDocuments({ run: run._id, 'payment.status': { $in: ['paid', 'processing'] } }, opts);
            if (paid) throw ApiError.conflict('Some salaries are already paid. Use payroll adjustments instead.');
            const installments = await Installment.find({ payrollRun: run._id, status: 'deducted' }, null, opts);
            for (const inst of installments) {
                const src = await Advance.findById(inst.source, null, opts);
                if (src) {
                    src.recovered = round2(Math.max(0, src.recovered - inst.amount));
                    src.status = 'active';
                    await src.save(opts);
                }
                inst.status = 'scheduled';
                inst.payrollRun = null;
                inst.deductedAt = null;
                await inst.save(opts);
            }
            await PayrollEntry.updateMany({ payrollRun: run._id }, { status: 'approved', payrollRun: null }, opts);
            await ExternalPayment.updateMany({ payrollRun: run._id }, { status: 'approved', payrollRun: null }, opts);
            await PayrollAdjustment.updateMany({ payrollRun: run._id }, { status: 'approved', payrollRun: null }, opts);
            if (period.status === 'finalized') { period.status = 'processing'; await period.save(opts); }
        }
        await PayrollRunEmployee.updateMany({ run: run._id }, { status: 'cancelled', 'payment.status': 'cancelled' }, opts);
        run.status = 'cancelled';
        run.history.push({ status: 'cancelled', by: req.user._id, note: reason });
        await run.save(opts);
        await audit(req, { action: before.status === 'finalized' ? 'reverse' : 'cancel', entity: 'PayrollRun', before, after: run, label: run.runNumber, note: reason, session });
    });
    return run;
};

/** Records salary payment status for one or more employees of a finalized run. */
export const recordPayments = async (req, run, { lineIds, status, method, date, reference = '', note = '' }) => {
    if (!['finalized', 'paid'].includes(run.status)) throw ApiError.conflict('Payments can only be recorded for a finalized payroll');
    const lines = await PayrollRunEmployee.find({ run: run._id, status: 'active', ...(lineIds?.length ? { _id: { $in: lineIds } } : {}) });
    for (const line of lines) {
        const before = line.toObject();
        line.payment.status = status;
        if (method) line.payment.method = method;
        if (date) line.payment.date = date;
        if (reference) line.payment.reference = reference;
        line.payment.note = note;
        line.payment.amount = line.net;
        line.payment.processedBy = req.user._id;
        line.payment.processedAt = new Date();
        await line.save();
        await audit(req, { action: 'payment', entity: 'PayrollRunEmployee', before, after: line, label: `${line.snapshot.employeeCode} ${run.periodCode}`, note: `${status} ${reference}` });
    }
    const unpaid = await PayrollRunEmployee.countDocuments({ run: run._id, status: 'active', 'payment.status': { $ne: 'paid' } });
    const before = run.toObject();
    if (!unpaid && run.status !== 'paid') {
        run.status = 'paid';
        run.history.push({ status: 'paid', by: req.user._id });
    } else if (unpaid && run.status === 'paid') {
        run.status = 'finalized';
        run.history.push({ status: 'finalized', by: req.user._id, note: 'Payment status changed' });
    }
    if (run.isModified()) {
        await run.save();
        await audit(req, { action: 'update', entity: 'PayrollRun', before, after: run, label: run.runNumber });
    }
    return { updated: lines.length, run };
};
