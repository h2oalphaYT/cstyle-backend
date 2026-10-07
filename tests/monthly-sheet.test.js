// Monthly salary sheet import against a running API (npm run dev), after `npm run migrate` and
// `node scripts/import-staff.js …` (which creates the SHOP_DAILY structure and Shop Staff group).
// Builds a sheet in the shop's Excel layout for temporary TSHEET-* employees, imports it, checks the
// payroll preview against the sheet's salary column, undoes the import and removes the test data.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import * as M from '../payroll/models/index.js';
import { eachDay, weekday } from '../payroll/services/util.js';

dotenv.config();
const API = `${process.env.TEST_API_URL || `http://localhost:${process.env.PORT || 5000}`}/api`;
const PERIOD = '2026-09';
const HOLIDAY = '2026-09-26';

const call = async (method, path, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
};

// Rows taken from the September 2026 sheet (rates and totals), with test codes and names.
const STAFF = [
    { code: 'TSHEET-1', name: 'Sheet Test One', basic: 31000, rate: 1500, days: 23, ot: 1, late: 6.5, sundays: 0, sundayHours: 0, advance: 0, salary: 27667.5 },
    { code: 'TSHEET-2', name: 'Sheet Test Two', basic: 35000, rate: 1500, days: 23.5, ot: 9, late: 3, sundays: 1, sundayHours: 7, advance: 0, salary: 36766 },
    { code: 'TSHEET-3', name: 'Sheet Test Three', basic: 31000, rate: 1500, days: 20, ot: 5, late: 7.5, sundays: 0, sundayHours: 7, advance: 7500, salary: 18228.5 },
    { code: 'TSHEET-4', name: 'Sheet Test Four', basic: 27000, rate: 1200, days: 19, ot: 2, late: 1, sundays: 1, sundayHours: 7, advance: 0, salary: 22905 },
    { code: 'TSHEET-5', name: 'Sheet Test Five', basic: 20000, rate: 1100, fixed: true, days: 0, ot: 0, late: 0, sundays: 0, sundayHours: 0, advance: 0, salary: 20000 },
];
const sundayFormula = (r) => `floor(OTHours_WEEKEND / 8) * ${r} + (OTHours_WEEKEND - floor(OTHours_WEEKEND / 8) * 8) * round(${r} / 8)`;

let admin;
let employees = [];
let batchId;
let createdHoliday = null;

const cleanup = async () => {
    const emps = await M.Employee.find({ employeeCode: /^TSHEET-/ }).select('_id').lean();
    const ids = emps.map(e => e._id);
    const advances = await M.Advance.find({ employee: { $in: ids } }).select('_id').lean();
    await Promise.all([
        M.Attendance.deleteMany({ employee: { $in: ids } }),
        M.OvertimeEntry.deleteMany({ employee: { $in: ids } }),
        M.Installment.deleteMany({ source: { $in: advances.map(a => a._id) } }),
        M.Advance.deleteMany({ employee: { $in: ids } }),
        M.EmployeeSalary.deleteMany({ employee: { $in: ids } }),
        M.ImportBatch.deleteMany({ fileName: 'tsheet-september.xlsx' }),
    ]);
    await M.Employee.deleteMany({ _id: { $in: ids } });
};

