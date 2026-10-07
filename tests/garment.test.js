// Garment features against a running API (npm run dev) after `npm run migrate`:
// leave no-pay split and monthly leave count, holidays the factory does not close for,
// garment setup, demo-data removal checks, and daily production targets / the TV board.
// Test records use GTEST codes and 2027 dates, and are removed afterwards.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import * as M from '../payroll/models/index.js';
import { holidayDocs, SRI_LANKA_HOLIDAYS } from '../payroll/data/sriLankaHolidays.js';
import { hourlyBuckets, paceFor } from '../payroll/services/productionService.js';
import { GARMENT_ROLES, setupGarment } from '../scripts/setup-garment.js';
import { demoReport } from '../scripts/remove-payroll-demo.js';

dotenv.config();
const API = `${process.env.TEST_API_URL || `http://localhost:${process.env.PORT || 5000}`}/api`;
const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
};

const BOARD_EMAIL = 'tv@gtest.cstyle.lk';
const PROD_DAY = '2026-01-07'; // a past Wednesday so entries are allowed and the day is not "today"
let admin;
let boardToken;
let emp;
let annual;
let nopay;
let savedSettings;
let createdHolidays = [];

const setSettings = (values) => call('PUT', '/payroll/settings', { token: admin, body: { scope: 'global', values } });

const cleanup = async () => {
    const ids = (await M.Employee.find({ employeeCode: /^GTEST-/ }).select('_id').lean()).map(e => e._id);
    await Promise.all([
        M.LeaveRequest.deleteMany({ employee: { $in: ids } }),
        M.LeaveBalance.deleteMany({ employee: { $in: ids } }),
        M.Attendance.deleteMany({ employee: { $in: ids } }),
        M.ProductionLog.deleteMany({ date: PROD_DAY }),
        M.ProductionTarget.deleteMany({ date: PROD_DAY }),
        M.Holiday.deleteMany({ name: /^GTEST/ }),
        User.deleteMany({ email: BOARD_EMAIL }),
    ]);
    await M.Employee.deleteMany({ _id: { $in: ids } });
};

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined });
    await cleanup();
    const login = await call('POST', '/auth/login', { body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD } });
    assert.equal(login.status, 200, login.message);
    admin = login.data.token;
    savedSettings = (await M.PayrollSetting.findOne({ scope: 'global', scopeRef: null }).lean())?.values || {};
    emp = await M.Employee.create({ employeeCode: 'GTEST-1', fullName: 'Garment Test Operator', joiningDate: new Date('2026-01-01'), status: 'active' });
    annual = await M.LeaveType.findOne({ code: 'ANNUAL', deletedAt: null });
    nopay = await M.LeaveType.findOne({ code: 'NOPAY', deletedAt: null });
    assert.ok(annual && nopay, 'run npm run migrate first');
});

after(async () => {
    await M.PayrollSetting.updateOne({ scope: 'global', scopeRef: null }, { $set: { values: savedSettings } });
    await cleanup();
    for (const h of createdHolidays) await M.Holiday.deleteOne({ _id: h });
    await mongoose.disconnect();
});

const preview = (body) => call('POST', '/leave-requests/preview', { token: admin, body: { employee: String(emp._id), ...body } });
const request = (body) => call('POST', '/leave-requests', { token: admin, body: { employee: String(emp._id), reason: 'test', ...body } });

