import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';

/**
 * Every permission the Payroll & HR module checks. Roles (StaffRole documents) hold a subset;
 * users with role "admin" implicitly hold all of them.
 */
export const PERMISSIONS = {
    'hr.dashboard.view': 'View payroll & HR dashboard',
    'org.manage': 'Manage companies, branches, departments, designations, groups',
    'employee.view': 'View employees',
    'employee.create': 'Create employees',
    'employee.edit': 'Edit employees',
    'employee.delete': 'Archive employees',
    'employee.bank.view': 'View employee bank details',
    'employee.bank.edit': 'Edit employee bank details',
    'salary.view': 'View salaries and payroll amounts',
    'salary.edit': 'Create salary revisions',
    'salaryConfig.manage': 'Manage salary components, structures and tax tables',
    'attendance.view': 'View attendance',
    'attendance.edit': 'Record and edit attendance',
    'attendance.import': 'Import attendance from Excel',
    'leave.view': 'View leave requests and balances',
    'leave.request': 'Request leave (own)',
    'leave.approve.supervisor': 'Approve leave as supervisor',
    'leave.approve': 'Give final (HR) leave approval',
    'leave.manage': 'Manage leave types and balances',
    'overtime.view': 'View overtime',
    'overtime.edit': 'Record overtime',
    'overtime.approve': 'Approve overtime',
    'advance.manage': 'Manage salary advances',
    'loan.manage': 'Manage employee loans',
    'payrollEntry.manage': 'Manage one-off allowances, bonuses and deductions',
    'externalPayment.manage': 'Record external payments',
    'externalPayment.approve': 'Approve external payments',
    'payroll.view': 'View payroll runs',
    'payroll.process': 'Create and calculate payroll',
    'payroll.approve': 'Approve payroll',
    'payroll.finalize': 'Finalize payroll',
    'payroll.pay': 'Record salary payments',
    'payroll.lock': 'Lock and unlock payroll periods',
    'payroll.adjust': 'Create post-finalization adjustments',
    'payslip.view': 'View all payslips',
    'payslip.view.own': 'View own payslips',
    'payroll.export': 'Export payroll data',
    'reports.view': 'View payroll & HR reports',
    'biometric.manage': 'Manage biometric devices and events',
    'settings.manage': 'Manage payroll settings',
    'roles.manage': 'Manage staff roles and back-office users',
    'audit.view': 'View payroll audit log',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

const all = ALL_PERMISSIONS;
const without = (...excluded) => all.filter(p => !excluded.includes(p));

/** Roles created by the migration. They can be edited or copied in the admin panel. */
export const DEFAULT_ROLES = [
    { code: 'PAYROLL_ADMIN', name: 'Payroll Admin', dataScope: 'all', permissions: all },
    {
        code: 'HR_MANAGER', name: 'HR Manager', dataScope: 'all',
        permissions: without('payroll.finalize', 'payroll.lock', 'payroll.pay', 'roles.manage', 'biometric.manage'),
    },
    {
        code: 'HR_OFFICER', name: 'HR Officer', dataScope: 'all',
        permissions: ['hr.dashboard.view', 'employee.view', 'employee.create', 'employee.edit', 'attendance.view', 'attendance.edit',
            'attendance.import', 'leave.view', 'leave.request', 'leave.approve', 'overtime.view', 'overtime.edit', 'reports.view', 'payslip.view.own'],
    },
    {
        code: 'ATTENDANCE_OFFICER', name: 'Attendance Officer', dataScope: 'all',
        permissions: ['hr.dashboard.view', 'employee.view', 'attendance.view', 'attendance.edit', 'attendance.import', 'overtime.view',
            'overtime.edit', 'biometric.manage', 'payslip.view.own', 'leave.request'],
    },
    {
        code: 'FINANCE_OFFICER', name: 'Finance Officer', dataScope: 'all',
        permissions: ['hr.dashboard.view', 'employee.view', 'employee.bank.view', 'salary.view', 'payroll.view', 'payroll.approve', 'payroll.pay',
            'payslip.view', 'payroll.export', 'reports.view', 'externalPayment.manage', 'externalPayment.approve', 'advance.manage', 'loan.manage'],
    },
    {
        code: 'DEPARTMENT_MANAGER', name: 'Department Manager', dataScope: 'department',
        permissions: ['hr.dashboard.view', 'employee.view', 'attendance.view', 'leave.view', 'leave.request', 'leave.approve.supervisor',
            'overtime.view', 'overtime.approve', 'reports.view', 'payslip.view.own'],
    },
    {
        code: 'SUPERVISOR', name: 'Supervisor', dataScope: 'team',
        permissions: ['employee.view', 'attendance.view', 'attendance.edit', 'leave.view', 'leave.request', 'leave.approve.supervisor',
            'overtime.view', 'overtime.edit', 'payslip.view.own'],
    },
    { code: 'EMPLOYEE', name: 'Employee', dataScope: 'own', permissions: ['leave.request', 'payslip.view.own'] },
];

/** Loads the effective permissions for req.user once per request. */
export const loadAccess = async (req) => {
    if (req.access) return req.access;
    const user = req.user;
    let access = { permissions: new Set(), dataScope: 'own', isAdmin: false, roleName: null };
    if (user?.role === 'admin') {
        access = { permissions: new Set(ALL_PERMISSIONS), dataScope: 'all', isAdmin: true, roleName: 'Administrator' };
    } else if (user?.staffRole) {
        const role = await mongoose.model('StaffRole').findById(user.staffRole).lean();
        if (role?.active !== false && role) {
            access = { permissions: new Set(role.permissions), dataScope: role.dataScope || 'own', isAdmin: false, roleName: role.name };
        }
    }
    req.access = access;
    return access;
};

export const hasPermission = (req, perm) => req.access?.permissions.has(perm);

/** Middleware: the user needs at least one of the listed permissions. */
export const can = (...perms) => async (req, res, next) => {
    try {
        if (!req.user) throw ApiError.unauthorized();
        const access = await loadAccess(req);
        if (!perms.some(p => access.permissions.has(p))) {
            throw ApiError.forbidden('You do not have permission to do that');
        }
        next();
    } catch (err) {
        next(err);
    }
};
