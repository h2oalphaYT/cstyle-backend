import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, escapeRegex, isObjectId, paginationMeta, parsePagination } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import User from '../../models/User.js';
import { Employee, EmployeeSalary, LeaveBalance, LeaveType, SalaryComponent, SalaryStructure, StaffRole } from '../models/index.js';
import { can, hasPermission, loadAccess } from '../permissions.js';
import { allowedEmployeeIds, canSeeEmployee } from '../services/scope.js';
import { getGlobalSettings } from '../services/settingsService.js';
import { ensureBalance } from '../services/leaveService.js';
import { addDays, assertEmployeePeriodOpen, audit, isValidDay, pick } from '../services/util.js';
import { hrUpload, removeHrFile, saveHrFile, sendHrFile } from '../services/files.js';

const router = express.Router();

const EMPLOYEE_FIELDS = ['employeeCode', 'fullName', 'displayName', 'nic', 'dateOfBirth', 'gender', 'address', 'phone', 'email', 'emergencyContact',
    'joiningDate', 'confirmationDate', 'leavingDate', 'employmentType', 'status', 'company', 'branch', 'hub', 'location', 'department', 'costCenter',
    'project', 'designation', 'group', 'manager', 'paymentMethod', 'workingHoursPerDay', 'workingDaysPerMonth', 'attendanceRequired',
    'leaveEntitlements', 'tax', 'statutory', 'notes'];
const POPULATE = 'company branch hub location department costCenter project designation group';

/** Removes bank / tax details the user may not see. */
const present = (req, emp) => {
    const out = typeof emp.toJSON === 'function' ? emp.toJSON() : { ...emp, id: String(emp._id) };
    if (!hasPermission(req, 'employee.bank.view') && !hasPermission(req, 'employee.bank.edit')) {
        out.bank = out.bank?.accountNumber ? { bankName: out.bank.bankName, accountNumber: `••••${String(out.bank.accountNumber).slice(-4)}`, masked: true } : {};
    }
    if (!hasPermission(req, 'salary.view')) delete out.tax;
    return out;
};

const validateEmployee = async (doc) => {
    const settings = await getGlobalSettings();
    if (doc.nic && settings.nicPattern && !new RegExp(settings.nicPattern).test(doc.nic)) {
        throw ApiError.unprocessable(`NIC "${doc.nic}" does not match the configured format`);
    }
    if (doc.bank?.accountNumber && settings.bankAccountPattern && !new RegExp(settings.bankAccountPattern).test(doc.bank.accountNumber)) {
        throw ApiError.unprocessable('Bank account number does not match the configured format');
    }
    if (doc.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.email)) throw ApiError.unprocessable('Email is invalid');
    if (doc.leavingDate && doc.joiningDate && doc.leavingDate < doc.joiningDate) throw ApiError.unprocessable('Leaving date is before joining date');
    if (doc.manager && String(doc.manager) === String(doc._id)) throw ApiError.unprocessable('An employee cannot be their own manager');
    const dup = await Employee.findOne({ employeeCode: doc.employeeCode, deletedAt: null, _id: { $ne: doc._id } }).lean();
    if (dup) throw ApiError.conflict(`Employee code ${doc.employeeCode} is already used by ${dup.fullName}`);
    if (doc.nic) {
        const nicDup = await Employee.findOne({ nic: doc.nic, deletedAt: null, _id: { $ne: doc._id } }).lean();
        if (nicDup) throw ApiError.conflict(`NIC ${doc.nic} is already registered to ${nicDup.employeeCode}`);
    }
};

