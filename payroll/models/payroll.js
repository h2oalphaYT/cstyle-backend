import mongoose from 'mongoose';
import { attachmentSchema, model, ref } from './common.js';

export const PERIOD_STATUSES = ['open', 'processing', 'finalized', 'locked'];
export const RUN_STATUSES = ['draft', 'calculated', 'under_review', 'approved', 'finalized', 'paid', 'cancelled'];
export const PAYMENT_STATUSES = ['pending', 'processing', 'paid', 'failed', 'cancelled'];

const payrollPeriodSchema = new mongoose.Schema({
    code: { type: String, required: true, match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'Period code must look like 2026-10'] },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    payDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: PERIOD_STATUSES, default: 'open', index: true },
    lockedBy: ref('User'),
    lockedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
});
payrollPeriodSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const PayrollPeriod = model('PayrollPeriod', payrollPeriodSchema);

const runFilterSchema = new mongoose.Schema({
    company: ref('OrgUnit'),
    branch: ref('OrgUnit'),
    hub: ref('OrgUnit'),
    department: ref('OrgUnit'),
    group: ref('EmployeeGroup'),
    employees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
}, { _id: false });

const payrollRunSchema = new mongoose.Schema({
    runNumber: { type: String, required: true },
    period: ref('PayrollPeriod', { required: true }),
    periodCode: { type: String, required: true },
    name: { type: String, trim: true, maxlength: 120, default: '' },
    filters: { type: runFilterSchema, default: () => ({}) },
    status: { type: String, enum: RUN_STATUSES, default: 'draft', index: true },
    totals: {
        employees: { type: Number, default: 0 },
        gross: { type: Number, default: 0 },
        deductions: { type: Number, default: 0 },
        net: { type: Number, default: 0 },
        employer: { type: Number, default: 0 },
        warnings: { type: Number, default: 0 },
        errors: { type: Number, default: 0 },
    },
    history: [{
        _id: false,
        status: String,
        by: ref('User'),
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
    }],
    calculatedAt: { type: Date, default: null },
    calculatedBy: ref('User'),
    approvedBy: ref('User'),
    finalizedBy: ref('User'),
    finalizedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
});
payrollRunSchema.index({ period: 1, status: 1 });
payrollRunSchema.index({ runNumber: 1 }, { unique: true });
export const PayrollRun = model('PayrollRun', payrollRunSchema);

const itemSchema = new mongoose.Schema({
    code: String,
    name: String,
    type: { type: String, enum: ['earning', 'deduction', 'employer', 'info'] },
    category: String,
    amount: Number,
    taxable: Boolean,
    epfApplicable: Boolean,
    includeInGross: Boolean,
    includeInNet: Boolean,
    showOnPayslip: { type: Boolean, default: true },
    source: String, // structure | override | additional | entry | external | installment | adjustment
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    calculation: {
        method: String, // fixed, percentage, formula...
        formula: String,
        expression: String, // formula with values substituted
        variables: mongoose.Schema.Types.Mixed,
        explanation: String,
    },
}, { _id: false });

/**
 * The calculated payroll for one employee in one run: a full, self-contained snapshot (names, bank,
 * rates, attendance, every line with its calculation) so payslips never change after finalization.
 */
const payrollRunEmployeeSchema = new mongoose.Schema({
    run: ref('PayrollRun', { required: true }),
    period: ref('PayrollPeriod', { required: true }),
    periodCode: { type: String, required: true },
    employee: ref('Employee', { required: true }),
    salaryRevision: ref('EmployeeSalary'),
    snapshot: {
        employeeCode: String, fullName: String, nic: String, email: String,
        company: String, branch: String, hub: String, department: String, designation: String, group: String, costCenter: String,
        companyId: mongoose.Schema.Types.ObjectId, branchId: mongoose.Schema.Types.ObjectId, hubId: mongoose.Schema.Types.ObjectId,
        departmentId: mongoose.Schema.Types.ObjectId, groupId: mongoose.Schema.Types.ObjectId,
        employmentType: String, joiningDate: Date, structure: String, payBasis: String,
        paymentMethod: String, bankName: String, bankBranch: String, accountNumber: String, accountName: String,
        epfNumber: String, etfNumber: String,
    },
    variables: mongoose.Schema.Types.Mixed, // every input variable used (rates, days, hours...)
    attendance: mongoose.Schema.Types.Mixed, // attendance summary
    leave: mongoose.Schema.Types.Mixed, // leave summary
    items: [itemSchema],
    gross: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    employerContributions: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    warnings: [String],
    blockers: [String], // problems that prevent finalization
    payslipNumber: { type: String, default: '' },
    payment: {
        status: { type: String, enum: PAYMENT_STATUSES, default: 'pending' },
        method: { type: String, enum: ['bank_transfer', 'cash', 'cheque', 'other'], default: 'bank_transfer' },
        date: { type: String, default: null },
        reference: { type: String, default: '' },
        amount: { type: Number, default: 0 },
        processedBy: ref('User'),
        processedAt: { type: Date, default: null },
        note: { type: String, default: '' },
    },
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
});
payrollRunEmployeeSchema.index({ run: 1, employee: 1 }, { unique: true });
payrollRunEmployeeSchema.index({ periodCode: 1, employee: 1, status: 1 });
payrollRunEmployeeSchema.index({ 'payment.status': 1 });
export const PayrollRunEmployee = model('PayrollRunEmployee', payrollRunEmployeeSchema, { softDelete: false });

/**
 * Corrections after a period is finalized/locked. They never modify the locked payroll; they are
 * applied as extra lines in the target (next open) period's payroll.
 */
const payrollAdjustmentSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    originalPeriod: { type: String, required: true },
    originalRunEmployee: ref('PayrollRunEmployee'),
    targetPeriod: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    type: { type: String, enum: ['earning', 'deduction'], required: true },
    componentCode: { type: String, trim: true, uppercase: true, default: 'ADJUSTMENT' },
    amount: { type: Number, min: 0.01, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'applied', 'cancelled'], default: 'approved' },
    payrollRun: ref('PayrollRun'),
    attachments: [attachmentSchema],
});
payrollAdjustmentSchema.index({ employee: 1, targetPeriod: 1 });
export const PayrollAdjustment = model('PayrollAdjustment', payrollAdjustmentSchema);
