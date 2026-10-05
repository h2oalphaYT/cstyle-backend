import mongoose from 'mongoose';
import { model, ref } from './common.js';

export const COMPONENT_TYPES = ['earning', 'deduction', 'employer'];
export const CALCULATION_TYPES = ['fixed', 'percentage', 'perDay', 'perHour', 'perAttendanceDay', 'formula', 'manual', 'external'];
export const PERCENTAGE_BASES = ['basic', 'gross', 'component', 'epfBase', 'taxableGross'];
// Reporting buckets so reports can total "allowances", "overtime", etc. regardless of component names.
export const COMPONENT_CATEGORIES = ['basic', 'allowance', 'overtime', 'bonus', 'commission', 'serviceCharge', 'external',
    'noPay', 'late', 'loan', 'advance', 'statutory', 'tax', 'insurance', 'adjustment', 'other'];

/**
 * A salary component definition. Its code is also the variable name other formulas can use,
 * e.g. EPF_EE = EPFBase * 0.08 or NET formulas referring to TRANSPORT.
 */
const salaryComponentSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    code: {
        type: String, required: [true, 'Code is required'], trim: true, uppercase: true, maxlength: 30,
        match: [/^[A-Z][A-Z0-9_]*$/, 'Code must start with a letter and use A–Z, 0–9 and _ only'],
    },
    type: { type: String, enum: COMPONENT_TYPES, required: true },
    category: { type: String, enum: COMPONENT_CATEGORIES, default: 'other' },
    calculationType: { type: String, enum: CALCULATION_TYPES, default: 'fixed' },
    value: { type: Number, default: 0 }, // amount, percentage or rate depending on calculationType
    percentageBase: { type: String, enum: PERCENTAGE_BASES, default: 'basic' },
    baseComponent: { type: String, trim: true, uppercase: true, default: '' },
    formula: { type: String, trim: true, maxlength: 1000, default: '' },
    taxable: { type: Boolean, default: true },
    epfApplicable: { type: Boolean, default: false },
    etfApplicable: { type: Boolean, default: false },
    includeInGross: { type: Boolean, default: true },
    includeInNet: { type: Boolean, default: true },
    showOnPayslip: { type: Boolean, default: true },
    skipIfZero: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 100 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    system: { type: Boolean, default: false }, // created by migration; code cannot be changed
    active: { type: Boolean, default: true },
});
salaryComponentSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const SalaryComponent = model('SalaryComponent', salaryComponentSchema);

const structureLineSchema = new mongoose.Schema({
    component: ref('SalaryComponent', { required: true }),
    // Optional overrides of the component definition for this structure.
    calculationType: { type: String, enum: [...CALCULATION_TYPES, null], default: null },
    value: { type: Number, default: null },
    percentageBase: { type: String, enum: [...PERCENTAGE_BASES, null], default: null },
    baseComponent: { type: String, trim: true, uppercase: true, default: null },
    formula: { type: String, trim: true, maxlength: 1000, default: null },
    employeeEditable: { type: Boolean, default: true }, // may be overridden per employee
    order: { type: Number, default: null },
}, { _id: true });

/** Templates such as "Monthly Office Salary", "Restaurant Hourly", "Daily Worker". */
const salaryStructureSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    code: { type: String, required: [true, 'Code is required'], trim: true, uppercase: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    payBasis: { type: String, enum: ['monthly', 'daily', 'hourly'], default: 'monthly' },
    payFrequency: { type: String, enum: ['monthly', 'semi_monthly', 'weekly', 'daily'], default: 'monthly' },
    lines: [structureLineSchema],
    active: { type: Boolean, default: true },
});
salaryStructureSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const SalaryStructure = model('SalaryStructure', salaryStructureSchema);

const salaryOverrideSchema = new mongoose.Schema({
    component: ref('SalaryComponent', { required: true }),
    calculationType: { type: String, enum: [...CALCULATION_TYPES, null], default: null },
    value: { type: Number, default: null },
    formula: { type: String, trim: true, maxlength: 1000, default: null },
    enabled: { type: Boolean, default: true }, // false removes a structure component for this employee
}, { _id: true });

/**
 * One salary revision. Revisions are never edited once payroll used them; a raise creates a new
 * revision and closes the previous one (effectiveTo = day before), so history is preserved.
 */
const employeeSalarySchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    structure: ref('SalaryStructure', { required: true }),
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    basicSalary: { type: Number, min: [0, 'Salary cannot be negative'], default: 0 },
    dailyRate: { type: Number, min: 0, default: null },
    hourlyRate: { type: Number, min: 0, default: null },
    otRate: { type: Number, min: 0, default: null },
    payFrequency: { type: String, enum: ['monthly', 'semi_monthly', 'weekly', 'daily'], default: 'monthly' },
    overrides: [salaryOverrideSchema],
    additionalComponents: [salaryOverrideSchema], // components not in the structure, for this employee only
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: ['active', 'superseded', 'cancelled'], default: 'active' },
    usedInPayroll: { type: Boolean, default: false },
});
employeeSalarySchema.index({ employee: 1, effectiveFrom: -1 });
export const EmployeeSalary = model('EmployeeSalary', employeeSalarySchema, { softDelete: false });

/** Configurable progressive tax tables used by the slab() formula function. */
const taxTableSchema = new mongoose.Schema({
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Brackets apply to the slice of income between from and to (to = null means no upper limit).
    brackets: [{
        _id: false,
        from: { type: Number, min: 0, required: true },
        to: { type: Number, min: 0, default: null },
        rate: { type: Number, min: 0, max: 100, required: true },
    }],
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    active: { type: Boolean, default: true },
});
taxTableSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const TaxTable = model('TaxTable', taxTableSchema);