router.get('/employees', protect, can('employee.view'), asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 500 });
    const q = { deletedAt: null };
    for (const k of ['status', 'company', 'branch', 'hub', 'department', 'group', 'designation', 'employmentType', 'paymentMethod', 'manager']) {
        if (req.query[k]) q[k] = req.query[k];
    }
    if (req.query.search) {
        const re = new RegExp(escapeRegex(String(req.query.search).slice(0, 80)), 'i');
        q.$or = [{ fullName: re }, { employeeCode: re }, { nic: re }, { email: re }, { phone: re }];
    }
    const ids = await allowedEmployeeIds(req);
    if (ids) q._id = { $in: ids };
    const sortKey = ['employeeCode', 'fullName', 'joiningDate', 'createdAt'].includes(req.query.sort) ? req.query.sort : 'employeeCode';
    const [rows, total] = await Promise.all([
        Employee.find(q).populate(POPULATE, 'name code').populate('manager', 'fullName employeeCode').sort({ [sortKey]: req.query.order === 'desc' ? -1 : 1 }).skip(skip).limit(limit),
        Employee.countDocuments(q),
    ]);
    await loadAccess(req);
    res.json({ success: true, data: rows.map(e => present(req, e)), pagination: paginationMeta(page, limit, total) });
}));

router.get('/employees/:id', protect, can('employee.view'), asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.id) || !(await canSeeEmployee(req, req.params.id))) throw ApiError.notFound('Employee not found');
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null }).populate(POPULATE, 'name code').populate('manager', 'fullName employeeCode')
        .populate('user', 'name email role').populate('leaveEntitlements.leaveType', 'name code');
    if (!emp) throw ApiError.notFound('Employee not found');
    await loadAccess(req);
    const data = present(req, emp);
    if (hasPermission(req, 'salary.view')) {
        data.currentSalary = await EmployeeSalary.findOne({ employee: emp._id, status: 'active', effectiveTo: null }).populate('structure', 'name code payBasis').lean();
    }
    res.json({ success: true, data });
}));

router.post('/employees', protect, can('employee.create'), asyncHandler(async (req, res) => {
    const body = pick(req.body || {}, EMPLOYEE_FIELDS);
    await loadAccess(req);
    const emp = new Employee({ ...body, createdBy: req.user._id, updatedBy: req.user._id });
    if (req.body.bank && hasPermission(req, 'employee.bank.edit')) emp.bank = pick(req.body.bank, ['bankName', 'branchName', 'branchCode', 'accountNumber', 'accountName']);
    if (!emp.group) {
        const settings = await getGlobalSettings();
        if (settings.defaultEmployeeGroup) emp.group = settings.defaultEmployeeGroup;
    }
    await validateEmployee(emp);
    await emp.save();
    await audit(req, { action: 'create', entity: 'Employee', after: emp, label: emp.employeeCode });
    res.status(201).json({ success: true, message: 'Employee created', data: present(req, emp) });
}));

router.put('/employees/:id', protect, can('employee.edit', 'employee.bank.edit'), asyncHandler(async (req, res) => {
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!emp || !(await canSeeEmployee(req, emp._id))) throw ApiError.notFound('Employee not found');
    await loadAccess(req);
    const before = emp.toObject();
    if (hasPermission(req, 'employee.edit')) emp.set(pick(req.body || {}, EMPLOYEE_FIELDS));
    if (req.body.bank && hasPermission(req, 'employee.bank.edit')) {
        emp.bank = pick(req.body.bank, ['bankName', 'branchName', 'branchCode', 'accountNumber', 'accountName']);
    }
    emp.updatedBy = req.user._id;
    await validateEmployee(emp);
    await emp.save();
    const bankChanged = JSON.stringify(before.bank) !== JSON.stringify(emp.toObject().bank);
    await audit(req, { action: bankChanged ? 'update-bank' : 'update', entity: 'Employee', before, after: emp, label: emp.employeeCode });
    res.json({ success: true, message: 'Employee updated', data: present(req, emp) });
}));

