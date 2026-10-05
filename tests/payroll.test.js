// End-to-end Payroll & HR workflow against a running API (npm run dev) and the configured database.
//   npm run migrate && npm run test:payroll
// The test recreates the DEMO-* employees for January 2025, runs payroll, finalizes and pays it,
// then restores fresh demo data so the admin panel still has something to explore.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import * as M from '../payroll/models/index.js';
import { createDemo, DEMO_PERIOD, removeDemo } from '../scripts/seed-payroll-demo.js';

dotenv.config();
const BASE = process.env.TEST_API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;

const call = async (method, path, { token, body, form, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body) h['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers: h, body: form || (body ? JSON.stringify(body) : undefined) });
    if (raw) return res;
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
};
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.011, `${msg}: expected ${expected}, got ${actual}`);

let admin;
let employeeToken;
let company;
let run;
let lines;
const byCode = (code) => lines.find(l => l.snapshot.employeeCode === code);
const item = (line, code) => line.items.find(i => i.code === code)?.amount ?? 0;

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined });
    await removeDemo();
    ({ company } = await createDemo());
    const login = await call('POST', '/auth/login', { body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD } });
    assert.equal(login.status, 200, login.message);
    admin = login.data.token;
    assert.ok(login.data.user.permissions.includes('payroll.finalize'), 'admin carries payroll permissions');
    const emp = await call('POST', '/auth/login', { body: { email: 'anura@demo.cstyle.lk', password: process.env.DEMO_STAFF_PASSWORD } });
    assert.equal(emp.status, 200, 'employee self-service login (set DEMO_STAFF_PASSWORD in .env)');
    employeeToken = emp.data.token;
});

after(async () => {
    await removeDemo();
    await createDemo();
    await mongoose.disconnect();
});

test('formula engine API: validates and rejects unsafe formulas', async () => {
    const ok = await call('POST', '/salary-components/test-formula', { token: admin, body: { formula: 'BasicSalary / WorkingDays', sample: { BasicSalary: 100000 } } });
    assert.equal(ok.data.ok, true);
    near(ok.data.value, 3846.15, 'daily rate');
    for (const bad of ['process.exit(1)', 'require("fs")', 'BasicSalary; 1', 'UnknownVar * 2', 'constructor']) {
        const r = await call('POST', '/salary-components/test-formula', { token: admin, body: { formula: bad } });
        assert.equal(r.data.ok, false, `"${bad}" must be rejected`);
    }
});

test('permissions: an Employee-role user cannot see payroll or other staff', async () => {
    assert.equal((await call('GET', '/payroll/runs', { token: employeeToken })).status, 403);
    assert.equal((await call('GET', '/employees', { token: employeeToken })).status, 403);
    assert.equal((await call('GET', '/payroll/reports/monthly-payroll', { token: employeeToken })).status, 403);
    const me = await call('GET', '/payroll/me', { token: employeeToken });
    assert.equal(me.data.employee.employeeCode, 'DEMO-A');
    assert.ok(me.data.leaveBalances.some(b => b.leaveType.code === 'ANNUAL'));
});

