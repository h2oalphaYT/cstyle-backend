import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import {
    BiometricDevice, BiometricMapping, Designation, Employee, EmployeeGroup, EmployeeSalary, Holiday, HrLookup, LeaveType,
    OrgUnit, OvertimeType, SalaryComponent, SalaryStructure, StaffRole, TaxTable,
} from '../models/index.js';
import { can, PERMISSIONS } from '../permissions.js';
import { crudRouter } from './crud.js';
import { availableVariables, BASE_VARIABLES } from '../services/payrollEngine.js';
import { evaluate, validateFormula } from '../services/formulaEngine.js';
import { sanitizeSettings } from '../services/settingsService.js';
import { ADAPTERS, generateDeviceKey, remapUnmatchedEvents } from '../services/biometricService.js';
import { audit } from '../services/util.js';

const router = express.Router();
const ANY_HR = ['hr.dashboard.view', 'employee.view', 'payroll.view', 'attendance.view', 'leave.view', 'settings.manage', 'org.manage', 'reports.view'];

// ── Organisation ────────────────────────────────────────────────────
router.use('/hr/org-units', crudRouter(OrgUnit, {
    entity: 'OrgUnit', read: ANY_HR, write: ['org.manage'], filters: ['type', 'parent', 'active'], sort: { type: 1, name: 1 },
    fields: ['type', 'name', 'code', 'parent', 'category', 'address', 'phone', 'manager', 'description', 'active'],
    populate: [{ path: 'parent', select: 'name code type' }, { path: 'manager', select: 'fullName employeeCode' }],
    canDelete: async (doc) => {
        const n = await Employee.countDocuments({ deletedAt: null, $or: ['company', 'branch', 'hub', 'location', 'department', 'costCenter', 'project'].map(k => ({ [k]: doc._id })) });
        if (n) throw ApiError.conflict(`${n} employee(s) are assigned to ${doc.name}`);
    },
}));
router.use('/hr/designations', crudRouter(Designation, {
    entity: 'Designation', read: ANY_HR, write: ['org.manage'], filters: ['department', 'active'],
    fields: ['name', 'code', 'department', 'grade', 'description', 'active'], populate: { path: 'department', select: 'name' },
}));
router.use('/hr/employee-groups', crudRouter(EmployeeGroup, {
    entity: 'EmployeeGroup', read: ANY_HR, write: ['org.manage'], filters: ['active'],
    fields: ['name', 'code', 'description', 'defaultSalaryStructure', 'payFrequency', 'settings', 'active'],
    populate: { path: 'defaultSalaryStructure', select: 'name code' },
    beforeSave: async (req, doc, body) => { if (body.settings) doc.settings = sanitizeSettings(body.settings); },
}));
router.use('/hr/lookups', crudRouter(HrLookup, {
    entity: 'HrLookup', read: ANY_HR, write: ['settings.manage'], filters: ['category', 'active'], sort: { category: 1, sortOrder: 1, label: 1 },
    search: ['code', 'label'], fields: ['category', 'code', 'label', 'sortOrder', 'active'], label: d => `${d.category}:${d.code}`,
}));
router.use('/hr/holidays', crudRouter(Holiday, {
    entity: 'Holiday', read: ANY_HR, write: ['settings.manage', 'attendance.edit'], sort: { date: 1 }, search: ['name', 'date'],
    fields: ['date', 'name', 'type', 'paid', 'orgUnits'], label: d => `${d.date} ${d.name}`,
}));

// ── Leave & overtime types ─────────────────────────────────────────
router.use('/leave-types', crudRouter(LeaveType, {
    entity: 'LeaveType', read: [...ANY_HR, 'leave.request'], write: ['leave.manage'], filters: ['active'],
    fields: ['name', 'code', 'annualEntitlement', 'paid', 'carryForward', 'maxCarryForward', 'maxDaysPerRequest', 'allowHalfDay', 'allowNegativeBalance',
        'approvalRequired', 'supervisorApproval', 'documentRequired', 'documentRequiredAfterDays', 'countWeekends', 'trackBalance', 'color', 'active'],
}));
router.use('/overtime-types', crudRouter(OvertimeType, {
    entity: 'OvertimeType', read: ANY_HR, write: ['salaryConfig.manage', 'settings.manage'], filters: ['active'],
    fields: ['name', 'code', 'multiplier', 'rateFormula', 'minMinutes', 'roundingMinutes', 'approvalRequired', 'active'],
    beforeSave: async (req, doc) => {
        if (doc.rateFormula) {
            const check = validateFormula(doc.rateFormula, await availableVariables());
            if (!check.ok) throw ApiError.unprocessable(`Rate formula: ${check.error}`);
        }
    },
}));