test('leave preview: paid within the balance, monthly count, no-pay over the monthly limit', async () => {
    await setSettings({ monthlyPaidLeaveLimit: 2, excessLeaveAsNoPay: true, allowLeaveBeyondBalance: false });
    const p1 = await preview({ leaveType: String(annual._id), fromDate: '2027-03-01', toDate: '2027-03-02' });
    assert.equal(p1.status, 200, p1.message);
    assert.equal(p1.data.days, 2);
    assert.equal(p1.data.paidDays, 2);
    assert.equal(p1.data.noPay, false);
    assert.equal(p1.data.months[0].before.total, 0);

    const r1 = await request({ leaveType: String(annual._id), fromDate: '2027-03-01', toDate: '2027-03-02' });
    assert.equal(r1.status, 201, r1.message);
    assert.equal(r1.data.paidDays, 2);

    // The month already has 2 paid days, so the next 2 are no-pay under a limit of 2 per month.
    const p2 = await preview({ leaveType: String(annual._id), fromDate: '2027-03-03', toDate: '2027-03-04' });
    assert.equal(p2.data.months[0].before.paid, 2, 'month count includes the pending request');
    assert.equal(p2.data.noPayDays, 2);
    assert.deepEqual(p2.data.noPayDates, ['2027-03-03', '2027-03-04']);
    assert.match(p2.data.noPayReason, /more than 2 paid leave/);
    assert.equal(p2.data.months[0].after.total, 4);

    const r2 = await request({ leaveType: String(annual._id), fromDate: '2027-03-03', toDate: '2027-03-04' });
    assert.equal(r2.status, 201, r2.message);
    assert.equal(r2.data.noPayDays, 2);
    let bal = await M.LeaveBalance.findOne({ employee: emp._id, leaveType: annual._id, year: 2027 }).lean();
    assert.equal(bal.pending, 2, 'no-pay days are not taken from the balance');

    for (const id of [r1.data.id, r2.data.id]) {
        const ok = await call('PATCH', `/leave-requests/${id}/approve`, { token: admin, body: { note: 'ok' } });
        assert.equal(ok.status, 200, ok.message);
    }
    bal = await M.LeaveBalance.findOne({ employee: emp._id, leaveType: annual._id, year: 2027 }).lean();
    assert.equal(bal.used, 2);
    assert.equal(bal.pending, 0);
    const paidDay = await M.Attendance.findOne({ employee: emp._id, date: '2027-03-01' }).lean();
    const unpaidDay = await M.Attendance.findOne({ employee: emp._id, date: '2027-03-03' }).lean();
    assert.equal(paidDay.leavePaid, true);
    assert.equal(unpaidDay.leavePaid, false, 'payroll sees the day as no-pay');

    const list = await call('GET', `/leave-requests?employee=${emp._id}&limit=50`, { token: admin });
    const row = list.data.find(r => r.id === r2.data.id);
    assert.deepEqual([row.monthLeave.month, row.monthLeave.paid, row.monthLeave.noPay, row.monthLeave.total], ['2027-03', 2, 2, 4]);

    // Cancelling the no-pay request leaves the balance alone.
    const c = await call('PATCH', `/leave-requests/${r2.data.id}/cancel`, { token: admin, body: {} });
    assert.equal(c.status, 200, c.message);
    bal = await M.LeaveBalance.findOne({ employee: emp._id, leaveType: annual._id, year: 2027 }).lean();
    assert.equal(bal.used, 2);
});

test('leave beyond the balance: no-pay by default, refused when the setting is off', async () => {
    await setSettings({ monthlyPaidLeaveLimit: 0, excessLeaveAsNoPay: true });
    await M.LeaveBalance.updateOne({ employee: emp._id, leaveType: annual._id, year: 2027 }, { $set: { adjusted: -11 } }); // 14 - 2 used - 11 = 1 left
    const p = await preview({ leaveType: String(annual._id), fromDate: '2027-04-05', toDate: '2027-04-06' });
    assert.equal(p.data.balance.remaining, 1);
    assert.equal(p.data.paidDays, 1);
    assert.deepEqual(p.data.noPayDates, ['2027-04-06']);
    assert.match(p.data.noPayReason, /only 1 day/);

    await setSettings({ excessLeaveAsNoPay: false });
    const refused = await request({ leaveType: String(annual._id), fromDate: '2027-04-05', toDate: '2027-04-06' });
    assert.equal(refused.status, 422);
    assert.match(refused.message, /Not enough/);
    await setSettings({ excessLeaveAsNoPay: true });

    const unpaid = await preview({ leaveType: String(nopay._id), fromDate: '2027-04-07', toDate: '2027-04-07' });
    assert.equal(unpaid.data.noPayDays, 1);
    assert.match(unpaid.data.noPayReason, /unpaid/);
});