test('payroll run: calculates all five pay types correctly', async () => {
    const created = await call('POST', '/payroll/runs', { token: admin, body: { period: DEMO_PERIOD, name: 'DEMO January 2025', filters: { company: String(company._id) } } });
    assert.equal(created.status, 201, created.message);
    run = created.data;
    assert.equal(run.status, 'calculated');
    assert.equal(run.totals.employees, 5);
    lines = (await call('GET', `/payroll/runs/${run.id}/employees`, { token: admin })).data;

    // A — monthly 100,000: 1 absent (no-pay, loses attendance allowance), 40 late minutes, 6h normal OT, loan 20,000
    const A = byCode('DEMO-A');
    near(item(A, 'BASIC'), 100000, 'A basic');
    near(item(A, 'ATTENDANCE_ALLOW'), 0, 'A attendance allowance lost due to absence');
    near(item(A, 'OT'), 6 * 721.16, 'A OT = 6h × (100000/26/8 × 1.5)');
    near(item(A, 'NOPAY'), 3846.15, 'A no-pay = 1 day × 100000/26');
    near(item(A, 'LATE'), 320.51, 'A late = 40 min × hourly / 60');
    near(item(A, 'LOAN'), 20000, 'A loan installment');
    near(item(A, 'EPF_EE'), 7692.31, 'A EPF 8% of (basic − no-pay)');
    near(A.gross, 119326.96, 'A gross');
    near(A.net, 87467.99, 'A net');
    assert.equal(A.variables.PaidLeaveDays, 1, 'A annual leave is paid');
    assert.match(A.items.find(i => i.code === 'OT').calculation.explanation, /6 h ×/);

    // B — daily 2,500 × 20 days + 4h OT at 312.5 × 1.5, advance 5,000
    const B = byCode('DEMO-B');
    near(item(B, 'BASIC'), 50000, 'B basic = 2500 × 20');
    near(item(B, 'OT'), 1875, 'B OT');
    near(item(B, 'ADVANCE'), 5000, 'B advance');
    near(B.net, 46875, 'B net');

    // C — hourly 600 × 4h × 26 days, EPF 8%
    const C = byCode('DEMO-C');
    near(item(C, 'BASIC'), 62400, 'C basic = 600 × 104h');
    near(C.net, 57408, 'C net');
    assert.equal(item(C, 'MEAL'), 0, 'C has meal allowance disabled by override');

    // D — restaurant: 500 × 208h, 12,000 service charge, meal 300 × 27 days, OT 10h × 750 + 4h holiday × 1000
    const D = byCode('DEMO-D');
    near(item(D, 'BASIC'), 104000, 'D basic');
    near(item(D, 'SERVICE_CHARGE'), 12000, 'D service charge');
    near(item(D, 'MEAL'), 8100, 'D meal per attendance day');
    near(item(D, 'OT'), 11500, 'D OT (normal at OT rate + holiday at 2×)');
    near(D.gross, 138600, 'D gross');
    near(D.net, 130280, 'D net');

    // E — school: 85,000 + 15,000 + 7,500, 5h OT, external allowance 3,000, 1 no-pay leave day, advance 5,000
    const E = byCode('DEMO-E');
    near(item(E, 'HOUSING'), 15000, 'E housing');
    near(item(E, 'EXTERNAL_PAY'), 3000, 'E external allowance included');
    near(item(E, 'NOPAY'), 3269.23, 'E no-pay leave');
    near(item(E, 'OT'), 3064.85, 'E OT 5h');
    near(E.net, 98757.16, 'E net');
    assert.equal(E.variables.UnpaidLeaveDays, 1);

    near(run.totals.net, 87467.99 + 46875 + 57408 + 130280 + 98757.16, 'run total net');
});

test('preview endpoint matches the run', async () => {
    const A = byCode('DEMO-A');
    const p = await call('POST', '/payroll/preview', { token: admin, body: { employee: String(A.employee), period: DEMO_PERIOD } });
    near(p.data.net, A.net, 'preview net');
});

