import mongoose from 'mongoose';
import {
    Advance, Attendance, Employee, EmployeeSalary, ExternalPayment, LeaveBalance, LeaveRequest, OvertimeEntry,
    PayrollRun, PayrollRunEmployee,
} from '../models/index.js';
import { localTime, periodOf, round2 } from './util.js';

/**
 * Report definitions. Every report accepts the same filters:
 *   from, to (YYYY-MM-DD), employee, company, branch, hub, department, group, status
 * and returns { columns, rows, summary }. Exports (Excel / PDF / CSV) use the same output.
 */

const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);

const employeeIdsFor = async (f, allowed) => {
    const q = { deletedAt: null };
    for (const k of ['company', 'branch', 'hub', 'department', 'group']) if (oid(f[k])) q[k] = oid(f[k]);
    if (oid(f.employee)) q._id = oid(f.employee);
    if (allowed) q._id = q._id ? (allowed.some(a => String(a) === String(q._id)) ? q._id : null) : { $in: allowed };
    const hasFilter = Object.keys(q).length > 1;
    if (!hasFilter) return null;
    return (await Employee.find(q).select('_id').lean()).map(e => e._id);
};

const empLookup = async (ids) => new Map((await Employee.find({ _id: { $in: ids } })
    .populate('department branch hub designation group', 'name').lean()).map(e => [String(e._id), e]));

const empCols = [
    { key: 'employeeCode', header: 'Employee ID', width: 12 },
    { key: 'employeeName', header: 'Employee Name', width: 26 },
    { key: 'department', header: 'Department', width: 18 },
];
const empRow = (e) => ({ employeeCode: e?.employeeCode, employeeName: e?.fullName, department: e?.department?.name || '', branch: e?.branch?.name || '', hub: e?.hub?.name || '' });

const periodRange = (f) => ({
    from: f.from ? periodOf(f.from) : '0000-00',
    to: f.to ? periodOf(f.to) : '9999-12',
});

const payrollLines = async (f, empIds) => {
    const { from, to } = periodRange(f);
    const runs = await PayrollRun.find({ status: f.status ? f.status : { $ne: 'cancelled' }, periodCode: { $gte: from, $lte: to }, deletedAt: null }).select('_id status runNumber').lean();
    const q = { run: { $in: runs.map(r => r._id) }, status: 'active' };
    if (empIds) q.employee = { $in: empIds };
    for (const [k, snap] of [['company', 'companyId'], ['branch', 'branchId'], ['hub', 'hubId'], ['department', 'departmentId'], ['group', 'groupId']]) {
        if (oid(f[k])) q[`snapshot.${snap}`] = oid(f[k]);
    }
    const lines = await PayrollRunEmployee.find(q).sort({ periodCode: 1, 'snapshot.employeeCode': 1 }).lean();
    const runById = new Map(runs.map(r => [String(r._id), r]));
    return lines.map(l => ({ ...l, runStatus: runById.get(String(l.run))?.status, runNumber: runById.get(String(l.run))?.runNumber }));
};

const sumCat = (items, pred) => round2((items || []).filter(pred).reduce((s, i) => s + i.amount, 0));
const lineEarn = (l) => ({
    basic: sumCat(l.items, i => i.category === 'basic'),
    allowances: sumCat(l.items, i => i.type === 'earning' && ['allowance', 'serviceCharge', 'commission', 'external'].includes(i.category)),
    overtime: sumCat(l.items, i => i.category === 'overtime'),
    bonus: sumCat(l.items, i => i.category === 'bonus'),
});

const payrollCols = [
    { key: 'period', header: 'Period', width: 9 },
    ...empCols,
    { key: 'basic', header: 'Basic', type: 'money' },
    { key: 'allowances', header: 'Allowances', type: 'money' },
    { key: 'overtime', header: 'OT', type: 'money' },
    { key: 'bonus', header: 'Bonus', type: 'money' },
    { key: 'gross', header: 'Gross', type: 'money' },
    { key: 'deductions', header: 'Deductions', type: 'money' },
    { key: 'net', header: 'Net', type: 'money' },
    { key: 'paymentStatus', header: 'Payment Status', width: 14 },
];