router.delete('/employees/:id', protect, can('employee.delete'), asyncHandler(async (req, res) => {
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!emp) throw ApiError.notFound('Employee not found');
    const before = emp.toObject();
    emp.deletedAt = new Date();
    emp.updatedBy = req.user._id;
    await emp.save();
    await audit(req, { action: 'delete', entity: 'Employee', before, label: emp.employeeCode });
    res.json({ success: true, message: 'Employee archived' });
}));

// Documents
router.post('/employees/:id/documents', protect, can('employee.edit'), hrUpload.array('files', 5), asyncHandler(async (req, res) => {
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!emp) throw ApiError.notFound('Employee not found');
    if (!req.files?.length) throw ApiError.badRequest('Attach at least one file');
    for (const f of req.files) {
        const saved = await saveHrFile(f, `employees/${emp._id}`, req.user._id);
        emp.documents.push({ ...saved, type: String(req.body.type || 'other').slice(0, 60) });
    }
    await emp.save();
    await audit(req, { action: 'upload', entity: 'Employee', record: emp, label: emp.employeeCode, note: req.files.map(f => f.originalname).join(', ') });
    res.status(201).json({ success: true, data: emp.documents });
}));

router.get('/employees/:id/documents/:docId', protect, can('employee.view'), asyncHandler(async (req, res) => {
    if (!(await canSeeEmployee(req, req.params.id))) throw ApiError.notFound('Document not found');
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null }).lean();
    const doc = emp?.documents?.find(d => String(d._id) === req.params.docId);
    if (!doc) throw ApiError.notFound('Document not found');
    await sendHrFile(res, doc);
}));

router.delete('/employees/:id/documents/:docId', protect, can('employee.edit'), asyncHandler(async (req, res) => {
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    const doc = emp?.documents?.id(req.params.docId);
    if (!doc) throw ApiError.notFound('Document not found');
    await removeHrFile(doc);
    doc.deleteOne();
    await emp.save();
    await audit(req, { action: 'delete-document', entity: 'Employee', record: emp, label: emp.employeeCode, note: doc.name });
    res.json({ success: true, data: emp.documents });
}));

/** Creates or links a self-service / back-office login for the employee. */
router.post('/employees/:id/user', protect, can('roles.manage'), asyncHandler(async (req, res) => {
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!emp) throw ApiError.notFound('Employee not found');
    const { email, password, staffRole } = req.body || {};
    const role = staffRole ? await StaffRole.findOne({ _id: staffRole, deletedAt: null }) : await StaffRole.findOne({ code: 'EMPLOYEE', deletedAt: null });
    if (!role) throw ApiError.unprocessable('Role not found');
    let user = await User.findOne({ email: String(email || emp.email).toLowerCase() }).select('+tokenVersion');
    if (user && user.role === 'admin') throw ApiError.conflict('That email belongs to an administrator');
    if (!user) {
        if (!password || String(password).length < 8) throw ApiError.unprocessable('A password of at least 8 characters is required for a new login');
        user = new User({ name: emp.fullName, email: email || emp.email, phone: emp.phone, role: 'staff' });
        await user.setPassword(password);
    }
    user.role = 'staff';
    user.staffRole = role._id;
    user.employee = emp._id;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    emp.user = user._id;
    await emp.save();
    await audit(req, { action: 'link-user', entity: 'Employee', record: emp, label: emp.employeeCode, note: `${user.email} as ${role.name}` });
    res.json({ success: true, message: `Login ${user.email} linked with role ${role.name}`, data: { id: user.id, email: user.email, role: role.name } });
}));

// ── Leave balances for an employee ─────────────────────────────────
router.get('/employees/:id/leave-balances', protect, can('leave.view', 'employee.view'), asyncHandler(async (req, res) => {
    if (!(await canSeeEmployee(req, req.params.id))) throw ApiError.notFound('Employee not found');
    const emp = await Employee.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!emp) throw ApiError.notFound('Employee not found');
    const year = Number(req.query.year) || new Date().getFullYear();
    const types = await LeaveType.find({ active: true, deletedAt: null, trackBalance: true });
    for (const t of types) await ensureBalance(emp, t, year);
    const rows = await LeaveBalance.find({ employee: emp._id, year }).populate('leaveType', 'name code paid color');
    res.json({ success: true, data: rows });
}));