// ── Salary configuration ────────────────────────────────────────────
router.get('/salary-components/variables', protect, can('salaryConfig.manage', 'salary.view'), asyncHandler(async (req, res) => {
    const otTypes = await OvertimeType.find({ deletedAt: null }).select('code name').lean();
    const components = await SalaryComponent.find({ deletedAt: null }).select('code name').lean();
    res.json({
        success: true,
        data: [
            ...Object.entries(BASE_VARIABLES).map(([name, description]) => ({ name, description, kind: 'variable' })),
            ...otTypes.flatMap(t => [
                { name: `OTHours_${t.code}`, description: `Approved ${t.name} hours`, kind: 'variable' },
                { name: `OTAmount_${t.code}`, description: `${t.name} amount`, kind: 'variable' },
            ]),
            ...components.map(c => ({ name: c.code, description: `Value of component "${c.name}" (calculated earlier in the payslip)`, kind: 'component' })),
        ],
        functions: ['min(a, b, …)', 'max(a, b, …)', 'round(x, decimals)', 'floor(x)', 'ceil(x)', 'abs(x)', 'if(condition, then, else)', 'slab(amount, "TABLE_CODE")'],
    });
}));

/** Validates a formula and evaluates it with sample values so admins can see the result before saving. */
router.post('/salary-components/test-formula', protect, can('salaryConfig.manage'), asyncHandler(async (req, res) => {
    const { formula, sample = {} } = req.body || {};
    const vars = await availableVariables();
    const check = validateFormula(formula, vars);
    if (!check.ok) return res.json({ success: true, data: { ok: false, error: check.error } });
    const defaults = { BasicSalary: 100000, WorkingDays: 26, WorkingHours: 8, DailyRate: 3846.15, HourlyRate: 480.77, OTRate: 721.15, PresentDays: 24, AbsentDays: 1, NoPayDays: 1, OTHours: 10, OTAmount: 7211.5, GrossSalary: 120000, EPFBase: 100000, TaxableGross: 120000, EPFApplicable: 1, ETFApplicable: 1, EPFEmployeeRate: 8, EPFEmployerRate: 12, ETFRate: 3 };
    const variables = Object.fromEntries(vars.map(v => [v, 0]));
    Object.assign(variables, defaults, Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, Number(v) || 0])));
    try {
        const tables = Object.fromEntries((await TaxTable.find({ active: true, deletedAt: null }).lean()).map(t => [t.code, t]));
        const r = evaluate(formula, variables, { tables });
        res.json({ success: true, data: { ok: true, value: Math.round(r.value * 100) / 100, expression: r.expression, used: r.used } });
    } catch (err) {
        res.json({ success: true, data: { ok: false, error: err.message } });
    }
}));

const checkComponentFormula = async (doc) => {
    if (doc.calculationType === 'formula') {
        if (!doc.formula) throw ApiError.unprocessable('A formula is required for formula components');
        const check = validateFormula(doc.formula, await availableVariables());
        if (!check.ok) throw ApiError.unprocessable(`Formula: ${check.error}`);
        if (check.variables.includes(doc.code)) throw ApiError.unprocessable('A component cannot refer to itself');
    }
    if (doc.calculationType === 'percentage' && doc.percentageBase === 'component' && !doc.baseComponent) {
        throw ApiError.unprocessable('Choose the component the percentage is based on');
    }
};

router.use('/salary-components', crudRouter(SalaryComponent, {
    entity: 'SalaryComponent', read: ['salaryConfig.manage', 'salary.view'], write: ['salaryConfig.manage'],
    filters: ['type', 'category', 'active', 'calculationType'], sort: { type: 1, displayOrder: 1 },
    fields: ['name', 'code', 'type', 'category', 'calculationType', 'value', 'percentageBase', 'baseComponent', 'formula', 'taxable',
        'epfApplicable', 'etfApplicable', 'includeInGross', 'includeInNet', 'showOnPayslip', 'skipIfZero', 'displayOrder', 'description', 'active'],
    beforeSave: async (req, doc, body, isNew) => {
        if (!isNew && doc.system && doc.isModified('code')) throw ApiError.unprocessable('System component codes cannot be changed');
        await checkComponentFormula(doc);
    },
    canDelete: async (doc) => {
        if (doc.system) throw ApiError.conflict('System components cannot be deleted; deactivate it instead');
        const used = await SalaryStructure.countDocuments({ deletedAt: null, 'lines.component': doc._id });
        if (used) throw ApiError.conflict(`Used by ${used} salary structure(s)`);
    },
}));

