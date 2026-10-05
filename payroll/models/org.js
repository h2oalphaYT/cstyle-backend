import mongoose from 'mongoose';
import { model, ref } from './common.js';

export const ORG_UNIT_TYPES = ['company', 'branch', 'hub', 'location', 'department', 'costCenter', 'project'];

/**
 * Companies, branches, hubs (schools, restaurants, government locations), departments, cost centres
 * and projects share one collection with a type and optional parent, so new organisation shapes
 * need no schema change.
 */
const orgUnitSchema = new mongoose.Schema({
    type: { type: String, enum: ORG_UNIT_TYPES, required: true, index: true },
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    code: { type: String, required: [true, 'Code is required'], trim: true, uppercase: true, maxlength: 30 },
    parent: ref('OrgUnit'),
    category: { type: String, trim: true, maxlength: 60, default: '' }, // e.g. School, Restaurant, Government office
    address: { type: String, trim: true, maxlength: 300, default: '' },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    manager: ref('Employee'),
    description: { type: String, trim: true, maxlength: 500, default: '' },
    active: { type: Boolean, default: true },
});
orgUnitSchema.index({ type: 1, code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const OrgUnit = model('OrgUnit', orgUnitSchema);

const designationSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    code: { type: String, required: [true, 'Code is required'], trim: true, uppercase: true, maxlength: 30 },
    department: ref('OrgUnit'),
    grade: { type: String, trim: true, maxlength: 30, default: '' },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    active: { type: Boolean, default: true },
});
designationSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const Designation = model('Designation', designationSchema);

/**
 * Employee groups carry their own payroll rule overrides (settings) and a default salary structure,
 * e.g. Restaurant Staff = hourly with service charge, School Staff = monthly with fixed allowances.
 */
const employeeGroupSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    code: { type: String, required: [true, 'Code is required'], trim: true, uppercase: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    defaultSalaryStructure: ref('SalaryStructure'),
    payFrequency: { type: String, enum: ['monthly', 'semi_monthly', 'weekly', 'daily'], default: 'monthly' },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} }, // overrides of PayrollSetting values
    active: { type: Boolean, default: true },
});
employeeGroupSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const EmployeeGroup = model('EmployeeGroup', employeeGroupSchema);

/** Small configurable lists: employment types, external payment types, document types... */
export const LOOKUP_CATEGORIES = ['employmentType', 'externalPaymentType', 'documentType', 'bank'];
const lookupSchema = new mongoose.Schema({
    category: { type: String, enum: LOOKUP_CATEGORIES, required: true },
    code: { type: String, required: true, trim: true, maxlength: 40 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
});
lookupSchema.index({ category: 1, code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const HrLookup = model('HrLookup', lookupSchema);

const holidaySchema = new mongoose.Schema({
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ['public', 'mercantile', 'bank', 'company', 'other'], default: 'public' },
    paid: { type: Boolean, default: true },
    orgUnits: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit' }], // empty = everyone
});
holidaySchema.index({ date: 1 });
export const Holiday = model('Holiday', holidaySchema);