test('approval workflow, period lock and adjustments', async () => {
    assert.equal((await call('POST', `/payroll/runs/${run.id}/submit`, { token: admin })).data.status, 'under_review');
    // Approved payroll blocks attendance changes for its employees.
    const approved = await call('POST', `/payroll/runs/${run.id}/approve`, { token: admin });
    assert.equal(approved.data.status, 'approved');
    const A = byCode('DEMO-A');
    const blocked = await call('POST', '/attendance', { token: admin, body: { employee: String(A.employee), date: '2025-01-11', inTime: '08:30', outTime: '17:00', reason: 'Correction' } });
    assert.equal(blocked.status, 409, 'attendance is locked once payroll is approved');

    const fin = await call('POST', `/payroll/runs/${run.id}/finalize`, { token: admin });
    assert.equal(fin.status, 200, fin.message);
    assert.equal(fin.data.status, 'finalized');
    assert.equal((await call('POST', `/payroll/runs/${run.id}/calculate`, { token: admin })).status, 409, 'finalized payroll cannot be recalculated');

    const loan = await M.Advance.findOne({ reference: 'DEMO-LN-1' }).lean();
    assert.equal(loan.recovered, 20000, 'loan installment recorded as recovered');
    assert.equal(loan.status, 'active');
    const advB = await M.Advance.findOne({ reference: 'DEMO-ADV-B' }).lean();
    assert.equal(advB.recovered, 5000);
    assert.equal((await M.PayrollEntry.findOne({ employee: byCode('DEMO-D').employee }).lean()).status, 'processed');
    assert.equal((await M.ExternalPayment.findOne({ referenceNumber: 'DEMO-EXT-1' }).lean()).status, 'processed');

    // Payslips: employees see only their own, and only once finalized.
    lines = (await call('GET', `/payroll/runs/${run.id}/employees`, { token: admin })).data;
    const ownPdf = await call('GET', `/payslips/${byCode('DEMO-A').id}/pdf`, { token: employeeToken, raw: true });
    assert.equal(ownPdf.status, 200);
    assert.equal(ownPdf.headers.get('content-type'), 'application/pdf');
    assert.equal((await call('GET', `/payslips/${byCode('DEMO-B').id}/pdf`, { token: employeeToken, raw: true })).status, 404, 'cannot open another employee payslip');
    assert.match(byCode('DEMO-A').payslipNumber, /^PS-202501-\d{4}$/);

    // Exports
    const xlsx = await call('GET', `/payroll/runs/${run.id}/export?format=xlsx`, { token: admin, raw: true });
    assert.equal(xlsx.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
    assert.ok(wb.worksheets[0].rowCount >= 6, 'payroll Excel has a header and 5 employees');
    const allSlips = await call('GET', `/payroll/runs/${run.id}/payslips.pdf`, { token: admin, raw: true });
    assert.equal(allSlips.headers.get('content-type'), 'application/pdf');
    const report = await call('GET', `/payroll/reports/department-payroll?from=2025-01-01&to=2025-01-31&company=${company._id}`, { token: admin });
    assert.ok(report.data.rows.length >= 4);
    const bank = await call('GET', `/payroll/reports/bank-payment?from=2025-01-01&to=2025-01-31&company=${company._id}`, { token: admin });
    assert.equal(bank.data.rows.length, 3, 'A, D and E are paid by bank transfer');

    // Payments
    const paid = await call('POST', `/payroll/runs/${run.id}/payments`, { token: admin, body: { status: 'paid', method: 'bank_transfer', date: '2025-01-31', reference: 'BULK-0125' } });
    assert.equal(paid.data.status, 'paid');

    // Lock the period: no more direct changes; corrections go through adjustments.
    const period = (await call('GET', '/payroll/periods', { token: admin })).data.find(p => p.code === DEMO_PERIOD);
    assert.equal(period.status, 'finalized');
    assert.equal((await call('PATCH', `/payroll/periods/${period.id}/lock`, { token: admin })).data.status, 'locked');
    const late = await call('POST', '/attendance', { token: admin, body: { employee: String(byCode('DEMO-C').employee), date: '2025-01-30', inTime: '08:30', outTime: '12:30', reason: 'x' } });
    assert.equal(late.status, 409);
    const adj = await call('POST', '/payroll/adjustments', { token: admin, body: { employee: String(byCode('DEMO-C').employee), originalPeriod: DEMO_PERIOD, targetPeriod: '2025-02', type: 'earning', amount: 1200, reason: 'Missed hours on 30 Jan' } });
    assert.equal(adj.status, 201, adj.message);
    assert.equal((await call('PATCH', `/payroll/periods/${period.id}/unlock`, { token: admin, body: {} })).status, 422, 'unlock needs a reason');

    const logs = await call('GET', `/payroll/audit-logs?entity=PayrollRun&recordId=${run.id}`, { token: admin });
    const actions = logs.data.map(l => l.action);
    for (const a of ['create', 'calculate', 'approve', 'finalize']) assert.ok(actions.includes(a), `audit has ${a}`);
});

test('Excel attendance import validates rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');
    ws.addRow(['Employee Code', 'Employee Name', 'Date', 'In Time', 'Out Time', 'Status', 'OT Hours', 'Remarks']);
    ws.addRow(['DEMO-C', 'Chamari Fernando', '2025-02-03', '08:30', '12:30', '', '', 'ok']);
    ws.addRow(['NOPE-1', 'Nobody', '2025-02-03', '08:30', '12:30', '', '', '']);
    ws.addRow(['DEMO-C', '', '2025-02-03', '08:30', '12:30', '', '', 'duplicate']);
    ws.addRow(['DEMO-B', '', '2025-02-30', '08:30', '17:30', '', '', 'bad date']);
    ws.addRow(['DEMO-B', '', '2025-02-04', '18:00', '08:00', '', '', 'out before in']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'feb.xlsx');
    const v = await call('POST', '/attendance/import/validate', { token: admin, form });
    assert.equal(v.status, 201, v.message);
    assert.equal(v.data.validRows, 1);
    assert.equal(v.data.errorRows, 4);
    const errs = v.data.rows.flatMap(r => r.problems).join(' | ');
    assert.match(errs, /Unknown employee/);
    assert.match(errs, /Duplicate/);
    assert.match(errs, /Invalid date/);
    assert.match(errs, /not after/);
    const c = await call('POST', `/attendance/import/${v.data._id || v.data.id}/commit`, { token: admin });
    assert.equal(c.data.imported, 1);
    const report = await call('GET', `/attendance/import/${v.data._id || v.data.id}/errors`, { token: admin, raw: true });
    assert.equal(report.status, 200);
});