const groupBy = (lines, keyFn, labelHeader) => {
    const map = new Map();
    for (const l of lines) {
        const k = keyFn(l) || '(none)';
        const cur = map.get(k) || { group: k, employees: new Set(), gross: 0, deductions: 0, net: 0, employer: 0 };
        cur.employees.add(String(l.employee));
        cur.gross += l.gross; cur.deductions += l.totalDeductions; cur.net += l.net; cur.employer += l.employerContributions;
        map.set(k, cur);
    }
    return {
        columns: [
            { key: 'group', header: labelHeader, width: 26 },
            { key: 'employees', header: 'Employees', type: 'number' },
            { key: 'gross', header: 'Gross', type: 'money' },
            { key: 'deductions', header: 'Deductions', type: 'money' },
            { key: 'net', header: 'Net', type: 'money' },
            { key: 'employer', header: 'Employer Contributions', type: 'money' },
            { key: 'cost', header: 'Total Cost', type: 'money' },
        ],
        rows: [...map.values()].map(g => ({
            group: g.group, employees: g.employees.size, gross: round2(g.gross), deductions: round2(g.deductions), net: round2(g.net),
            employer: round2(g.employer), cost: round2(g.gross + g.employer),
        })),
    };
};

const totals = (rows, keys) => keys.map(([k, label]) => [label, round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0))]);

const dateFilter = (f) => ({ ...(f.from || f.to ? { $gte: f.from || '0000-00-00', $lte: f.to || '9999-12-31' } : {}) });

