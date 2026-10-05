import mongoose from 'mongoose';
import { attachmentSchema, model, ref } from './common.js';

const leaveTypeSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    annualEntitlement: { type: Number, min: 0, default: 0 },
    paid: { type: Boolean, default: true },
    carryForward: { type: Boolean, default: false },
    maxCarryForward: { type: Number, min: 0, default: 0 },
    maxDaysPerRequest: { type: Number, min: 0, default: null },
    allowHalfDay: { type: Boolean, default: true },
    allowNegativeBalance: { type: Boolean, default: false },
    approvalRequired: { type: Boolean, default: true },
    supervisorApproval: { type: Boolean, default: true }, // supervisor step before HR
    documentRequired: { type: Boolean, default: false },
    documentRequiredAfterDays: { type: Number, min: 0, default: 0 }, // e.g. medical certificate after 2 days
    countWeekends: { type: Boolean, default: false },
    trackBalance: { type: Boolean, default: true },
    color: { type: String, default: '#D4AF37' },
    active: { type: Boolean, default: true },
});
leaveTypeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const LeaveType = model('LeaveType', leaveTypeSchema);

/** Remaining = opening + accrued + adjusted - used - pending */
const leaveBalanceSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    leaveType: ref('LeaveType', { required: true }),
    year: { type: Number, required: true },
    opening: { type: Number, default: 0 },
    accrued: { type: Number, default: 0 },
    adjusted: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    notes: { type: String, default: '' },
});
leaveBalanceSchema.virtual('remaining').get(function remaining() {
    return Math.round((this.opening + this.accrued + this.adjusted - this.used - this.pending) * 100) / 100;
});
leaveBalanceSchema.index({ employee: 1, leaveType: 1, year: 1 }, { unique: true });
export const LeaveBalance = model('LeaveBalance', leaveBalanceSchema, { softDelete: false });

export const LEAVE_STATUSES = ['pending', 'supervisor_approved', 'approved', 'rejected', 'cancelled'];
const leaveRequestSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    leaveType: ref('LeaveType', { required: true }),
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    halfDay: { type: Boolean, default: false },
    days: { type: Number, min: 0, required: true },
    reason: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending', index: true },
    approvals: [{
        _id: false,
        level: { type: String, enum: ['supervisor', 'hr'] },
        decision: { type: String, enum: ['approved', 'rejected'] },
        by: ref('User'),
        at: { type: Date, default: Date.now },
        note: { type: String, default: '' },
    }],
    documents: [attachmentSchema],
    requestedBy: ref('User'),
});
leaveRequestSchema.index({ employee: 1, fromDate: 1 });
export const LeaveRequest = model('LeaveRequest', leaveRequestSchema);

/** Normal / Holiday / Weekend / Night / Special OT with configurable multiplier or formula. */
const overtimeTypeSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20, match: /^[A-Z][A-Z0-9_]*$/ },
    multiplier: { type: Number, min: 0, default: 1.5 }, // × HourlyRate when no formula
    rateFormula: { type: String, trim: true, maxlength: 500, default: '' }, // e.g. "HourlyRate * 2" or "OTRate"
    minMinutes: { type: Number, min: 0, default: 0 },
    roundingMinutes: { type: Number, min: 0, default: 0 }, // round down to this block (e.g. 15)
    approvalRequired: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
});
overtimeTypeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const OvertimeType = model('OvertimeType', overtimeTypeSchema);

const overtimeEntrySchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    overtimeType: ref('OvertimeType', { required: true }),
    hours: { type: Number, min: 0, required: true }, // after minimum / rounding rules
    requestedHours: { type: Number, min: 0, default: null },
    source: { type: String, enum: ['manual', 'attendance', 'excel', 'biometric'], default: 'manual' },
    attendance: ref('Attendance'),
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    approvedBy: ref('User'),
    approvedAt: { type: Date, default: null },
    remarks: { type: String, trim: true, maxlength: 500, default: '' },
});
overtimeEntrySchema.index({ employee: 1, date: 1 });
export const OvertimeEntry = model('OvertimeEntry', overtimeEntrySchema);