router.use('/salary-structures', crudRouter(SalaryStructure, {
    entity: 'SalaryStructure', read: ['salaryConfig.manage', 'salary.view'], write: ['salaryConfig.manage'], filters: ['active', 'payBasis'],
    fields: ['name', 'code', 'description', 'payBasis', 'payFrequency', 'lines', 'active'],
    populate: { path: 'lines.component', select: 'name code type calculationType value formula percentageBase displayOrder category' },
    beforeSave: async (req, doc) => {
        const ids = doc.lines.map(l => String(l.component));
        if (new Set(ids).size !== ids.length) throw ApiError.unprocessable('A component can only appear once in a structure');
        const vars = await availableVariables();
        for (const line of doc.lines) {
            if (line.formula) {
                const check = validateFormula(line.formula, vars);
                if (!check.ok) throw ApiError.unprocessable(`Formula on line: ${check.error}`);
            }
        }
    },
    canDelete: async (doc) => {
        const used = await EmployeeSalary.countDocuments({ structure: doc._id, status: 'active' });
        if (used) throw ApiError.conflict(`${used} employee salary record(s) use this structure`);
    },
}));

router.use('/tax-tables', crudRouter(TaxTable, {
    entity: 'TaxTable', read: ['salaryConfig.manage', 'salary.view'], write: ['salaryConfig.manage'], fields: ['code', 'name', 'brackets', 'notes', 'active'],
}));

// ── Roles ───────────────────────────────────────────────────────────
router.get('/payroll/permissions', protect, can('roles.manage'), (req, res) => {
    res.json({ success: true, data: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })) });
});
router.use('/payroll/roles', crudRouter(StaffRole, {
    entity: 'StaffRole', read: ['roles.manage'], write: ['roles.manage'], fields: ['code', 'name', 'description', 'permissions', 'dataScope', 'active'],
    canDelete: async (doc) => {
        if (doc.system) throw ApiError.conflict('Built-in roles cannot be deleted; deactivate or edit them instead');
        const { default: User } = await import('../../models/User.js');
        const n = await User.countDocuments({ staffRole: doc._id });
        if (n) throw ApiError.conflict(`${n} user(s) have this role`);
    },
}));

// ── Biometric devices & mappings ────────────────────────────────────
router.get('/biometric/adapters', protect, can('biometric.manage'), (req, res) => {
    res.json({ success: true, data: Object.entries(ADAPTERS).map(([key, a]) => ({ key, label: a.label, canPull: Boolean(a.pull) })) });
});
router.use('/biometric/devices', crudRouter(BiometricDevice, {
    entity: 'BiometricDevice', read: ['biometric.manage', 'attendance.view'], write: ['biometric.manage'], filters: ['active', 'branch'],
    search: ['name', 'deviceCode', 'serialNumber', 'ipAddress'], sort: { deviceCode: 1 },
    fields: ['deviceCode', 'name', 'serialNumber', 'ipAddress', 'port', 'location', 'branch', 'protocol', 'eventMode', 'duplicateWindowMinutes', 'timezoneOffsetMinutes', 'active'],
    populate: [{ path: 'location', select: 'name' }, { path: 'branch', select: 'name' }],
    label: d => d.deviceCode,
}));
/** Issues a new push API key for a device. The key is shown once; only its hash is stored. */
router.post('/biometric/devices/:id/api-key', protect, can('biometric.manage'), asyncHandler(async (req, res) => {
    const device = await BiometricDevice.findOne({ _id: req.params.id, deletedAt: null });
    if (!device) throw ApiError.notFound('Device not found');
    const { key, hash, hint } = generateDeviceKey();
    device.apiKeyHash = hash;
    device.apiKeyHint = hint;
    device.updatedBy = req.user._id;
    await device.save();
    await audit(req, { action: 'issue-key', entity: 'BiometricDevice', record: device, label: device.deviceCode });
    res.json({ success: true, message: 'Copy this key now; it will not be shown again', data: { apiKey: key, hint } });
}));
router.use('/biometric/mappings', crudRouter(BiometricMapping, {
    entity: 'BiometricMapping', read: ['biometric.manage', 'employee.view'], write: ['biometric.manage'], filters: ['employee', 'device', 'status'],
    search: ['biometricUserId'], sort: { biometricUserId: 1 }, fields: ['employee', 'device', 'biometricUserId', 'status'],
    populate: [{ path: 'employee', select: 'fullName employeeCode' }, { path: 'device', select: 'deviceCode name' }],
    label: d => d.biometricUserId,
    afterSave: async () => { await remapUnmatchedEvents(); },
}));

export default router;