test('biometric push API creates attendance from punches', async () => {
    const device = await M.BiometricDevice.findOne({ deviceCode: 'DEMO-FP1' });
    const key = (await call('POST', `/biometric/devices/${device._id}/api-key`, { token: admin })).data.apiKey;
    const bad = await call('POST', '/biometric/events', { headers: { 'X-Device-Code': 'DEMO-FP1', 'X-Device-Key': 'wrong' }, body: { events: [] } });
    assert.equal(bad.status, 401);
    const push = await call('POST', '/biometric/events', {
        headers: { 'X-Device-Code': 'DEMO-FP1', 'X-Device-Key': key },
        body: { events: [
            { biometricUserId: '1003', timestamp: '2025-02-05T08:29:00+05:30' },
            { biometricUserId: '1003', timestamp: '2025-02-05T08:30:00+05:30' }, // duplicate within window
            { biometricUserId: '1003', timestamp: '2025-02-05T12:31:00+05:30' },
            { biometricUserId: '9999', timestamp: '2025-02-05T08:00:00+05:30' }, // unmapped
        ] },
    });
    assert.equal(push.status, 202, push.message);
    assert.equal(push.data.stored, 4);
    const att = await M.Attendance.findOne({ employee: byCode('DEMO-C').employee, date: '2025-02-05', deletedAt: null }).lean();
    assert.equal(att.source, 'fingerprint');
    assert.ok(att.checkIn && att.checkOut, 'first punch = in, last punch = out');
    assert.equal(new Date(att.checkIn).toISOString(), '2025-02-05T02:59:00.000Z');
    const unmapped = await M.AttendanceEvent.findOne({ biometricUserId: '9999' }).lean();
    assert.equal(unmapped.status, 'error');
});

test('leave workflow: request, approval, balance', async () => {
    const casual = await M.LeaveType.findOne({ code: 'CASUAL' }).lean();
    const req = await call('POST', '/leave-requests', { token: employeeToken, body: { leaveType: String(casual._id), fromDate: '2025-02-07', toDate: '2025-02-07', reason: 'Personal' } });
    assert.equal(req.status, 201, req.message);
    assert.equal(req.data.status, 'pending');
    assert.equal((await call('PATCH', `/leave-requests/${req.data.id}/approve`, { token: employeeToken })).status, 403, 'employee cannot approve');
    const ok = await call('PATCH', `/leave-requests/${req.data.id}/approve`, { token: admin, body: { note: 'OK' } });
    assert.equal(ok.data.status, 'approved');
    const bal = await M.LeaveBalance.findOne({ employee: byCode('DEMO-A').employee, leaveType: casual._id, year: 2025 }).lean();
    assert.equal(bal.used, 1);
    const att = await M.Attendance.findOne({ employee: byCode('DEMO-A').employee, date: '2025-02-07', deletedAt: null }).lean();
    assert.equal(att.status, 'leave');
    const tooMuch = await call('POST', '/leave-requests', { token: employeeToken, body: { leaveType: String(casual._id), fromDate: '2025-02-10', toDate: '2025-02-14', reason: 'x' } });
    assert.equal(tooMuch.status, 422, 'casual leave limited to 2 days per request');
});