test('a holiday the factory does not close for is a normal working day', async () => {
    const closed = await M.Holiday.create({ date: '2027-06-01', name: 'GTEST closed', observed: true });
    const open = await M.Holiday.create({ date: '2027-06-02', name: 'GTEST working day', observed: false });
    createdHolidays = [closed._id, open._id];
    const p = await preview({ leaveType: String(nopay._id), fromDate: '2027-06-01', toDate: '2027-06-02' });
    assert.deepEqual(p.data.dates, ['2027-06-02'], 'only the observed holiday is skipped');
});

test('Sri Lanka holiday list and garment roles', async () => {
    const y2026 = holidayDocs([2026]);
    assert.equal(y2026.length, 26);
    assert.equal(y2026.filter(h => h.poya).length, 13, '2026 has 13 Poya days (Adhi Poson)');
    assert.ok(y2026.every(h => h.observed && h.categories.includes('public') && h.categories.includes('bank')));
    const mercantileOnly = holidayDocs([2026, 2027], { mercantileOnly: true });
    assert.ok(mercantileOnly.every(h => h.observed === h.categories.includes('mercantile')));
    assert.equal(new Set(SRI_LANKA_HOLIDAYS.map(([d, n]) => `${d}${n}`)).size, SRI_LANKA_HOLIDAYS.length, 'no duplicates');

    const first = await setupGarment({ years: [] });
    const again = await setupGarment({ years: [] });
    assert.deepEqual([again.designations, again.groups], [0, 0], 'safe to run twice');
    assert.ok(first.designations >= 0);
    for (const r of GARMENT_ROLES) {
        assert.ok(await M.Designation.exists({ code: r.code, deletedAt: null }), `${r.name} designation`);
        assert.ok(await M.EmployeeGroup.exists({ code: r.code, deletedAt: null }), `${r.name} group`);
    }
    // Holiday seeding leaves a date alone when it already has a holiday entered by hand.
    const range = { date: { $gte: '2027-01-01', $lte: '2027-12-31' } };
    const existing = new Set((await M.Holiday.find(range).select('_id').lean()).map(h => String(h._id)));
    const duruthu = { date: '2027-01-22', name: 'Duruthu Full Moon Poya Day', deletedAt: null };
    const before = await M.Holiday.countDocuments(duruthu);
    const manual = await M.Holiday.create({ date: '2027-01-22', name: 'GTEST Poya entered by hand' });
    createdHolidays.push(manual._id);
    await setupGarment({ years: [2027] });
    assert.equal(await M.Holiday.countDocuments(duruthu), before, 'no second holiday added on a date that already has one');
    assert.ok(await M.Holiday.exists({ date: '2027-12-25', deletedAt: null }), 'the rest of 2027 is loaded');
    // Remove only what this test added.
    const added = await M.Holiday.find(range).select('_id').lean();
    createdHolidays.push(...added.filter(h => !existing.has(String(h._id)) && String(h._id) !== String(manual._id)).map(h => h._id));
});

test('demo removal refuses while a real employee uses demo data', async () => {
    const group = await M.EmployeeGroup.findOne({ code: /^DEMO/ });
    if (!group) return; // no demo data in this database
    await M.Employee.updateOne({ _id: emp._id }, { group: group._id });
    const report = await demoReport();
    assert.ok(report.blockers.some(b => b.includes('GTEST-1')));
    await M.Employee.updateOne({ _id: emp._id }, { group: null });
    assert.equal((await demoReport()).blockers.length, 0);
});