router.patch('/leave-balances/:id', protect, can('leave.manage'), asyncHandler(async (req, res) => {
    const bal = await LeaveBalance.findById(req.params.id);
    if (!bal) throw ApiError.notFound('Balance not found');
    const before = bal.toObject();
    for (const k of ['opening', 'accrued', 'adjusted']) if (req.body[k] != null) bal[k] = Number(req.body[k]);
    if (req.body.notes != null) bal.notes = String(req.body.notes).slice(0, 300);
    await bal.save();
    await audit(req, { action: 'adjust', entity: 'LeaveBalance', before, after: bal, note: req.body.notes || '' });
    res.json({ success: true, data: bal });
}));

// ── Salary revisions ────────────────────────────────────────────────
const SALARY_FIELDS = ['structure', 'effectiveFrom', 'basicSalary', 'dailyRate', 'hourlyRate', 'otRate', 'payFrequency', 'overrides', 'additionalComponents', 'reason'];

router.get('/employee-salaries', protect, can('salary.view'), asyncHandler(async (req, res) => {
    const q = {};
    if (req.query.employee) q.employee = req.query.employee;
    if (req.query.current === 'true') { q.effectiveTo = null; q.status = 'active'; }
    const ids = await allowedEmployeeIds(req);
    if (ids) q.employee = q.employee ? (ids.some(i => String(i) === String(q.employee)) ? q.employee : null) : { $in: ids };
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
    const [rows, total] = await Promise.all([
        EmployeeSalary.find(q).populate('employee', 'fullName employeeCode').populate('structure', 'name code payBasis')
            .populate('overrides.component additionalComponents.component', 'name code type').populate('createdBy', 'name')
            .sort({ effectiveFrom: -1 }).skip(skip).limit(limit),
        EmployeeSalary.countDocuments(q),
    ]);
    res.json({ success: true, data: rows, pagination: paginationMeta(page, limit, total) });
}));

const validateRevision = async (body) => {
    if (!isValidDay(body.effectiveFrom)) throw ApiError.unprocessable('Effective-from date is invalid');
    const structure = await SalaryStructure.findOne({ _id: body.structure, deletedAt: null, active: true });
    if (!structure) throw ApiError.unprocessable('Choose an active salary structure');
    for (const k of ['basicSalary', 'dailyRate', 'hourlyRate', 'otRate']) {
        if (body[k] != null && body[k] !== '' && (!Number.isFinite(Number(body[k])) || Number(body[k]) < 0)) throw ApiError.unprocessable(`${k} cannot be negative`);
    }
    if (structure.payBasis === 'daily' && !(Number(body.dailyRate) > 0) && !(Number(body.basicSalary) > 0)) throw ApiError.unprocessable('Enter a daily rate for a daily-paid structure');
    if (structure.payBasis === 'hourly' && !(Number(body.hourlyRate) > 0) && !(Number(body.basicSalary) > 0)) throw ApiError.unprocessable('Enter an hourly rate for an hourly-paid structure');
    const compIds = [...(body.overrides || []), ...(body.additionalComponents || [])].map(o => o.component);
    if (compIds.length) {
        const count = await SalaryComponent.countDocuments({ _id: { $in: compIds }, deletedAt: null });
        if (count !== new Set(compIds.map(String)).size) throw ApiError.unprocessable('Unknown salary component in overrides');
    }
    return structure;
};

const cleanRates = (body) => {
    const out = { ...body };
    for (const k of ['dailyRate', 'hourlyRate', 'otRate']) if (out[k] === '' || out[k] === undefined) out[k] = null;
    return out;
};

