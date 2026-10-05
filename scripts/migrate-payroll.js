/* eslint-disable no-console, no-await-in-loop */
/**
 * Payroll & HR migration. Safe to run repeatedly:
 *   - creates / syncs indexes for every HR collection
 *   - creates default roles, settings, lookups, leave types, overtime types, salary components and
 *     salary structures that do not exist yet (existing records are never overwritten)
 *
 *   npm run migrate                     # normal run
 *   npm run migrate -- --update-roles   # also refresh the permissions of built-in roles
 */
import { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import User from '../models/User.js';
import * as M from '../payroll/models/index.js';
import { DEFAULT_ROLES } from '../payroll/permissions.js';
import { DEFAULT_SETTINGS } from '../payroll/services/settingsService.js';

const updateRoles = process.argv.includes('--update-roles');
const log = (...a) => console.log(' ', ...a);

const ensure = async (Model, filter, doc, label) => {
    const existing = await Model.findOne({ ...filter, ...(Model.schema.path('deletedAt') ? { deletedAt: null } : {}) });
    if (existing) return { doc: existing, created: false };
    const created = await Model.create({ ...filter, ...doc });
    log(`+ ${label}`);
    return { doc: created, created: true };
};

const LOOKUPS = {
    employmentType: [['permanent', 'Permanent'], ['contract', 'Contract'], ['temporary', 'Temporary'], ['part_time', 'Part-time'], ['casual', 'Casual'],
        ['daily_paid', 'Daily-paid'], ['hourly_paid', 'Hourly-paid'], ['intern', 'Intern'], ['probation', 'Probation'], ['other', 'Other']],
    externalPaymentType: [['cash_payment', 'Cash payment'], ['bank_transfer', 'Bank transfer'], ['special_payment', 'Special payment'],
        ['external_allowance', 'External allowance'], ['commission', 'Commission'], ['reimbursement', 'Reimbursement'], ['tips', 'Tips'], ['other', 'Other']],
    documentType: [['contract', 'Employment contract'], ['nic', 'NIC copy'], ['certificate', 'Certificate'], ['medical', 'Medical'], ['bank', 'Bank document'], ['other', 'Other']],
    bank: [['BOC', 'Bank of Ceylon'], ['PEOPLES', "People's Bank"], ['COMBANK', 'Commercial Bank'], ['HNB', 'Hatton National Bank'], ['SAMPATH', 'Sampath Bank'],
        ['NSB', 'National Savings Bank'], ['SEYLAN', 'Seylan Bank'], ['NDB', 'NDB Bank'], ['DFCC', 'DFCC Bank'], ['NTB', 'Nations Trust Bank']],
};

const LEAVE_TYPES = [
    { code: 'ANNUAL', name: 'Annual Leave', annualEntitlement: 14, paid: true, carryForward: true, maxCarryForward: 7, color: '#3B82F6' },
    { code: 'CASUAL', name: 'Casual Leave', annualEntitlement: 7, paid: true, maxDaysPerRequest: 2, color: '#10B981' },
    { code: 'SICK', name: 'Sick Leave', annualEntitlement: 7, paid: true, supervisorApproval: false, documentRequired: true, documentRequiredAfterDays: 2, color: '#F59E0B' },
    { code: 'NOPAY', name: 'No Pay Leave', annualEntitlement: 0, paid: false, trackBalance: false, color: '#EF4444' },
    { code: 'MATERNITY', name: 'Maternity Leave', annualEntitlement: 84, paid: true, countWeekends: true, documentRequired: true, color: '#EC4899' },
    { code: 'PATERNITY', name: 'Paternity Leave', annualEntitlement: 3, paid: true, color: '#8B5CF6' },
];

const OT_TYPES = [
    { code: 'NORMAL', name: 'Normal OT', multiplier: 1.5, minMinutes: 30, roundingMinutes: 15 },
    { code: 'WEEKEND', name: 'Weekend OT', multiplier: 1.5, minMinutes: 30, roundingMinutes: 15 },
    { code: 'HOLIDAY', name: 'Holiday OT', multiplier: 2, minMinutes: 30, roundingMinutes: 15 },
    { code: 'NIGHT', name: 'Night OT', multiplier: 1.75, minMinutes: 30, roundingMinutes: 15 },
    { code: 'SPECIAL', name: 'Special OT', multiplier: 2, minMinutes: 0, roundingMinutes: 0 },
];

// Every amount below is only a default; structures and employee salaries override them.
const E = (o) => ({ type: 'earning', taxable: true, includeInGross: true, includeInNet: true, ...o });
const D = (o) => ({ type: 'deduction', taxable: false, includeInGross: false, includeInNet: true, ...o });
const R = (o) => ({ type: 'employer', taxable: false, includeInGross: false, includeInNet: false, ...o });
const COMPONENTS = [
    E({ code: 'BASIC', name: 'Basic Salary', category: 'basic', calculationType: 'formula', formula: 'BasicSalary * ProrationFactor', epfApplicable: true, etfApplicable: true, displayOrder: 1, skipIfZero: false }),
    E({ code: 'BUDGETARY', name: 'Budgetary Relief Allowance', category: 'allowance', calculationType: 'fixed', value: 0, epfApplicable: true, etfApplicable: true, displayOrder: 5 }),
    E({ code: 'HOUSING', name: 'Housing Allowance', category: 'allowance', calculationType: 'fixed', value: 0, displayOrder: 10 }),
    E({ code: 'TRANSPORT', name: 'Transport Allowance', category: 'allowance', calculationType: 'fixed', value: 0, displayOrder: 11 }),
    E({ code: 'MEAL', name: 'Meal Allowance', category: 'allowance', calculationType: 'fixed', value: 0, displayOrder: 12 }),
    E({ code: 'ATTENDANCE_ALLOW', name: 'Attendance Allowance', category: 'allowance', calculationType: 'formula', formula: 'if(NoPayDays == 0 && LateCount <= 3, 5000, 0)', displayOrder: 13 }),
    E({ code: 'PERFORMANCE', name: 'Performance Allowance', category: 'allowance', calculationType: 'manual', displayOrder: 14 }),
    E({ code: 'SERVICE_CHARGE', name: 'Service Charge', category: 'serviceCharge', calculationType: 'manual', displayOrder: 15 }),
    E({ code: 'COMMISSION', name: 'Commission', category: 'commission', calculationType: 'manual', displayOrder: 16 }),
    E({ code: 'OTHER_ALLOW', name: 'Other Allowance', category: 'allowance', calculationType: 'manual', displayOrder: 19 }),
    E({ code: 'OT', name: 'Overtime', category: 'overtime', calculationType: 'formula', formula: 'OTAmount', displayOrder: 20 }),
    E({ code: 'BONUS', name: 'Bonus', category: 'bonus', calculationType: 'manual', displayOrder: 25 }),
    E({ code: 'EXTERNAL_PAY', name: 'External Payment', category: 'external', calculationType: 'external', taxable: false, displayOrder: 28 }),
    E({ code: 'ADJ_EARN', name: 'Prior Period Adjustment (+)', category: 'adjustment', calculationType: 'external', displayOrder: 29 }),
    D({ code: 'NOPAY', name: 'No-pay', category: 'noPay', calculationType: 'formula', formula: 'NoPayDays * DailyRate', displayOrder: 50 }),
    D({ code: 'LATE', name: 'Late Deduction', category: 'late', calculationType: 'formula', formula: 'round(LateMinutes * HourlyRate / 60, 2)', displayOrder: 51 }),
    D({ code: 'EPF_EE', name: 'EPF (Employee)', category: 'statutory', calculationType: 'formula', formula: 'max(0, EPFBase - NOPAY) * EPFEmployeeRate / 100 * EPFApplicable', displayOrder: 60 }),
    D({ code: 'TAX', name: 'Income Tax (APIT)', category: 'tax', calculationType: 'formula', formula: 'slab(TaxableGross, "APIT")', displayOrder: 61, active: false, description: 'Enable after verifying the APIT tax table with current IRD rates.' }),
    D({ code: 'INSURANCE', name: 'Insurance', category: 'insurance', calculationType: 'fixed', value: 0, displayOrder: 62 }),
    D({ code: 'LOAN', name: 'Loan Installment', category: 'loan', calculationType: 'formula', formula: 'LoanDeduction', displayOrder: 70 }),
    D({ code: 'ADVANCE', name: 'Salary Advance Recovery', category: 'advance', calculationType: 'formula', formula: 'AdvanceDeduction', displayOrder: 71 }),
    D({ code: 'OTHER_DED', name: 'Other Deduction', category: 'other', calculationType: 'manual', displayOrder: 79 }),
    D({ code: 'PAID_OUTSIDE', name: 'Paid Outside Payroll', category: 'external', calculationType: 'external', displayOrder: 80 }),
    D({ code: 'ADJ_DEDUCT', name: 'Prior Period Adjustment (−)', category: 'adjustment', calculationType: 'external', displayOrder: 81 }),
    R({ code: 'EPF_ER', name: 'EPF (Employer)', category: 'statutory', calculationType: 'formula', formula: 'max(0, EPFBase - NOPAY) * EPFEmployerRate / 100 * EPFApplicable', displayOrder: 90 }),
    R({ code: 'ETF_ER', name: 'ETF (Employer)', category: 'statutory', calculationType: 'formula', formula: 'max(0, ETFBase - NOPAY) * ETFRate / 100 * ETFApplicable', displayOrder: 91 }),
];

const STRUCTURES = [
    {
        code: 'MONTHLY_OFFICE', name: 'Monthly Office Salary', payBasis: 'monthly', description: 'Fixed monthly salary with allowances, OT, no-pay and EPF/ETF.',
        lines: [['BASIC'], ['TRANSPORT', { value: 10000 }], ['MEAL', { value: 5000 }], ['ATTENDANCE_ALLOW'], ['OT'], ['NOPAY'], ['LATE'], ['LOAN'], ['ADVANCE'], ['EPF_EE'], ['EPF_ER'], ['ETF_ER']],
    },
    {
        code: 'GOVT_SCHOOL', name: 'School / Government Staff', payBasis: 'monthly', description: 'Fixed salary with fixed allowances, approved OT, no-pay, advances and EPF/ETF.',
        lines: [['BASIC'], ['HOUSING', { value: 15000 }], ['TRANSPORT', { value: 7500 }], ['OT'], ['NOPAY'], ['LOAN'], ['ADVANCE'], ['EPF_EE'], ['EPF_ER'], ['ETF_ER']],
    },
    {
        code: 'RESTAURANT_HOURLY', name: 'Restaurant Hourly Salary', payBasis: 'hourly', description: 'Hourly rate × hours worked, service charge, meal per day, OT and late deduction.',
        lines: [['BASIC', { formula: 'HourlyRate * NormalHours' }], ['SERVICE_CHARGE'], ['MEAL', { calculationType: 'perAttendanceDay', value: 300 }],
            ['ATTENDANCE_ALLOW', { formula: 'if(AbsentDays == 0 && LateCount <= 2, 3000, 0)' }], ['OT'], ['LATE'], ['LOAN'], ['ADVANCE'], ['EPF_EE'], ['EPF_ER'], ['ETF_ER']],
    },
    {
        code: 'DAILY_WORKER', name: 'Daily Worker', payBasis: 'daily', description: 'Daily rate × days worked plus OT; advances recovered.',
        lines: [['BASIC', { formula: 'DailyRate * PresentDays' }], ['OT'], ['ADVANCE'], ['LOAN'], ['OTHER_DED']],
    },
];

const run = async () => {
    assertConfig();
    await connectDB();
    console.log('▶ Payroll & HR migration');

    console.log('• Indexes');
    for (const name of Object.keys(M)) {
        const Model = M[name];
        if (Model?.syncIndexes && Model.modelName) await Model.syncIndexes();
    }
    await User.syncIndexes();

    console.log('• Roles');
    for (const r of DEFAULT_ROLES) {
        const { doc, created } = await ensure(M.StaffRole, { code: r.code }, { ...r, system: true }, `role ${r.name}`);
        if (!created && updateRoles) { doc.permissions = r.permissions; doc.dataScope = r.dataScope; await doc.save(); log(`~ role ${r.name} permissions refreshed`); }
    }

    console.log('• Settings');
    if (!(await M.PayrollSetting.exists({ scope: 'global', scopeRef: null }))) {
        await M.PayrollSetting.create({ scope: 'global', scopeRef: null, values: { ...DEFAULT_SETTINGS } });
        log('+ global payroll settings');
    }

    console.log('• Lookups');
    for (const [category, items] of Object.entries(LOOKUPS)) {
        for (const [i, [code, label]] of items.entries()) await ensure(M.HrLookup, { category, code }, { label, sortOrder: i }, `${category} ${label}`);
    }

    console.log('• Leave & overtime types');
    for (const t of LEAVE_TYPES) await ensure(M.LeaveType, { code: t.code }, t, `leave type ${t.name}`);
    for (const t of OT_TYPES) await ensure(M.OvertimeType, { code: t.code }, t, `overtime type ${t.name}`);

    console.log('• Salary components');
    for (const c of COMPONENTS) await ensure(M.SalaryComponent, { code: c.code }, { ...c, system: true }, `component ${c.code}`);
    await ensure(M.TaxTable, { code: 'APIT' }, {
        name: 'APIT (sample — verify before use)', active: false,
        notes: 'Sample progressive table. Replace the brackets with the current Inland Revenue APIT table before enabling the TAX component.',
        brackets: [{ from: 0, to: 150000, rate: 0 }, { from: 150000, to: 233333, rate: 6 }, { from: 233333, to: 275000, rate: 18 },
            { from: 275000, to: 316667, rate: 24 }, { from: 316667, to: 358333, rate: 30 }, { from: 358333, to: null, rate: 36 }],
    }, 'tax table APIT (inactive sample)');

    console.log('• Salary structures');
    const comps = new Map((await M.SalaryComponent.find({ deletedAt: null })).map(c => [c.code, c]));
    for (const s of STRUCTURES) {
        const lines = s.lines.map(([code, ov = {}]) => ({ component: comps.get(code)._id, ...ov }));
        await ensure(M.SalaryStructure, { code: s.code }, { name: s.name, payBasis: s.payBasis, description: s.description, lines }, `structure ${s.name}`);
    }

    console.log('✅ Migration complete');
};

run().catch((err) => { console.error('❌ Migration failed:', err); process.exitCode = 1; }).finally(() => disconnectDB());
