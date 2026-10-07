import {
    Advance, Attendance, EmployeeSalary, ExternalPayment, Holiday, Installment, OvertimeEntry, OvertimeType,
    PayrollAdjustment, PayrollEntry, SalaryComponent, SalaryStructure, TaxTable, OBSERVED,
} from '../models/index.js';
import { evaluate, FormulaError } from './formulaEngine.js';
import { resolveSettings } from './settingsService.js';
import { daysBetween, eachDay, round2, weekday } from './util.js';

/**
 * Payroll calculation for one employee and one period.
 *
 * Nothing here is specific to an organisation: amounts come from salary components (fixed, %,
 * per day, per hour, formula, manual entries...), the employee's salary revision, attendance,
 * leave, approved overtime, loan/advance installments, one-off entries, external payments and
 * adjustments. Every line records how it was calculated.
 */

const money = (n) => `Rs ${Number(n || 0).toLocaleString('en-LK', { maximumFractionDigits: 2 })}`;

/** Variables formulas may use. Component codes are added at calculation time. */
export const BASE_VARIABLES = {
    BasicSalary: 'Basic salary from the effective salary revision (pro-rated if the salary changed mid-period)',
    DailyRate: 'Daily rate: from the revision, otherwise BasicSalary / WorkingDays',
    HourlyRate: 'Hourly rate: from the revision, otherwise DailyRate / WorkingHours',
    OTRate: 'Overtime rate: from the revision, otherwise HourlyRate × default OT multiplier',
    WorkingDays: 'Working days per month (settings / group / employee)',
    WorkingHours: 'Working hours per day (settings / group / employee)',
    CalendarDays: 'Days in the payroll period',
    ScheduledDays: 'Scheduled working days in the period (excludes weekly off days and holidays)',
    EmployedScheduledDays: 'Scheduled working days while employed (joiners / leavers)',
    ProrationFactor: 'EmployedScheduledDays / ScheduledDays (1 for a full month)',
    PresentDays: 'Days worked (half days count 0.5)',
    AbsentDays: 'Days marked absent (plus missing days when settings treat them as absent)',
    PaidLeaveDays: 'Approved paid leave days',
    UnpaidLeaveDays: 'Approved unpaid / no-pay leave days',
    LeaveDays: 'All approved leave days',
    NoPayDays: 'AbsentDays + UnpaidLeaveDays',
    HolidayDays: 'Holidays in the period while employed',
    PaidDays: 'PresentDays + PaidLeaveDays + HolidayDays',
    WorkedHours: 'Total worked hours',
    NormalHours: 'Worked hours up to the normal day',
    LateMinutes: 'Total minutes late beyond the grace period',
    LateCount: 'Number of late days',
    EarlyLeaveMinutes: 'Total minutes left early',
    OTHours: 'Approved overtime hours (all types)',
    OTAmount: 'Approved overtime value (hours × rate per overtime type)',
    LoanDeduction: 'Loan installments due this period',
    AdvanceDeduction: 'Salary advance installments due this period',
    EPFApplicable: '1 if EPF applies to the employee, otherwise 0',
    ETFApplicable: '1 if ETF applies to the employee, otherwise 0',
    EPFEmployeeRate: 'EPF employee contribution % (settings)',
    EPFEmployerRate: 'EPF employer contribution % (settings)',
    ETFRate: 'ETF % (settings)',
    GrossSalary: 'Sum of earnings included in gross (available to deductions/employer lines)',
    EPFBase: 'Sum of EPF-applicable earnings',
    ETFBase: 'Sum of ETF-applicable earnings',
    TaxableGross: 'Sum of taxable earnings',
    TotalDeductions: 'Deductions calculated so far (available to later deductions)',
};

const dynamicVariableNames = (otCodes) => otCodes.flatMap(c => [`OTHours_${c}`, `OTAmount_${c}`]);

