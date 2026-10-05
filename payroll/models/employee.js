import mongoose from 'mongoose';
import { model, ref } from './common.js';

export const EMPLOYEE_STATUSES = ['active', 'probation', 'on_leave', 'suspended', 'resigned', 'terminated', 'retired'];
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque', 'other'];
export const PAY_FREQUENCIES = ['monthly', 'semi_monthly', 'weekly', 'daily'];

const documentSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 160 },
    type: { type: String, trim: true, maxlength: 60, default: 'other' },
    path: { type: String, required: true },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    uploadedBy: ref('User'),
    uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const employeeSchema = new mongoose.Schema({
    employeeCode: { type: String, required: [true, 'Employee code is required'], trim: true, uppercase: true, maxlength: 30 },
    fullName: { type: String, required: [true, 'Full name is required'], trim: true, maxlength: 160 },
    displayName: { type: String, trim: true, maxlength: 80, default: '' },
    nic: { type: String, trim: true, uppercase: true, maxlength: 20, default: '' },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
    address: { type: String, trim: true, maxlength: 400, default: '' },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    emergencyContact: {
        name: { type: String, trim: true, maxlength: 120, default: '' },
        relationship: { type: String, trim: true, maxlength: 60, default: '' },
        phone: { type: String, trim: true, maxlength: 30, default: '' },
    },

    joiningDate: { type: Date, required: [true, 'Joining date is required'] },
    confirmationDate: { type: Date, default: null },
    leavingDate: { type: Date, default: null },
    employmentType: { type: String, trim: true, maxlength: 40, default: 'permanent' }, // HrLookup employmentType code
    status: { type: String, enum: EMPLOYEE_STATUSES, default: 'active', index: true },

    company: ref('OrgUnit'),
    branch: ref('OrgUnit'),
    hub: ref('OrgUnit'),
    location: ref('OrgUnit'),
    department: ref('OrgUnit'),
    costCenter: ref('OrgUnit'),
    project: ref('OrgUnit'),
    designation: ref('Designation'),
    group: ref('EmployeeGroup'),
    manager: ref('Employee'),
    user: ref('User'), // optional login for self-service

    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'bank_transfer' },
    bank: {
        bankName: { type: String, trim: true, maxlength: 120, default: '' },
        branchName: { type: String, trim: true, maxlength: 120, default: '' },
        branchCode: { type: String, trim: true, maxlength: 20, default: '' },
        accountNumber: { type: String, trim: true, maxlength: 40, default: '' },
        accountName: { type: String, trim: true, maxlength: 160, default: '' },
    },

    // Employee-level overrides; empty means "use group / company / global settings".
    workingHoursPerDay: { type: Number, min: 0, max: 24, default: null },
    workingDaysPerMonth: { type: Number, min: 0, max: 31, default: null },
    attendanceRequired: { type: Boolean, default: true },
    leaveEntitlements: [{
        _id: false,
        leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType' },
        days: { type: Number, min: 0 },
    }],

    tax: {
        tin: { type: String, trim: true, maxlength: 30, default: '' },
        category: { type: String, trim: true, maxlength: 40, default: '' },
        exempt: { type: Boolean, default: false },
    },
    statutory: {
        epfNumber: { type: String, trim: true, maxlength: 30, default: '' },
        etfNumber: { type: String, trim: true, maxlength: 30, default: '' },
        epfApplicable: { type: Boolean, default: true },
        etfApplicable: { type: Boolean, default: true },
    },

    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    documents: [documentSchema],
});

employeeSchema.index({ employeeCode: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
employeeSchema.index({ nic: 1 }, { partialFilterExpression: { nic: { $gt: '' } } });
employeeSchema.index({ department: 1, status: 1 });
employeeSchema.index({ branch: 1, status: 1 });
employeeSchema.index({ hub: 1, status: 1 });
employeeSchema.index({ group: 1, status: 1 });
employeeSchema.index({ manager: 1 });
employeeSchema.index({ fullName: 'text', employeeCode: 'text', nic: 'text' });

export const Employee = model('Employee', employeeSchema);

/** Maps a person on a biometric device to an employee. device = null means "any device". */
const biometricMappingSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    device: ref('BiometricDevice'),
    biometricUserId: { type: String, required: true, trim: true, maxlength: 40 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, {});
biometricMappingSchema.index({ device: 1, biometricUserId: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const BiometricMapping = model('BiometricMapping', biometricMappingSchema);