export const REPORTS = {
    'employee-salary': {
        title: 'Employee Salary Report', sensitive: true,
        async run(f, ids) {
            const q = { status: { $ne: 'cancelled' }, effectiveTo: null };
            if (ids) q.employee = { $in: ids };
            const revs = await EmployeeSalary.find(q).populate('structure', 'name payBasis').lean();
            const emps = await empLookup(revs.map(r => r.employee));
            const rows = revs.map(r => ({
                ...empRow(emps.get(String(r.employee))), structure: r.structure?.name, payBasis: r.structure?.payBasis,
                basic: r.basicSalary, dailyRate: r.dailyRate, hourlyRate: r.hourlyRate, otRate: r.otRate, effectiveFrom: r.effectiveFrom,
            })).filter(r => r.employeeCode);
            return {
                columns: [...empCols, { key: 'structure', header: 'Structure', width: 22 }, { key: 'payBasis', header: 'Basis' },
                    { key: 'basic', header: 'Basic', type: 'money' }, { key: 'dailyRate', header: 'Daily Rate', type: 'money' },
                    { key: 'hourlyRate', header: 'Hourly Rate', type: 'money' }, { key: 'otRate', header: 'OT Rate', type: 'money' },
                    { key: 'effectiveFrom', header: 'Effective From' }],
                rows,
            };
        },
    },
    'monthly-payroll': {
        title: 'Monthly Payroll Report', sensitive: true,
        async run(f, ids) {
            const lines = await payrollLines(f, ids);
            const rows = lines.map(l => ({
                period: l.periodCode, employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.fullName, department: l.snapshot.department,
                ...lineEarn(l), gross: l.gross, deductions: l.totalDeductions, net: l.net, paymentStatus: l.payment?.status,
            }));
            return { columns: payrollCols, rows, summary: totals(rows, [['gross', 'Total gross'], ['deductions', 'Total deductions'], ['net', 'Total net']]) };
        },
    },
    'department-payroll': { title: 'Department Payroll Report', sensitive: true, async run(f, ids) { return groupBy(await payrollLines(f, ids), l => l.snapshot.department, 'Department'); } },
    'branch-payroll': { title: 'Branch Payroll Report', sensitive: true, async run(f, ids) { return groupBy(await payrollLines(f, ids), l => l.snapshot.branch, 'Branch'); } },
    'hub-payroll': { title: 'Hub Payroll Report', sensitive: true, async run(f, ids) { return groupBy(await payrollLines(f, ids), l => l.snapshot.hub, 'Hub'); } },
    'group-payroll': { title: 'Employee Group Payroll Report', sensitive: true, async run(f, ids) { return groupBy(await payrollLines(f, ids), l => l.snapshot.group, 'Employee Group'); } },
    'payroll-summary': {
        title: 'Payroll Summary', sensitive: true,
        async run(f, ids) { return groupBy(await payrollLines(f, ids), l => l.periodCode, 'Period'); },
    },
    'employee-cost': {
        title: 'Employee Cost Report', sensitive: true,
        async run(f, ids) {
            const lines = await payrollLines(f, ids);
            const map = new Map();
            lines.forEach(l => {
                const k = String(l.employee);
                const c = map.get(k) || { employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.fullName, department: l.snapshot.department, gross: 0, employer: 0, net: 0 };
                c.gross += l.gross; c.employer += l.employerContributions; c.net += l.net;
                map.set(k, c);
            });
            const rows = [...map.values()].map(r => ({ ...r, gross: round2(r.gross), employer: round2(r.employer), net: round2(r.net), cost: round2(r.gross + r.employer) }));
            return {
                columns: [...empCols, { key: 'gross', header: 'Gross', type: 'money' }, { key: 'employer', header: 'Employer Contributions', type: 'money' },
                    { key: 'cost', header: 'Total Cost', type: 'money' }, { key: 'net', header: 'Net Paid', type: 'money' }],
                rows, summary: totals(rows, [['cost', 'Total employee cost']]),
            };
        },
    },
    'bank-payment': {
        title: 'Bank Payment Report', sensitive: true,
        async run(f, ids) {
            const lines = (await payrollLines(f, ids)).filter(l => ['finalized', 'paid'].includes(l.runStatus) && l.payment?.method === 'bank_transfer');
            const rows = lines.map(l => ({
                period: l.periodCode, employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.accountName || l.snapshot.fullName,
                bank: l.snapshot.bankName, branch: l.snapshot.bankBranch, account: l.snapshot.accountNumber, amount: l.net,
                status: l.payment?.status, reference: l.payment?.reference, payslip: l.payslipNumber,
            }));
            return {
                columns: [{ key: 'period', header: 'Period' }, { key: 'employeeCode', header: 'Employee ID' }, { key: 'employeeName', header: 'Account Name', width: 26 },
                    { key: 'bank', header: 'Bank', width: 18 }, { key: 'branch', header: 'Branch', width: 16 }, { key: 'account', header: 'Account No.', width: 18 },
                    { key: 'amount', header: 'Amount', type: 'money' }, { key: 'status', header: 'Status' }, { key: 'reference', header: 'Reference' }, { key: 'payslip', header: 'Payslip No.' }],
                rows, summary: totals(rows, [['amount', 'Total to transfer']]),
            };
        },
    },
    payslips: {
        title: 'Payslip Report', sensitive: true,
        async run(f, ids) {
            const lines = (await payrollLines(f, ids)).filter(l => l.payslipNumber);
            const rows = lines.map(l => ({ payslip: l.payslipNumber, period: l.periodCode, employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.fullName, department: l.snapshot.department, net: l.net, paymentStatus: l.payment?.status, id: String(l._id) }));
            return { columns: [{ key: 'payslip', header: 'Payslip No.' }, { key: 'period', header: 'Period' }, ...empCols, { key: 'net', header: 'Net', type: 'money' }, { key: 'paymentStatus', header: 'Payment' }], rows };
        },
    },
    deductions: {
        title: 'Deduction Report', sensitive: true,
        async run(f, ids) {
            const rows = [];
            (await payrollLines(f, ids)).forEach(l => l.items.filter(i => i.type === 'deduction').forEach(i => rows.push({
                period: l.periodCode, employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.fullName, department: l.snapshot.department, component: i.name, amount: i.amount,
            })));
            return { columns: [{ key: 'period', header: 'Period' }, ...empCols, { key: 'component', header: 'Deduction', width: 22 }, { key: 'amount', header: 'Amount', type: 'money' }], rows, summary: totals(rows, [['amount', 'Total deductions']]) };
        },
    },
    allowances: {
        title: 'Allowance Report', sensitive: true,
        async run(f, ids) {
            const rows = [];
            (await payrollLines(f, ids)).forEach(l => l.items.filter(i => i.type === 'earning' && !['basic', 'overtime'].includes(i.category)).forEach(i => rows.push({
                period: l.periodCode, employeeCode: l.snapshot.employeeCode, employeeName: l.snapshot.fullName, department: l.snapshot.department, component: i.name, amount: i.amount,
            })));
            return { columns: [{ key: 'period', header: 'Period' }, ...empCols, { key: 'component', header: 'Allowance / Earning', width: 22 }, { key: 'amount', header: 'Amount', type: 'money' }], rows, summary: totals(rows, [['amount', 'Total']]) };
        },
    },
    attendance: {
        title: 'Attendance Report',
        async run(f, ids, extra = {}) {
            const q = { deletedAt: null, date: dateFilter(f) };
            if (!f.from && !f.to) delete q.date;
            if (ids) q.employee = { $in: ids };
            if (extra.status) q.status = extra.status;
            else if (f.status) q.status = f.status;
            if (extra.late) q.lateMinutes = { $gt: 0 };
            const recs = await Attendance.find(q).sort({ date: 1 }).limit(20000).lean();
            const emps = await empLookup([...new Set(recs.map(r => String(r.employee)))]);
            const rows = recs.map(r => ({
                ...empRow(emps.get(String(r.employee))), date: r.date, in: localTime(r.checkIn), out: localTime(r.checkOut), worked: r.workedHours,
                ot: r.otHours, late: r.lateMinutes, status: r.status, source: r.source, remarks: r.remarks,
            }));
            return {
                columns: [...empCols, { key: 'date', header: 'Date', width: 11 }, { key: 'in', header: 'In' }, { key: 'out', header: 'Out' },
                    { key: 'worked', header: 'Worked Hours', type: 'number' }, { key: 'ot', header: 'OT', type: 'number' }, { key: 'late', header: 'Late (min)', type: 'number' },
                    { key: 'status', header: 'Status' }, { key: 'source', header: 'Source' }, { key: 'remarks', header: 'Remarks', width: 24 }],
                rows,
            };
        },
    },
    'late-attendance': { title: 'Late Attendance Report', async run(f, ids) { return REPORTS.attendance.run(f, ids, { late: true }); } },
    absent: { title: 'Absent Report', async run(f, ids) { return REPORTS.attendance.run(f, ids, { status: 'absent' }); } },
    overtime: {
        title: 'Overtime Report',
        async run(f, ids) {
            const q = { deletedAt: null };
            if (f.from || f.to) q.date = dateFilter(f);
            if (ids) q.employee = { $in: ids };
            if (f.status) q.status = f.status;
            const recs = await OvertimeEntry.find(q).populate('overtimeType', 'name').sort({ date: 1 }).lean();
            const emps = await empLookup(recs.map(r => r.employee));
            const rows = recs.map(r => ({ ...empRow(emps.get(String(r.employee))), date: r.date, type: r.overtimeType?.name, hours: r.hours, status: r.status, source: r.source }));
            return { columns: [...empCols, { key: 'date', header: 'Date' }, { key: 'type', header: 'OT Type' }, { key: 'hours', header: 'Hours', type: 'number' }, { key: 'status', header: 'Status' }, { key: 'source', header: 'Source' }], rows, summary: totals(rows, [['hours', 'Total hours']]) };
        },
    },
    leave: {
        title: 'Leave Report',
        async run(f, ids) {
            const q = { deletedAt: null };
            if (f.from) q.toDate = { $gte: f.from };
            if (f.to) q.fromDate = { $lte: f.to };
            if (ids) q.employee = { $in: ids };
            if (f.status) q.status = f.status;
            const recs = await LeaveRequest.find(q).populate('leaveType', 'name paid').sort({ fromDate: 1 }).lean();
            const emps = await empLookup(recs.map(r => r.employee));
            const rows = recs.map(r => ({ ...empRow(emps.get(String(r.employee))), type: r.leaveType?.name, paid: r.leaveType?.paid ? 'Paid' : 'Unpaid', from: r.fromDate, to: r.toDate, days: r.days, status: r.status, reason: r.reason }));
            return { columns: [...empCols, { key: 'type', header: 'Leave Type' }, { key: 'paid', header: 'Paid?' }, { key: 'from', header: 'From' }, { key: 'to', header: 'To' }, { key: 'days', header: 'Days', type: 'number' }, { key: 'status', header: 'Status' }, { key: 'reason', header: 'Reason', width: 24 }], rows };
        },
    },
    'leave-balance': {
        title: 'Leave Balance Report',
        async run(f, ids) {
            const year = Number((f.to || f.from || new Date().toISOString()).slice(0, 4));
            const q = { year };
            if (ids) q.employee = { $in: ids };
            const recs = await LeaveBalance.find(q).populate('leaveType', 'name').lean({ virtuals: true });
            const emps = await empLookup(recs.map(r => r.employee));
            const rows = recs.map(r => ({
                ...empRow(emps.get(String(r.employee))), type: r.leaveType?.name, year: r.year, opening: r.opening, accrued: r.accrued, adjusted: r.adjusted,
                used: r.used, pending: r.pending, remaining: round2(r.opening + r.accrued + r.adjusted - r.used - r.pending),
            })).filter(r => r.employeeCode);
            return { columns: [...empCols, { key: 'type', header: 'Leave Type' }, { key: 'year', header: 'Year' }, { key: 'opening', header: 'Opening', type: 'number' }, { key: 'accrued', header: 'Accrued', type: 'number' }, { key: 'adjusted', header: 'Adjusted', type: 'number' }, { key: 'used', header: 'Used', type: 'number' }, { key: 'pending', header: 'Pending', type: 'number' }, { key: 'remaining', header: 'Remaining', type: 'number' }], rows };
        },
    },
    advances: { title: 'Salary Advance Report', sensitive: true, async run(f, ids) { return advanceReport('advance', f, ids); } },
    loans: { title: 'Loan Report', sensitive: true, async run(f, ids) { return advanceReport('loan', f, ids); } },
    'salary-revisions': {
        title: 'Salary Revision Report', sensitive: true,
        async run(f, ids) {
            const q = {};
            if (f.from || f.to) q.effectiveFrom = dateFilter(f);
            if (ids) q.employee = { $in: ids };
            const revs = await EmployeeSalary.find(q).populate('structure', 'name').populate('createdBy', 'name').sort({ effectiveFrom: 1 }).lean();
            const emps = await empLookup(revs.map(r => r.employee));
            const rows = revs.map(r => ({ ...empRow(emps.get(String(r.employee))), structure: r.structure?.name, basic: r.basicSalary, from: r.effectiveFrom, to: r.effectiveTo || 'current', status: r.status, reason: r.reason, by: r.createdBy?.name }));
            return { columns: [...empCols, { key: 'structure', header: 'Structure' }, { key: 'basic', header: 'Basic', type: 'money' }, { key: 'from', header: 'From' }, { key: 'to', header: 'To' }, { key: 'status', header: 'Status' }, { key: 'reason', header: 'Reason', width: 22 }, { key: 'by', header: 'Created By' }], rows };
        },
    },
    'external-payments': {
        title: 'External Payment Report', sensitive: true,
        async run(f, ids) {
            const q = { deletedAt: null };
            if (f.from || f.to) q.date = dateFilter(f);
            if (ids) q.employee = { $in: ids };
            if (f.status) q.status = f.status;
            const recs = await ExternalPayment.find(q).populate('approvedBy', 'name').sort({ date: 1 }).lean();
            const emps = await empLookup(recs.map(r => r.employee));
            const rows = recs.map(r => ({ ...empRow(emps.get(String(r.employee))), date: r.date, type: r.paymentType, amount: r.amount, method: r.paymentMethod, reference: r.referenceNumber, period: r.period, treatment: r.payrollTreatment, status: r.status, approvedBy: r.approvedBy?.name }));
            return { columns: [...empCols, { key: 'date', header: 'Date' }, { key: 'type', header: 'Type' }, { key: 'amount', header: 'Amount', type: 'money' }, { key: 'method', header: 'Method' }, { key: 'reference', header: 'Reference' }, { key: 'period', header: 'Payroll Period' }, { key: 'treatment', header: 'Payroll Treatment' }, { key: 'status', header: 'Status' }, { key: 'approvedBy', header: 'Approved By' }], rows, summary: totals(rows, [['amount', 'Total']]) };
        },
    },
};