test('production pace and hourly buckets', () => {
    const shift = { start: 8 * 60, end: 17 * 60 };
    assert.equal(paceFor({ achieved: 60, target: 120, nowMinutes: 12 * 60 + 30, ...shift }).status, 'ahead');
    assert.equal(paceFor({ achieved: 55, target: 120, nowMinutes: 12 * 60 + 30, ...shift }).status, 'on_track');
    assert.equal(paceFor({ achieved: 20, target: 120, nowMinutes: 12 * 60 + 30, ...shift }).status, 'behind');
    assert.equal(paceFor({ achieved: 130, target: 120, nowMinutes: 10 * 60, ...shift }).status, 'done');
    assert.equal(paceFor({ achieved: 0, target: 120, nowMinutes: 7 * 60, ...shift }).status, 'not_started');
    const buckets = hourlyBuckets([{ time: '08:15', quantity: 10 }, { time: '08:50', quantity: 5 }, { time: '18:30', quantity: 3 }], '08:00', '17:00');
    assert.equal(buckets[0].hour, '08:00');
    assert.equal(buckets[0].quantity, 15);
    assert.equal(buckets.at(-1).hour, '18:00', 'overtime hour shown');
    assert.equal(buckets.length, 10, '08:00–16:00 plus 18:00');
});

test('production: record pieces, day target, board and TV login permissions', async () => {
    await setSettings({ dailyProductionTarget: 120, productionItem: 'pants' });
    let board = await call('GET', `/production/board?date=${PROD_DAY}`, { token: admin });
    assert.equal(board.status, 200, board.message);
    assert.equal(board.data.target, 120);
    assert.equal(board.data.achieved, 0);

    for (const [time, quantity] of [['09:00', 30], ['11:00', 45], ['15:30', 50]]) {
        const r = await call('POST', '/production/logs', { token: admin, body: { date: PROD_DAY, time, quantity, item: 'Pants' } });
        assert.equal(r.status, 201, r.message);
    }
    const bad = await call('POST', '/production/logs', { token: admin, body: { date: PROD_DAY, quantity: 2.5 } });
    assert.equal(bad.status, 422);
    const future = await call('POST', '/production/logs', { token: admin, body: { date: '2099-01-01', quantity: 5 } });
    assert.equal(future.status, 422);

    board = await call('GET', `/production/board?date=${PROD_DAY}`, { token: admin });
    assert.equal(board.data.achieved, 125);
    assert.equal(board.data.percent, 104);
    assert.equal(board.data.pace.status, 'done');
    assert.equal(board.data.hourly.find(h => h.hour === '11:00').cumulative, 75);

    const t = await call('PUT', `/production/targets/${PROD_DAY}`, { token: admin, body: { target: 150, note: 'Rush order' } });
    assert.equal(t.status, 200, t.message);
    board = await call('GET', `/production/board?date=${PROD_DAY}`, { token: admin });
    assert.equal(board.data.target, 150);
    assert.equal(board.data.remaining, 25);
    assert.equal(board.data.pace.status, 'behind');

    const summary = await call('GET', `/production/summary?from=${PROD_DAY}&to=${PROD_DAY}`, { token: admin });
    assert.deepEqual([summary.data[0].achieved, summary.data[0].target, summary.data[0].met], [125, 150, false]);
    assert.equal((await call('DELETE', `/production/targets/${PROD_DAY}`, { token: admin })).status, 200);

    const role = await M.StaffRole.findOne({ code: 'PRODUCTION_BOARD', deletedAt: null });
    assert.ok(role, 'migration creates the TV role');
    const u = new User({ name: 'Factory TV', email: BOARD_EMAIL, role: 'staff', staffRole: role._id });
    await u.setPassword('Tv-board-pass1!');
    await u.save();
    const login = await call('POST', '/auth/login', { body: { email: BOARD_EMAIL, password: 'Tv-board-pass1!' } });
    assert.equal(login.status, 200, login.message);
    boardToken = login.data.token;
    assert.equal((await call('GET', `/production/board?date=${PROD_DAY}`, { token: boardToken })).status, 200);
    assert.equal((await call('POST', '/production/logs', { token: boardToken, body: { date: PROD_DAY, quantity: 5 } })).status, 403);
    assert.equal((await call('GET', '/employees', { token: boardToken })).status, 403);
});