/** New revision: the open revision is closed the day before; history is never overwritten. */
router.post('/employee-salaries', protect, can('salary.edit'), asyncHandler(async (req, res) => {
    const body = cleanRates(pick(req.body || {}, SALARY_FIELDS));
    const employee = await Employee.findOne({ _id: req.body.employee, deletedAt: null });
    if (!employee) throw ApiError.notFound('Employee not found');
    await validateRevision(body);
    await assertEmployeePeriodOpen(employee._id, body.effectiveFrom, 'The salary effective date');

    const later = await EmployeeSalary.findOne({ employee: employee._id, status: { $ne: 'cancelled' }, effectiveFrom: { $gte: body.effectiveFrom } });
    if (later) throw ApiError.conflict(`A revision effective ${later.effectiveFrom} already exists. New revisions must start after it.`);
    const current = await EmployeeSalary.findOne({ employee: employee._id, status: 'active', effectiveTo: null });
    if (current) {
        const before = current.toObject();
        current.effectiveTo = addDays(body.effectiveFrom, -1);
        current.status = 'superseded';
        current.updatedBy = req.user._id;
        await current.save();
        await audit(req, { action: 'supersede', entity: 'EmployeeSalary', before, after: current, label: employee.employeeCode });
    }
    const rev = await EmployeeSalary.create({ ...body, employee: employee._id, status: 'active', createdBy: req.user._id, updatedBy: req.user._id });
    await audit(req, { action: 'create', entity: 'EmployeeSalary', after: rev, label: employee.employeeCode, note: body.reason || '' });
    res.status(201).json({ success: true, message: 'Salary revision saved', data: rev });
}));

/** Only revisions not yet used by a payroll may be corrected in place. */
router.put('/employee-salaries/:id', protect, can('salary.edit'), asyncHandler(async (req, res) => {
    const rev = await EmployeeSalary.findById(req.params.id);
    if (!rev || rev.status === 'cancelled') throw ApiError.notFound('Salary revision not found');
    if (rev.usedInPayroll) throw ApiError.conflict('This revision was used in a finalized payroll. Create a new revision instead.');
    const body = cleanRates(pick(req.body || {}, SALARY_FIELDS.filter(f => f !== 'effectiveFrom')));
    await validateRevision({ ...rev.toObject(), ...body });
    await assertEmployeePeriodOpen(rev.employee, rev.effectiveFrom, 'The salary effective date');
    const before = rev.toObject();
    rev.set({ ...body, updatedBy: req.user._id });
    await rev.save();
    const emp = await Employee.findById(rev.employee).lean();
    await audit(req, { action: 'update', entity: 'EmployeeSalary', before, after: rev, label: emp?.employeeCode, note: body.reason || '' });
    res.json({ success: true, message: 'Salary revision updated', data: rev });
}));

router.delete('/employee-salaries/:id', protect, can('salary.edit'), asyncHandler(async (req, res) => {
    const rev = await EmployeeSalary.findById(req.params.id);
    if (!rev || rev.status === 'cancelled') throw ApiError.notFound('Salary revision not found');
    if (rev.usedInPayroll) throw ApiError.conflict('This revision was used in a finalized payroll and cannot be removed');
    const before = rev.toObject();
    rev.status = 'cancelled';
    rev.updatedBy = req.user._id;
    await rev.save();
    // Re-open the revision this one had closed.
    const prev = await EmployeeSalary.findOne({ employee: rev.employee, status: 'superseded', effectiveTo: addDays(rev.effectiveFrom, -1) });
    if (prev && rev.effectiveTo == null) { prev.effectiveTo = null; prev.status = 'active'; await prev.save(); }
    const emp = await Employee.findById(rev.employee).lean();
    await audit(req, { action: 'cancel', entity: 'EmployeeSalary', before, after: rev, label: emp?.employeeCode });
    res.json({ success: true, message: 'Salary revision cancelled' });
}));

export default router;