const buildSheet = async () => {
    const workdays = eachDay(`${PERIOD}-01`, `${PERIOD}-30`).filter(d => weekday(d) !== 0 && d !== HOLIDAY);
    const sundays = eachDay(`${PERIOD}-01`, `${PERIOD}-30`).filter(d => weekday(d) === 0);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sep');
    ws.addRow(['1-Sep']);
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    ws.addRow(['NO', 'JO.DATE', 'NO', 'NAME', ...days, '', '', 'DAY', 'WORKING DAY', 'AMOUNT', 'OT', 'LOT', 'TOT', 'LATE HOURS', 'REDUCING', 'SUNDAYS',
        'PER 1.5 DAY', '', 'SUNDAY II', 'SUNDY II', 'PER S.TII', 'ADVANCE', 'SALARY', 'pr.alv']);
    STAFF.forEach((s, i) => {
        const marks = days.map(() => '');
        if (!s.fixed) {
            let left = s.days;
            for (const d of workdays) {
                const v = left >= 1 ? 1 : left > 0 ? 0.5 : 0;
                marks[Number(d.slice(8)) - 1] = v;
                left -= v;
            }
            if (s.sundays) marks[Number(sundays[1].slice(8)) - 1] = '1a';
        }
        ws.addRow([i + 1, '2025-01-01', s.code, s.name, ...marks, s.days, s.basic, 25, s.days, 0, s.ot, 0, 0, s.late, 0, s.sundays || '',
            s.rate, '', 0, s.sundayHours || '', 0, s.advance || '', s.salary, '']);
    });
    ws.addRow(['', '', '', '', ...days.map(() => ''), 0]); // totals row without a name is ignored
    return Buffer.from(await wb.xlsx.writeBuffer());
};

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined });
    await cleanup();
    const [structure, group, sunday, basic] = await Promise.all([
        M.SalaryStructure.findOne({ code: 'SHOP_DAILY', deletedAt: null }), M.EmployeeGroup.findOne({ code: 'SHOP_STAFF', deletedAt: null }),
        M.SalaryComponent.findOne({ code: 'SUNDAY_PAY', deletedAt: null }), M.SalaryComponent.findOne({ code: 'BASIC', deletedAt: null }),
    ]);
    assert.ok(structure && group && sunday, 'Run scripts/import-staff.js first (SHOP_DAILY structure and Shop Staff group)');
    if (!(await M.Holiday.exists({ date: HOLIDAY, deletedAt: null, ...M.OBSERVED }))) createdHoliday = await M.Holiday.create({ date: HOLIDAY, name: 'Poya (test)' });
    for (const s of STAFF) {
        const emp = await M.Employee.create({
            employeeCode: s.code, fullName: s.name, joiningDate: new Date('2025-01-01T00:00:00Z'), group: group._id, paymentMethod: 'cash',
            attendanceRequired: !s.fixed, statutory: { epfApplicable: false, etfApplicable: false },
        });
        const overrides = [{ component: sunday._id, formula: sundayFormula(s.rate) }];
        if (s.fixed) overrides.push({ component: basic._id, formula: 'BasicSalary' });
        await M.EmployeeSalary.create({ employee: emp._id, structure: structure._id, effectiveFrom: `${PERIOD}-01`, basicSalary: s.basic, otRate: Math.round(s.basic / 25 / 8 * 100) / 100, overrides });
        employees.push({ ...s, id: String(emp._id) });
    }
    const login = await call('POST', '/auth/login', { body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD } });
    admin = login.data.token;
});

after(async () => {
    await cleanup();
    if (createdHoliday) await M.Holiday.deleteOne({ _id: createdHoliday._id });
    await mongoose.disconnect();
});

test('reads the monthly sheet layout', async () => {
    const form = new FormData();
    form.append('file', new Blob([await buildSheet()]), 'tsheet-september.xlsx');
    form.append('period', PERIOD);
    const res = await call('POST', '/attendance/monthly-sheet/validate', { token: admin, form });
    assert.equal(res.status, 201, res.message);
    const rows = res.data.rows.filter(r => /^TSHEET-/.test(r.data.employeeCode));
    assert.equal(rows.length, STAFF.length);
    for (const r of rows) {
        const s = STAFF.find(x => x.code === r.data.employeeCode);
        assert.deepEqual(r.problems, [], `${s.code} problems`);
        if (!s.fixed) assert.equal(r.data.workedDays, s.days, `${s.code} days`);
        assert.equal(r.data.ot, s.ot);
        assert.equal(r.data.late, s.late);
        assert.equal(r.data.sundayDays, s.sundays);
        assert.equal(r.data.sundayHours, s.sundayHours);
        assert.equal(r.data.advance, s.advance);
    }
    batchId = res.data.id || res.data._id;
});

test('import + payroll preview matches the sheet salary', async () => {
    const res = await call('POST', `/attendance/monthly-sheet/${batchId}/commit`, { token: admin });
    assert.equal(res.status, 200, res.message);
    for (const s of employees) {
        const p = await call('POST', '/payroll/preview', { token: admin, body: { employee: s.id, period: PERIOD } });
        assert.equal(p.status, 200, p.message);
        assert.ok(Math.abs(p.data.net - s.salary) < 0.01, `${s.code}: system ${p.data.net}, sheet ${s.salary}`);
    }
});

test('undo removes the imported month', async () => {
    const res = await call('POST', `/attendance/monthly-sheet/${batchId}/revert`, { token: admin });
    assert.equal(res.status, 200, res.message);
    const ids = employees.map(e => e.id);
    assert.equal(await M.Attendance.countDocuments({ employee: { $in: ids }, deletedAt: null }), 0);
    assert.equal(await M.OvertimeEntry.countDocuments({ employee: { $in: ids }, deletedAt: null }), 0);
    const p = await call('POST', '/payroll/preview', { token: admin, body: { employee: employees[0].id, period: PERIOD } });
    assert.equal(p.data.net, 0);
});
