import mongoose from 'mongoose';
import { model, ref } from './common.js';
import { ALL_PERMISSIONS } from '../permissions.js';

/** Back-office roles (Payroll Admin, HR Officer, Supervisor...). */
const staffRoleSchema = new mongoose.Schema({
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    permissions: [{ type: String, enum: ALL_PERMISSIONS }],
    // all = every employee; department = employees in the user's department; team = direct reports; own = self only
    dataScope: { type: String, enum: ['all', 'department', 'team', 'own'], default: 'own' },
    system: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
});
staffRoleSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const StaffRole = model('StaffRole', staffRoleSchema);

/**
 * Payroll settings. scope "global" holds defaults; "company" and "group" documents override
 * individual keys for that company / employee group. Employee-level overrides live on Employee.
 */
const payrollSettingSchema = new mongoose.Schema({
    scope: { type: String, enum: ['global', 'company'], default: 'global' },
    scopeRef: ref('OrgUnit'),
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { minimize: false });
payrollSettingSchema.index({ scope: 1, scopeRef: 1 }, { unique: true });
export const PayrollSetting = model('PayrollSetting', payrollSettingSchema, { softDelete: false });

/** Append-only audit trail for everything in the payroll module. */
const auditLogSchema = new mongoose.Schema({
    user: ref('User'),
    userName: { type: String, default: '' },
    action: { type: String, required: true }, // create, update, delete, approve, finalize...
    entity: { type: String, required: true }, // Employee, EmployeeSalary, Attendance...
    recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    label: { type: String, default: '' }, // human readable record name, e.g. employee code
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    changes: [{ _id: false, field: String, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed }],
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now, index: true },
}, { minimize: false });
auditLogSchema.index({ entity: 1, recordId: 1, at: -1 });
auditLogSchema.index({ user: 1, at: -1 });
auditLogSchema.set('toJSON', { transform: (doc, ret) => { ret.id = String(ret._id); delete ret.__v; return ret; } });
export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);

/** Sequential numbers for payroll runs and payslips. */
const hrCounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
hrCounterSchema.statics.next = async function next(name, session) {
    const doc = await this.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true, session });
    return doc.seq;
};
export const HrCounter = mongoose.models.HrCounter || mongoose.model('HrCounter', hrCounterSchema);

export { ref };