/** All variable names a formula can reference, for validation in the admin UI. */
export const availableVariables = async () => {
    const [components, otTypes] = await Promise.all([
        SalaryComponent.find({ deletedAt: null }).select('code').lean(),
        OvertimeType.find({ deletedAt: null }).select('code').lean(),
    ]);
    return [...Object.keys(BASE_VARIABLES), ...dynamicVariableNames(otTypes.map(t => t.code)), ...components.map(c => c.code)];
};

const overlapRevisions = (employeeId, start, end) => EmployeeSalary.find({
    employee: employeeId,
    status: { $ne: 'cancelled' },
    effectiveFrom: { $lte: end },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: start } }],
}).sort({ effectiveFrom: 1 }).lean();

const describe = (cfg, value, vars, comp, result) => {
    switch (cfg.calculationType) {
        case 'fixed': return `Fixed amount ${money(value)}`;
        case 'percentage': return `${cfg.value}% of ${result.baseLabel} (${money(result.base)})`;
        case 'perDay': return `${money(cfg.value)} × ${vars.PaidDays} paid day(s)`;
        case 'perAttendanceDay': return `${money(cfg.value)} × ${vars.PresentDays} day(s) present`;
        case 'perHour': return `${money(cfg.value)} × ${vars.NormalHours} hour(s)`;
        case 'manual': return result.explanation || 'Entered for this period';
        case 'external': return result.explanation || 'External payment';
        case 'formula': return result.explanation || `${cfg.formula} = ${result.expression}`;
        default: return comp.name;
    }
};

/**
 * @returns {Promise<object>} run-employee document data (items, totals, variables, warnings, blockers)
 */
