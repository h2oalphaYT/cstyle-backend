/* eslint-disable no-console, no-await-in-loop */
/**
 * Payroll demo data for January 2025 (a past period, so it never collides with real payroll):
 *
 *   A  DEMO-A  Anura Perera      Monthly office salary 100,000, 1 absent, 2 late days, 1 annual leave, 6h OT, loan
 *   B  DEMO-B  Bandara Silva     Daily worker 2,500/day, 20 days, 4h OT, salary advance
 *   C  DEMO-C  Chamari Fernando  Hourly 600 × 4h/day part-time
 *   D  DEMO-D  Dinesh Kumar      Restaurant hourly 500, OT 750/h, holiday OT, service charge, meal per day
 *   E  DEMO-E  Eranga Jayasuriya School/government staff with fixed allowances, 1 no-pay leave day, 5h OT,
 *                                 salary advance and an external special allowance
 *
 * Every record is tagged with "DEMO" codes so it can be removed with --reset.
 *   npm run payroll:demo            create (skips if it already exists)
 *   npm run payroll:demo -- --reset remove demo data and create it again
 */
import { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import User from '../models/User.js';
import * as M from '../payroll/models/index.js';
import { upsertAttendance } from '../payroll/services/attendanceService.js';
import { createLeaveRequest, decideLeave } from '../payroll/services/leaveService.js';
import crypto from 'crypto';
import { eachDay, weekday } from '../payroll/services/util.js';

// Demo staff password: DEMO_STAFF_PASSWORD from .env, otherwise a random one printed once.
const demoPassword = process.env.DEMO_STAFF_PASSWORD || `Demo-${crypto.randomBytes(5).toString('hex')}`;

export const DEMO_PERIOD = '2025-01';
export const DEMO_HOLIDAY = '2025-01-14';
const reset = process.argv.includes('--reset');

export const removeDemo = async () => {
    const emps = await M.Employee.find({ employeeCode: /^DEMO-/ }).select('_id').lean();
    const ids = emps.map(e => e._id);
    const runs = await M.PayrollRun.find({ name: /^DEMO/ }).select('_id').lean();
    const advances = await M.Advance.find({ employee: { $in: ids } }).select('_id').lean();
    await Promise.all([
        M.Attendance.deleteMany({ employee: { $in: ids } }),
        M.OvertimeEntry.deleteMany({ employee: { $in: ids } }),
        M.LeaveRequest.deleteMany({ employee: { $in: ids } }),
        M.LeaveBalance.deleteMany({ employee: { $in: ids } }),
        M.Installment.deleteMany({ source: { $in: advances.map(a => a._id) } }),
        M.Advance.deleteMany({ employee: { $in: ids } }),
        M.PayrollEntry.deleteMany({ employee: { $in: ids } }),
        M.ExternalPayment.deleteMany({ employee: { $in: ids } }),
        M.PayrollAdjustment.deleteMany({ employee: { $in: ids } }),
        M.EmployeeSalary.deleteMany({ employee: { $in: ids } }),
        M.PayrollRunEmployee.deleteMany({ $or: [{ employee: { $in: ids } }, { run: { $in: runs.map(r => r._id) } }] }),
        M.PayrollRun.deleteMany({ _id: { $in: runs.map(r => r._id) } }),
        M.BiometricMapping.deleteMany({ employee: { $in: ids } }),
        M.AttendanceEvent.deleteMany({ employee: { $in: ids } }),
    ]);
    await M.Employee.deleteMany({ _id: { $in: ids } });
    await M.Holiday.deleteMany({ name: /^DEMO/ });
    await M.BiometricDevice.deleteMany({ deviceCode: /^DEMO/ });
    const otherRuns = await M.PayrollRun.countDocuments({ periodCode: DEMO_PERIOD });
    if (!otherRuns) await M.PayrollPeriod.deleteMany({ code: DEMO_PERIOD });
    await M.OrgUnit.deleteMany({ code: /^DEMO/ });
    await M.Designation.deleteMany({ code: /^DEMO/ });
    await M.EmployeeGroup.deleteMany({ code: /^DEMO/ });
    await User.deleteMany({ email: /@demo\.cstyle\.lk$/ });
};

export const createDemo = async () => {
    const admin = await User.findOne({ role: 'admin' });
    if (!admin) throw new Error('Run "npm run seed" first so an admin user exists');
    const req = { user: admin, ip: 'seed-script', headers: { 'user-agent': 'seed-payroll-demo' } };
    const by = { createdBy: admin._id, updatedBy: admin._id };

    // ── Organisation ──
    const company = await M.OrgUnit.create({ type: 'company', code: 'DEMO-CO', name: 'DEMO Lanka Holdings', ...by });
    const unit = (type, code, name, extra = {}) => M.OrgUnit.create({ type, code, name, parent: company._id, ...extra, ...by });
    const headOffice = await unit('branch', 'DEMO-HO', 'DEMO Head Office (Colombo)');
    const restaurant = await unit('hub', 'DEMO-REST', 'DEMO Galle Face Restaurant', { category: 'Restaurant' });
    const school = await unit('hub', 'DEMO-SCH', 'DEMO Kandy Central School', { category: 'School' });
    const depAdmin = await unit('department', 'DEMO-ADM', 'DEMO Administration');
    const depOps = await unit('department', 'DEMO-OPS', 'DEMO Operations');
    const depKitchen = await unit('department', 'DEMO-KIT', 'DEMO Kitchen & Service');
    const depTeaching = await unit('department', 'DEMO-TCH', 'DEMO Teaching Staff');
    const ccFood = await unit('costCenter', 'DEMO-CC-FB', 'DEMO Food & Beverage');

    const des = async (code, name, department) => M.Designation.create({ code, name, department, ...by });
    const accountant = await des('DEMO-ACC', 'Accountant', depAdmin._id);
    const labourer = await des('DEMO-LAB', 'Labourer', depOps._id);
    const assistant = await des('DEMO-AST', 'Office Assistant', depAdmin._id);
    const steward = await des('DEMO-STW', 'Steward', depKitchen._id);
    const teacher = await des('DEMO-TEA', 'Teacher', depTeaching._id);

    const structure = async (code) => M.SalaryStructure.findOne({ code, deletedAt: null });
    const [sOffice, sSchool, sRest, sDaily] = await Promise.all(['MONTHLY_OFFICE', 'GOVT_SCHOOL', 'RESTAURANT_HOURLY', 'DAILY_WORKER'].map(structure));
    if (!sOffice) throw new Error('Run "npm run migrate" first');
    const grp = (code, name, s, settings = {}) => M.EmployeeGroup.create({ code, name, defaultSalaryStructure: s._id, settings, ...by });
    const gOffice = await grp('DEMO-OFFICE', 'DEMO Office Staff', sOffice);
    const gDaily = await grp('DEMO-DAILY', 'DEMO Daily Workers', sDaily);
    const gRest = await grp('DEMO-REST', 'DEMO Restaurant Staff', sRest);
    const gSchool = await grp('DEMO-SCHOOL', 'DEMO School / Government Staff', sSchool);

    await M.Holiday.create({ date: DEMO_HOLIDAY, name: 'DEMO Company Holiday', type: 'company', paid: true, orgUnits: [company._id], ...by });

    // ── Employees ──
    const common = { company: company._id, joiningDate: new Date('2024-06-01'), status: 'active', ...by };
    const emp = (o) => M.Employee.create({ ...common, ...o });
    const A = await emp({
        employeeCode: 'DEMO-A', fullName: 'Anura Perera', nic: '198512345678', gender: 'male', phone: '0771000001', email: 'anura@demo.cstyle.lk',
        employmentType: 'permanent', branch: headOffice._id, department: depAdmin._id, designation: accountant._id, group: gOffice._id,
        paymentMethod: 'bank_transfer', bank: { bankName: 'Commercial Bank', branchName: 'Colombo 03', accountNumber: '8001234567', accountName: 'A Perera' },
        statutory: { epfNumber: 'EPF-1001', etfNumber: 'ETF-1001', epfApplicable: true, etfApplicable: true },
    });
    const B = await emp({
        employeeCode: 'DEMO-B', fullName: 'Bandara Silva', nic: '199023456789', gender: 'male', employmentType: 'daily_paid', branch: headOffice._id,
        department: depOps._id, designation: labourer._id, group: gDaily._id, paymentMethod: 'cash', statutory: { epfApplicable: false, etfApplicable: false },
    });
    const C = await emp({
        employeeCode: 'DEMO-C', fullName: 'Chamari Fernando', nic: '199534567890', gender: 'female', employmentType: 'hourly_paid', branch: headOffice._id,
        department: depAdmin._id, designation: assistant._id, group: gOffice._id, paymentMethod: 'cash', workingHoursPerDay: 4,
    });
    const D = await emp({
        employeeCode: 'DEMO-D', fullName: 'Dinesh Kumar', nic: '199245678901', gender: 'male', employmentType: 'hourly_paid', hub: restaurant._id,
        department: depKitchen._id, costCenter: ccFood._id, designation: steward._id, group: gRest._id, paymentMethod: 'bank_transfer',
        bank: { bankName: 'Sampath Bank', branchName: 'Galle', accountNumber: '1029384756', accountName: 'D Kumar' },
    });
    const E = await emp({
        employeeCode: 'DEMO-E', fullName: 'Eranga Jayasuriya', nic: '198856789012', gender: 'female', employmentType: 'permanent', hub: school._id,
        department: depTeaching._id, designation: teacher._id, group: gSchool._id, paymentMethod: 'bank_transfer',
        bank: { bankName: 'Bank of Ceylon', branchName: 'Kandy', accountNumber: '0071234500', accountName: 'E Jayasuriya' },
    });
    await M.Employee.updateMany({ _id: { $in: [B._id, C._id] } }, { manager: A._id });

    // ── Salary revisions ──
    const comp = async (code) => (await M.SalaryComponent.findOne({ code }))._id;
    const rev = (employee, s, o) => M.EmployeeSalary.create({ employee: employee._id, structure: s._id, effectiveFrom: '2024-06-01', status: 'active', reason: 'Demo starting salary', ...o, ...by });
    // A had a raise effective 2024-12-01 — the earlier revision is kept as history.
    await M.EmployeeSalary.create({ employee: A._id, structure: sOffice._id, effectiveFrom: '2024-06-01', effectiveTo: '2024-11-30', status: 'superseded', basicSalary: 90000, reason: 'Starting salary', ...by });
    await M.EmployeeSalary.create({ employee: A._id, structure: sOffice._id, effectiveFrom: '2024-12-01', status: 'active', basicSalary: 100000, reason: 'Annual increment', ...by });
    await rev(B, sDaily, { basicSalary: 0, dailyRate: 2500 });
    await rev(C, sRest, {
        basicSalary: 0, hourlyRate: 600,
        overrides: [{ component: await comp('SERVICE_CHARGE'), enabled: false }, { component: await comp('MEAL'), enabled: false }, { component: await comp('ATTENDANCE_ALLOW'), enabled: false }],
    });
    await rev(D, sRest, { basicSalary: 0, hourlyRate: 500, otRate: 750 });
    await rev(E, sSchool, { basicSalary: 85000 });

    // ── Attendance for January 2025 ──
    const scheduled = eachDay('2025-01-01', '2025-01-31').filter(d => weekday(d) !== 0 && d !== DEMO_HOLIDAY);
    const mark = (employee, date, inTime, outTime, extra = {}) => upsertAttendance(req, { employee: employee._id, date, checkIn: inTime, checkOut: outTime, reason: 'Demo data', ...extra }, { source: 'excel' });
    for (const d of scheduled) {
        // A: absent 10th, late 2nd & 3rd, leave 17th (added below), OT 22nd–24th
        if (d === '2025-01-10') await mark(A, d, null, null, { status: 'absent' });
        else if (d === '2025-01-17') { /* annual leave */ } else if (['2025-01-02', '2025-01-03'].includes(d)) await mark(A, d, '08:50', '17:50');
        else if (['2025-01-22', '2025-01-23', '2025-01-24'].includes(d)) await mark(A, d, '08:25', '19:25');
        else await mark(A, d, '08:25', '17:25');
        // B: absent from the 25th, OT on 1st & 2nd
        if (d >= '2025-01-25') await mark(B, d, null, null, { status: 'absent' });
        else if (['2025-01-01', '2025-01-02'].includes(d)) await mark(B, d, '08:25', '19:25');
        else await mark(B, d, '08:25', '17:25');
        // C: 4 hours a day, no break
        await mark(C, d, '08:30', '12:30', { breakMinutes: 0 });
        // D: OT 6th–10th
        if (d >= '2025-01-06' && d <= '2025-01-10') await mark(D, d, '08:25', '19:25');
        else await mark(D, d, '08:25', '17:25');
        // E: no-pay leave 16th (added below)
        if (d !== '2025-01-16') await mark(E, d, '08:25', '17:25');
    }
    // D worked 4 hours on the company holiday → holiday OT.
    await mark(D, DEMO_HOLIDAY, '08:25', '12:25', { breakMinutes: 0 });
    // Approve attendance-generated overtime.
    await M.OvertimeEntry.updateMany({ employee: { $in: [A._id, B._id, D._id] }, status: 'pending' }, { status: 'approved', approvedBy: admin._id, approvedAt: new Date() });
    // E: 5 hours special OT recorded manually (e.g. school event), approved.
    const normalOt = await M.OvertimeType.findOne({ code: 'NORMAL' });
    await M.OvertimeEntry.create({ employee: E._id, date: '2025-01-18', overtimeType: normalOt._id, hours: 5, source: 'manual', status: 'approved', approvedBy: admin._id, remarks: 'Sports meet', ...by });

    // ── Leave ──
    const annual = await M.LeaveType.findOne({ code: 'ANNUAL' });
    const nopay = await M.LeaveType.findOne({ code: 'NOPAY' });
    const la = await createLeaveRequest(req, { employee: A._id, leaveType: annual._id, fromDate: '2025-01-17', toDate: '2025-01-17', reason: 'Family event' });
    await decideLeave(req, la, { decision: 'approved', level: 'hr', note: 'Demo approval' });
    const le = await createLeaveRequest(req, { employee: E._id, leaveType: nopay._id, fromDate: '2025-01-16', toDate: '2025-01-16', reason: 'Personal' });
    await decideLeave(req, le, { decision: 'approved', level: 'hr', note: 'Demo approval' });

    // ── Loans, advances, entries, external payments ──
    const loan = await M.Advance.create({
        kind: 'loan', employee: A._id, reference: 'DEMO-LN-1', amount: 60000, totalPayable: 60000, installmentCount: 3, installmentAmount: 20000,
        date: '2024-12-20', startPeriod: DEMO_PERIOD, endPeriod: '2025-03', reason: 'Personal loan', status: 'approved', approvedBy: admin._id, ...by,
    });
    const adv = (employee, amount, count, ref) => M.Advance.create({
        kind: 'advance', employee: employee._id, reference: ref, amount, totalPayable: amount, installmentCount: count, installmentAmount: amount / count,
        date: '2024-12-28', startPeriod: DEMO_PERIOD, reason: 'Salary advance', status: 'approved', approvedBy: admin._id, ...by,
    });
    const advB = await adv(B, 10000, 2, 'DEMO-ADV-B');
    const advE = await adv(E, 15000, 3, 'DEMO-ADV-E');
    const schedule = async (a) => {
        for (let i = 0; i < a.installmentCount; i += 1) {
            const [y, m] = DEMO_PERIOD.split('-').map(Number);
            const period = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7);
            await M.Installment.create({ source: a._id, kind: a.kind, employee: a.employee, sequence: i + 1, period, amount: a.installmentAmount });
        }
    };
    await schedule(loan);
    await schedule(advB);
    await schedule(advE);

    await M.PayrollEntry.create({ employee: D._id, period: DEMO_PERIOD, component: await comp('SERVICE_CHARGE'), amount: 12000, note: 'January service charge share', status: 'approved', approvedBy: admin._id, ...by });
    await M.ExternalPayment.create({
        employee: E._id, paymentType: 'external_allowance', amount: 3000, date: '2025-01-20', paymentMethod: 'cash', referenceNumber: 'DEMO-EXT-1',
        reason: 'Exam supervision allowance', period: DEMO_PERIOD, payrollTreatment: 'earning', status: 'approved', approvedBy: admin._id, ...by,
    });

    // ── Biometric demo device + mappings (no physical device needed) ──
    const device = await M.BiometricDevice.create({ deviceCode: 'DEMO-FP1', name: 'DEMO Head Office Fingerprint', serialNumber: 'DEMO-SN-001', ipAddress: '192.168.1.201', port: 4370, branch: headOffice._id, protocol: 'push_api', eventMode: 'first_last', ...by });
    for (const [e, uid] of [[A, '1001'], [B, '1002'], [C, '1003']]) await M.BiometricMapping.create({ employee: e._id, device: device._id, biometricUserId: uid, ...by });

    // ── Staff logins to try the permissions ──
    const role = async (code) => (await M.StaffRole.findOne({ code }))._id;
    const staff = async (name, email, roleCode, employee = null) => {
        const u = new User({ name, email, role: 'staff', staffRole: await role(roleCode), employee: employee?._id || null });
        await u.setPassword(demoPassword);
        await u.save();
        if (employee) await M.Employee.updateOne({ _id: employee._id }, { user: u._id });
        return u;
    };
    await staff('Demo Finance Officer', 'finance@demo.cstyle.lk', 'FINANCE_OFFICER');
    await staff('Demo HR Officer', 'hr@demo.cstyle.lk', 'HR_OFFICER');
    await staff('Anura Perera', 'anura@demo.cstyle.lk', 'EMPLOYEE', A);

    return { company, employees: { A, B, C, D, E } };
};

const main = async () => {
    assertConfig();
    await connectDB();
    const exists = await M.Employee.exists({ employeeCode: /^DEMO-/ });
    if (exists && !reset) {
        console.log('Demo data already exists. Use --reset to recreate it.');
        return;
    }
    if (exists) { await removeDemo(); console.log('🧹 Removed previous demo data'); }
    await createDemo();
    console.log(`✅ Payroll demo data created for ${DEMO_PERIOD} (employees DEMO-A … DEMO-E).`);
    console.log(`   Staff logins: finance@demo.cstyle.lk, hr@demo.cstyle.lk, anura@demo.cstyle.lk — password: ${demoPassword}`);
    console.log('   Next: Payroll & HR → Payroll Processing → new run for 2025-01, company "DEMO Lanka Holdings".');
};

if (process.argv[1] && process.argv[1].endsWith('seed-payroll-demo.js')) {
    main().catch((err) => { console.error('❌ Demo seed failed:', err); process.exitCode = 1; }).finally(() => disconnectDB());
}
