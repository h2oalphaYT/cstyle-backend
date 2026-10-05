import mongoose from 'mongoose';
import { attachmentSchema, model, ref } from './common.js';

const PERIOD = { type: String, match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must look like 2026-10'] };

/**
 * Salary advance or employee loan. Both are recovered through Installment documents that payroll
 * marks as deducted on finalization.
 */
const advanceSchema = new mongoose.Schema({
    kind: { type: String, enum: ['advance', 'loan'], required: true, index: true },
    employee: ref('Employee', { required: true }),
    reference: { type: String, trim: true, maxlength: 40, default: '' },
    loanType: { type: String, trim: true, maxlength: 60, default: '' },
    amount: { type: Number, min: [0.01, 'Amount must be positive'], required: true },
    interestRate: { type: Number, min: 0, max: 100, default: 0 }, // flat % on principal (loans)
    totalPayable: { type: Number, min: 0, default: 0 },
    installmentCount: { type: Number, min: 1, default: 1 },
    installmentAmount: { type: Number, min: 0, default: 0 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startPeriod: { ...PERIOD, required: true },
    endPeriod: PERIOD,
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'active', 'settled', 'rejected', 'cancelled'], default: 'pending', index: true },
    recovered: { type: Number, min: 0, default: 0 },
    approvedBy: ref('User'),
    approvedAt: { type: Date, default: null },
    attachments: [attachmentSchema],
});
advanceSchema.virtual('balance').get(function balance() {
    return Math.round(((this.totalPayable || this.amount) - this.recovered) * 100) / 100;
});
export const Advance = model('Advance', advanceSchema);

const installmentSchema = new mongoose.Schema({
    source: ref('Advance', { required: true }),
    kind: { type: String, enum: ['advance', 'loan'], required: true },
    employee: ref('Employee', { required: true }),
    sequence: { type: Number, required: true },
    period: { ...PERIOD, required: true },
    amount: { type: Number, min: 0, required: true },
    status: { type: String, enum: ['scheduled', 'deducted', 'skipped', 'cancelled'], default: 'scheduled' },
    payrollRun: ref('PayrollRun'),
    deductedAt: { type: Date, default: null },
});
installmentSchema.index({ employee: 1, period: 1, status: 1 });
installmentSchema.index({ source: 1, sequence: 1 }, { unique: true });
export const Installment = model('Installment', installmentSchema, { softDelete: false });

/**
 * One-off allowance, bonus, deduction or "manual" component value for an employee in a period
 * (e.g. service charge share, commission, performance bonus, uniform deduction).
 */
const payrollEntrySchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    period: { ...PERIOD, required: true },
    component: ref('SalaryComponent', { required: true }),
    amount: { type: Number, required: true },
    quantity: { type: Number, default: null },
    rate: { type: Number, default: null },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'processed'], default: 'approved' },
    payrollRun: ref('PayrollRun'),
    approvedBy: ref('User'),
});
payrollEntrySchema.index({ employee: 1, period: 1 });
export const PayrollEntry = model('PayrollEntry', payrollEntrySchema);

/**
 * Payments made outside the normal payroll (cash, special payments, reimbursements). They stay
 * separately auditable; when includeInPayroll is true they also appear on the payslip.
 */
const externalPaymentSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    paymentType: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { type: Number, min: [0.01, 'Amount must be positive'], required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    paymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'cheque', 'other'], default: 'cash' },
    referenceNumber: { type: String, trim: true, maxlength: 60, default: '' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    period: PERIOD,
    // earning: adds to pay; paid_outside: shown on payslip as already paid (deducted from net)
    payrollTreatment: { type: String, enum: ['none', 'earning', 'paid_outside'], default: 'none' },
    taxable: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'processed'], default: 'pending', index: true },
    approvedBy: ref('User'),
    approvedAt: { type: Date, default: null },
    payrollRun: ref('PayrollRun'),
    attachments: [attachmentSchema],
});
externalPaymentSchema.index({ employee: 1, period: 1 });
export const ExternalPayment = model('ExternalPayment', externalPaymentSchema);