export const calculateEmployeePayroll = async (employee, period, ctx = {}) => {
    const cache = ctx.cache || {};
    const settings = await resolveSettings(employee, cache);
    const warnings = [];
    const blockers = [];
    const { startDate: start, endDate: end, code } = period;

    // ── Salary revision(s) ──────────────────────────────────────────
    const revisions = await overlapRevisions(employee._id, start, end);
    if (!revisions.length) {
        return { skip: true, reason: `${employee.employeeCode}: no salary revision effective in ${code}` };
    }
    const revision = revisions[revisions.length - 1];
    const calendarDays = daysBetween(start, end) + 1;
    let basic = revision.basicSalary;
    let basicNote = '';
    if (revisions.length > 1) {
        // Weighted by calendar days each revision was effective in the period.
        let total = 0;
        const parts = [];
        for (const r of revisions) {
            const from = r.effectiveFrom > start ? r.effectiveFrom : start;
            const to = r.effectiveTo && r.effectiveTo < end ? r.effectiveTo : end;
            const days = Math.max(0, daysBetween(from, to) + 1);
            total += r.basicSalary * days / calendarDays;
            parts.push(`${money(r.basicSalary)} × ${days}/${calendarDays} days`);
        }
        basic = round2(total);
        basicNote = `Salary changed during the period: ${parts.join(' + ')}`;
    }

    cache.structures ??= new Map();
    const structureKey = String(revision.structure);
    if (!cache.structures.has(structureKey)) {
        cache.structures.set(structureKey, await SalaryStructure.findById(revision.structure).populate('lines.component').lean());
    }
    const structure = cache.structures.get(structureKey);
    if (!structure) return { skip: true, reason: `${employee.employeeCode}: salary structure not found` };

    // ── Attendance & leave ──────────────────────────────────────────
    const joined = employee.joiningDate ? new Date(employee.joiningDate).toISOString().slice(0, 10) : start;
    const left = employee.leavingDate ? new Date(employee.leavingDate).toISOString().slice(0, 10) : null;
    const empStart = joined > start ? joined : start;
    const empEnd = left && left < end ? left : end;
    if (empStart > empEnd) return { skip: true, reason: `${employee.employeeCode}: not employed during ${code}` };

    cache.holidays ??= new Map();
    if (!cache.holidays.has(code)) {
        cache.holidays.set(code, await Holiday.find({ date: { $gte: start, $lte: end }, deletedAt: null, ...OBSERVED }).lean());
    }
    const holidays = cache.holidays.get(code).filter(h => !h.orgUnits?.length
        || h.orgUnits.map(String).some(u => [employee.company, employee.branch, employee.hub, employee.location].filter(Boolean).map(x => String(x._id || x)).includes(u)));
    const holidaySet = new Set(holidays.map(h => h.date));
    const offDays = settings.weeklyOffDays || [];
    const isScheduled = (d) => !offDays.includes(weekday(d)) && !holidaySet.has(d);
    const scheduledDays = eachDay(start, end).filter(isScheduled).length;
    const employedScheduled = eachDay(empStart, empEnd).filter(isScheduled);

    const records = await Attendance.find({ employee: employee._id, date: { $gte: empStart, $lte: empEnd }, deletedAt: null }).lean();
    const att = {
        present: 0, absent: 0, halfDays: 0, late: 0, paidLeave: 0, unpaidLeave: 0, holidays: 0, offDays: 0, remote: 0,
        workedHours: 0, normalHours: 0, otHoursRecorded: 0, lateMinutes: 0, earlyLeaveMinutes: 0, missingCheckout: 0, missingDays: 0, records: records.length,
    };
    const recordDays = new Set();
    for (const r of records) {
        recordDays.add(r.date);
        att.workedHours += r.workedHours || 0;
        att.normalHours += r.normalHours || 0;
        att.otHoursRecorded += r.otHours || 0;
        att.lateMinutes += r.lateMinutes || 0;
        att.earlyLeaveMinutes += r.earlyLeaveMinutes || 0;
        if (r.lateMinutes > 0) att.late += 1;
        if (r.missingCheckout) att.missingCheckout += 1;
        switch (r.status) {
            case 'present': case 'late': case 'early_leave': att.present += 1; break;
            case 'remote': att.present += 1; att.remote += 1; break;
            case 'half_day':
                att.present += 0.5; att.halfDays += 1;
                if (r.leaveRequest) { if (r.leavePaid === false) att.unpaidLeave += 0.5; else att.paidLeave += 0.5; } else att.absent += 0.5;
                break;
            case 'leave': if (r.leavePaid === false) att.unpaidLeave += 1; else att.paidLeave += 1; break;
            case 'absent': att.absent += 1; break;
            case 'holiday': att.holidays += 1; break;
            case 'off_day': att.offDays += 1; break;
            default: break;
        }
    }
    att.missingDays = employedScheduled.filter(d => !recordDays.has(d)).length;
    if (att.missingDays > 0 && employee.attendanceRequired) {
        if (settings.missingAttendance === 'absent') {
            att.absent += att.missingDays;
            warnings.push(`${att.missingDays} scheduled day(s) without attendance were counted as absent`);
        } else {
            warnings.push(`${att.missingDays} scheduled day(s) have no attendance record`);
        }
    }
    if (att.missingCheckout) warnings.push(`${att.missingCheckout} day(s) with a missing check-out`);
    const holidayDays = holidays.filter(h => h.date >= empStart && h.date <= empEnd && h.paid !== false).length;

    // ── Rates ───────────────────────────────────────────────────────
    const workingDays = Number(settings.workingDaysPerMonth) || 26;
    const workingHours = Number(settings.workingHoursPerDay) || 8;
    const dailyRate = revision.dailyRate ?? round2(basic / workingDays);
    const hourlyRate = revision.hourlyRate ?? round2(dailyRate / workingHours);
    const otRate = revision.otRate ?? round2(hourlyRate * (Number(settings.defaultOtMultiplier) || 1.5));

    const vars = {
        BasicSalary: basic,
        DailyRate: dailyRate,
        HourlyRate: hourlyRate,
        OTRate: otRate,
        WorkingDays: workingDays,
        WorkingHours: workingHours,
        CalendarDays: calendarDays,
        ScheduledDays: scheduledDays,
        EmployedScheduledDays: employedScheduled.length,
        ProrationFactor: scheduledDays ? round2(employedScheduled.length / scheduledDays * 10000) / 10000 : 1,
        PresentDays: round2(att.present),
        AbsentDays: round2(att.absent),
        PaidLeaveDays: round2(att.paidLeave),
        UnpaidLeaveDays: round2(att.unpaidLeave),
        LeaveDays: round2(att.paidLeave + att.unpaidLeave),
        NoPayDays: round2(att.absent + att.unpaidLeave),
        HolidayDays: holidayDays,
        PaidDays: round2(att.present + att.paidLeave + holidayDays),
        WorkedHours: round2(att.workedHours),
        NormalHours: round2(att.normalHours),
        LateMinutes: att.lateMinutes,
        LateCount: att.late,
        EarlyLeaveMinutes: att.earlyLeaveMinutes,
        EPFApplicable: employee.statutory?.epfApplicable === false ? 0 : 1,
        ETFApplicable: employee.statutory?.etfApplicable === false ? 0 : 1,
        EPFEmployeeRate: Number(settings.epfEmployeeRate) || 0,
        EPFEmployerRate: Number(settings.epfEmployerRate) || 0,
        ETFRate: Number(settings.etfRate) || 0,
    };

    cache.tables ??= Object.fromEntries((await TaxTable.find({ active: true, deletedAt: null }).lean()).map(t => [t.code, t]));
    const evalFormula = (formula) => evaluate(formula, vars, { tables: cache.tables });

    // ── Overtime ────────────────────────────────────────────────────
    cache.otTypes ??= await OvertimeType.find({ deletedAt: null }).lean();
    cache.otTypes.forEach(t => { vars[`OTHours_${t.code}`] = 0; vars[`OTAmount_${t.code}`] = 0; });
    const otEntries = await OvertimeEntry.find({ employee: employee._id, date: { $gte: start, $lte: end }, status: 'approved', deletedAt: null }).lean();
    const pendingOt = await OvertimeEntry.countDocuments({ employee: employee._id, date: { $gte: start, $lte: end }, status: 'pending', deletedAt: null });
    if (pendingOt) warnings.push(`${pendingOt} overtime entr${pendingOt === 1 ? 'y is' : 'ies are'} still pending approval and not paid`);
    let otHours = 0;
    let otAmount = 0;
    const otParts = [];
    const byType = new Map();
    otEntries.forEach(e => byType.set(String(e.overtimeType), (byType.get(String(e.overtimeType)) || 0) + e.hours));
    for (const [typeId, hours] of byType) {
        const type = cache.otTypes.find(t => String(t._id) === typeId);
        if (!type) continue;
        let rate;
        let rateNote;
        if (type.rateFormula) {
            try {
                rate = round2(evalFormula(type.rateFormula).value);
                rateNote = type.rateFormula;
            } catch (err) {
                blockers.push(`Overtime type ${type.code}: ${err.message}`);
                continue;
            }
        } else if (type.code === 'NORMAL' && revision.otRate != null) {
            rate = revision.otRate;
            rateNote = 'OT rate from salary';
        } else {
            rate = round2(hourlyRate * type.multiplier);
            rateNote = `${money(hourlyRate)} × ${type.multiplier}`;
        }
        const amount = round2(hours * rate);
        vars[`OTHours_${type.code}`] = round2(hours);
        vars[`OTAmount_${type.code}`] = amount;
        otHours += hours;
        otAmount += amount;
        otParts.push(`${type.name}: ${round2(hours)} h × ${money(rate)} (${rateNote}) = ${money(amount)}`);
    }
    vars.OTHours = round2(otHours);
    vars.OTAmount = round2(otAmount);

    // ── Loans & advances ────────────────────────────────────────────
    const installments = await Installment.find({ employee: employee._id, period: code, status: 'scheduled' }).lean();
    const activeSources = new Set((await Advance.find({ _id: { $in: installments.map(i => i.source) }, status: { $in: ['approved', 'active'] }, deletedAt: null }).select('_id').lean()).map(a => String(a._id)));
    const dueInstallments = installments.filter(i => activeSources.has(String(i.source)));
    vars.LoanDeduction = round2(dueInstallments.filter(i => i.kind === 'loan').reduce((s, i) => s + i.amount, 0));
    vars.AdvanceDeduction = round2(dueInstallments.filter(i => i.kind === 'advance').reduce((s, i) => s + i.amount, 0));

    // ── One-off entries, external payments, adjustments ────────────
    const [entries, externals, adjustments] = await Promise.all([
        PayrollEntry.find({ employee: employee._id, period: code, status: 'approved', deletedAt: null }).populate('component').lean(),
        ExternalPayment.find({ employee: employee._id, period: code, status: 'approved', payrollTreatment: { $ne: 'none' }, deletedAt: null }).lean(),
        PayrollAdjustment.find({ employee: employee._id, targetPeriod: code, status: 'approved', deletedAt: null }).lean(),
    ]);

    // ── Build the list of lines to calculate ───────────────────────
    cache.componentsByCode ??= new Map((await SalaryComponent.find({ deletedAt: null }).lean()).map(c => [c.code, c]));
    const componentById = (id) => [...cache.componentsByCode.values()].find(c => String(c._id) === String(id));

    const lines = [];
    const overrides = new Map((revision.overrides || []).map(o => [String(o.component), o]));
    for (const line of structure.lines || []) {
        const comp = line.component;
        if (!comp || comp.deletedAt || !comp.active) continue;
        const ov = overrides.get(String(comp._id));
        if (ov && ov.enabled === false) continue;
        const cfg = {
            calculationType: line.calculationType ?? comp.calculationType,
            value: line.value ?? comp.value,
            percentageBase: line.percentageBase ?? comp.percentageBase,
            baseComponent: line.baseComponent ?? comp.baseComponent,
            formula: line.formula ?? comp.formula,
            order: line.order ?? comp.displayOrder,
        };
        let source = 'structure';
        if (ov) {
            if (ov.calculationType) cfg.calculationType = ov.calculationType;
            if (ov.value != null) cfg.value = ov.value;
            if (ov.formula) cfg.formula = ov.formula;
            source = 'override';
        }
        lines.push({ comp, cfg, source });
    }
    for (const add of revision.additionalComponents || []) {
        const comp = componentById(add.component);
        if (!comp || !comp.active || add.enabled === false || lines.some(l => l.comp.code === comp.code)) continue;
        lines.push({
            comp,
            cfg: {
                calculationType: add.calculationType || comp.calculationType, value: add.value ?? comp.value,
                percentageBase: comp.percentageBase, baseComponent: comp.baseComponent, formula: add.formula || comp.formula, order: comp.displayOrder,
            },
            source: 'additional',
        });
    }
    // Entries for components not on the structure are added automatically as manual lines.
    for (const e of entries) {
        if (e.component && !lines.some(l => l.comp.code === e.component.code)) {
            lines.push({ comp: e.component, cfg: { calculationType: 'manual', value: 0, order: e.component.displayOrder }, source: 'entry' });
        }
    }
    const autoLine = (code, calculationType = 'external') => {
        const comp = cache.componentsByCode.get(code);
        if (comp && !lines.some(l => l.comp.code === code)) lines.push({ comp, cfg: { calculationType, value: 0, order: comp.displayOrder }, source: 'auto' });
    };
    if (externals.some(x => x.payrollTreatment === 'earning')) autoLine('EXTERNAL_PAY');
    if (externals.some(x => x.payrollTreatment === 'paid_outside')) autoLine('PAID_OUTSIDE');
    if (adjustments.some(a => a.type === 'earning')) autoLine('ADJ_EARN');
    if (adjustments.some(a => a.type === 'deduction')) autoLine('ADJ_DEDUCT');
    if (vars.LoanDeduction > 0) autoLine('LOAN', 'formula');
    if (vars.AdvanceDeduction > 0) autoLine('ADVANCE', 'formula');
    if (vars.OTAmount > 0) autoLine('OT', 'formula');

    // Components' codes are formula variables too; default them to 0 so references to optional
    // components that this employee does not have still evaluate.
    for (const c of cache.componentsByCode.values()) vars[c.code] = 0;

    const typeRank = { earning: 0, deduction: 1, employer: 2 };
    lines.sort((a, b) => (typeRank[a.comp.type] - typeRank[b.comp.type]) || ((a.cfg.order ?? 100) - (b.cfg.order ?? 100)));

    // ── Calculate ───────────────────────────────────────────────────
    const items = [];
    let grossDone = false;
    const sums = { gross: 0, epf: 0, etf: 0, taxable: 0, earnings: 0, deductions: 0 };
    const finishGross = () => {
        if (grossDone) return;
        vars.GrossSalary = round2(sums.gross);
        vars.EPFBase = round2(sums.epf);
        vars.ETFBase = round2(sums.etf);
        vars.TaxableGross = round2(sums.taxable);
        vars.TotalEarnings = round2(sums.earnings);
        grossDone = true;
    };

    for (const { comp, cfg, source } of lines) {
        if (comp.type !== 'earning') finishGross();
        vars.TotalDeductions = round2(sums.deductions);
        let value = 0;
        const result = { variables: {}, expression: '', explanation: '' };
        let sourceRef = null;
        try {
            switch (cfg.calculationType) {
                case 'fixed':
                    value = Number(cfg.value) || 0;
                    break;
                case 'percentage': {
                    let base;
                    let label;
                    switch (cfg.percentageBase) {
                        case 'gross': finishGross(); base = vars.GrossSalary; label = 'Gross Salary'; break;
                        case 'epfBase': finishGross(); base = vars.EPFBase; label = 'EPF base'; break;
                        case 'taxableGross': finishGross(); base = vars.TaxableGross; label = 'Taxable gross'; break;
                        case 'component': base = vars[cfg.baseComponent] ?? 0; label = cfg.baseComponent; break;
                        default: base = vars.BasicSalary; label = 'Basic Salary';
                    }
                    value = base * (Number(cfg.value) || 0) / 100;
                    result.base = base;
                    result.baseLabel = label;
                    break;
                }
                case 'perDay': value = (Number(cfg.value) || 0) * vars.PaidDays; break;
                case 'perAttendanceDay': value = (Number(cfg.value) || 0) * vars.PresentDays; break;
                case 'perHour': value = (Number(cfg.value) || 0) * vars.NormalHours; break;
                case 'formula': {
                    if (!cfg.formula) throw new FormulaError('No formula set');
                    const r = evalFormula(cfg.formula);
                    value = r.value;
                    result.variables = r.used;
                    result.expression = r.expression;
                    result.explanation = `${cfg.formula} = ${r.expression}`;
                    if (comp.code === 'OT' || /OTAmount/.test(cfg.formula)) result.explanation = `${result.explanation}\n${otParts.join('\n')}`;
                    if (comp.code === 'BASIC' && basicNote) result.explanation = `${result.explanation}\n${basicNote}`;
                    if (comp.code === 'LOAN' || comp.code === 'ADVANCE') {
                        const kind = comp.code === 'LOAN' ? 'loan' : 'advance';
                        result.explanation += `\n${dueInstallments.filter(i => i.kind === kind).map(i => `Installment #${i.sequence}: ${money(i.amount)}`).join('\n')}`;
                    }
                    break;
                }
                case 'manual': {
                    const mine = entries.filter(e => String(e.component?._id) === String(comp._id));
                    value = mine.reduce((s, e) => s + e.amount, 0) + (mine.length ? 0 : Number(cfg.value) || 0);
                    result.explanation = mine.length
                        ? mine.map(e => `${e.quantity != null && e.rate != null ? `${e.quantity} × ${money(e.rate)}` : money(e.amount)}${e.note ? ` (${e.note})` : ''}`).join(' + ')
                        : (cfg.value ? `Default ${money(cfg.value)}` : 'No entry this period');
                    break;
                }
                case 'external': {
                    if (comp.code === 'ADJ_EARN' || comp.code === 'ADJ_DEDUCT') {
                        const type = comp.code === 'ADJ_EARN' ? 'earning' : 'deduction';
                        const mine = adjustments.filter(a => a.type === type);
                        value = mine.reduce((s, a) => s + a.amount, 0);
                        result.explanation = mine.map(a => `${money(a.amount)} — ${a.reason} (for ${a.originalPeriod})`).join('\n');
                    } else {
                        const treatment = comp.code === 'PAID_OUTSIDE' ? 'paid_outside' : 'earning';
                        const mine = externals.filter(x => x.payrollTreatment === treatment);
                        value = mine.reduce((s, x) => s + x.amount, 0);
                        result.explanation = mine.map(x => `${money(x.amount)} ${x.paymentType} on ${x.date}${x.referenceNumber ? ` ref ${x.referenceNumber}` : ''}`).join('\n');
                    }
                    break;
                }
                default: value = 0;
            }
        } catch (err) {
            blockers.push(`${comp.name} (${comp.code}): ${err.message}`);
            value = 0;
        }
        value = round2(value);
        vars[comp.code] = value;

        if (comp.type === 'earning') {
            if (comp.includeInGross) sums.gross += value;
            if (comp.epfApplicable) sums.epf += value;
            if (comp.etfApplicable) sums.etf += value;
            if (comp.taxable) sums.taxable += value;
            if (comp.includeInNet) sums.earnings += value;
        } else if (comp.type === 'deduction' && comp.includeInNet) {
            sums.deductions += value;
        }
        if (value === 0 && comp.skipIfZero) continue;
        items.push({
            code: comp.code,
            name: comp.name,
            type: comp.type,
            category: comp.category,
            amount: value,
            taxable: comp.taxable,
            epfApplicable: comp.epfApplicable,
            includeInGross: comp.includeInGross,
            includeInNet: comp.includeInNet,
            showOnPayslip: comp.showOnPayslip,
            source,
            sourceRef,
            calculation: {
                method: cfg.calculationType,
                formula: cfg.formula || '',
                expression: result.expression || '',
                variables: result.variables,
                explanation: describe(cfg, value, vars, comp, result),
            },
        });
    }
    finishGross();

    const employer = round2(items.filter(i => i.type === 'employer').reduce((s, i) => s + i.amount, 0));
    let net = round2(sums.earnings - sums.deductions);
    const roundTo = Number(settings.roundNetTo) || 0;
    if (roundTo > 0) {
        const rounded = Math.round(net / roundTo) * roundTo;
        if (rounded !== net) {
            items.push({
                code: 'ROUNDING', name: 'Net pay rounding', type: rounded > net ? 'earning' : 'deduction', category: 'other',
                amount: round2(Math.abs(rounded - net)), includeInGross: false, includeInNet: true, showOnPayslip: true, source: 'auto',
                calculation: { method: 'rounding', explanation: `Net ${money(net)} rounded to nearest ${roundTo}` },
            });
            net = rounded;
        }
    }

    if (net < 0) blockers.push(`Net pay is negative (${money(net)}). Reduce deductions or reschedule installments.`);
    const paymentMethod = employee.paymentMethod || settings.defaultPaymentMethod;
    if (paymentMethod === 'bank_transfer' && settings.requireBankForBankTransfer && !employee.bank?.accountNumber) {
        blockers.push('Bank transfer selected but no bank account number is recorded');
    }

    return {
        revision,
        structure,
        settings,
        variables: vars,
        attendance: { ...att, holidaysInPeriod: holidayDays, scheduledDays, employedScheduledDays: employedScheduled.length },
        leave: { paidLeaveDays: vars.PaidLeaveDays, unpaidLeaveDays: vars.UnpaidLeaveDays },
        items,
        gross: vars.GrossSalary,
        totalEarnings: round2(sums.earnings),
        totalDeductions: round2(sums.deductions),
        employerContributions: employer,
        net,
        warnings,
        blockers,
        paymentMethod,
        sources: {
            installments: dueInstallments.map(i => i._id),
            entries: entries.map(e => e._id),
            externals: externals.map(x => x._id),
            adjustments: adjustments.map(a => a._id),
        },
    };
};