async function advanceReport(kind, f, ids) {
    const q = { kind, deletedAt: null };
    if (ids) q.employee = { $in: ids };
    if (f.status) q.status = f.status;
    if (f.from || f.to) q.date = dateFilter(f);
    const recs = await Advance.find(q).sort({ date: 1 }).lean();
    const emps = await empLookup(recs.map(r => r.employee));
    const rows = recs.map(r => ({
        ...empRow(emps.get(String(r.employee))), reference: r.reference, date: r.date, amount: r.amount, total: r.totalPayable || r.amount,
        installment: r.installmentAmount, installments: r.installmentCount, recovered: r.recovered,
        balance: round2((r.totalPayable || r.amount) - r.recovered), start: r.startPeriod, end: r.endPeriod, status: r.status,
    }));
    return {
        columns: [...empCols, { key: 'reference', header: 'Reference' }, { key: 'date', header: 'Date' }, { key: 'amount', header: 'Amount', type: 'money' },
            { key: 'total', header: 'Total Payable', type: 'money' }, { key: 'installment', header: 'Installment', type: 'money' },
            { key: 'installments', header: 'No. of Inst.', type: 'number' }, { key: 'recovered', header: 'Recovered', type: 'money' },
            { key: 'balance', header: 'Balance', type: 'money' }, { key: 'start', header: 'Start' }, { key: 'end', header: 'End' }, { key: 'status', header: 'Status' }],
        rows, summary: totals(rows, [['balance', 'Outstanding balance']]),
    };
}

export const runReport = async (type, filters, allowedIds) => {
    const def = REPORTS[type];
    if (!def) return null;
    const ids = await employeeIdsFor(filters, allowedIds);
    const result = await def.run(filters, ids);
    return { title: def.title, ...result };
};

export const REPORT_LIST = Object.entries(REPORTS).map(([key, def]) => ({ key, title: def.title, sensitive: Boolean(def.sensitive) }));
