/* eslint-disable no-console, no-await-in-loop */
/**
 * Adds shop staff from a JSON file (kept in private_files/, which is gitignored) and sets up the
 * salary rules used in the shop's Excel sheet:
 *
 *   daily rate   = basic ÷ 25            salary for days = daily rate × days worked
 *   hourly rate  = daily rate ÷ 8        OT = OT hours × hourly rate (1×)
 *   late         = late hours × hourly rate
 *   Sunday pay   = full Sundays × Sunday rate + extra Sunday hours × round(Sunday rate ÷ 8)
 *   salary       = days + OT + Sunday pay − late − advance (no EPF/ETF in the sheet)
 *
 * Safe to re-run: existing employees, revisions and setup records are left alone.
 *   node scripts/import-staff.js private_files/shop-staff-2026-09.json           # import
 *   node scripts/import-staff.js private_files/shop-staff-2026-09.json --check   # also compare with the sheet
 */
import fs from 'fs';
import { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import * as M from '../payroll/models/index.js';
import { evaluate } from '../payroll/services/formulaEngine.js';
import { round2 } from '../payroll/services/util.js';

const file = process.argv[2];
const check = process.argv.includes('--check');
if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/import-staff.js <staff.json> [--check]');
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const WORK_DAYS = 25;
const WORK_HOURS = 8;
const DEFAULT_SUNDAY_RATE = 1500;
const sundayFormula = (rate) => `floor(OTHours_WEEKEND / 8) * ${rate} + (OTHours_WEEKEND - floor(OTHours_WEEKEND / 8) * 8) * round(${rate} / 8)`;

const ensure = async (Model, query, doc, label) => {
    const found = await Model.findOne({ ...query, deletedAt: null });
    if (found) { console.log(`  = ${label} (exists)`); return found; }
    const created = await Model.create({ ...query, ...doc });
    console.log(`  + ${label}`);
    return created;
};

const run = async () => {
    assertConfig();
    await connectDB();

    const comps = new Map((await M.SalaryComponent.find({ deletedAt: null })).map(c => [c.code, c]));
    for (const code of ['BASIC', 'OT', 'LATE', 'ADVANCE', 'LOAN']) {
        if (!comps.has(code)) throw new Error(`Component ${code} is missing; run "npm run migrate" first`);
    }

    console.log('• Setup');
    const company = await M.OrgUnit.findOne({ type: 'company', code: { $ne: 'DEMO' }, deletedAt: null })
        || await ensure(M.OrgUnit, { type: 'company', code: 'CSTYLE' }, { name: 'CStyle' }, 'company CStyle');
    const sunday = await ensure(M.SalaryComponent, { code: 'SUNDAY_PAY' }, {
        name: 'Sunday Pay', type: 'earning', category: 'overtime', calculationType: 'formula', formula: sundayFormula(DEFAULT_SUNDAY_RATE),
        taxable: true, includeInGross: true, includeInNet: true, displayOrder: 21,
        description: 'Full Sundays (8 h) × Sunday rate, plus extra Sunday hours × Sunday rate ÷ 8 (rounded). Change the rate per employee on their salary.',
    }, 'component SUNDAY_PAY');
    comps.set('SUNDAY_PAY', sunday);
    const structure = await ensure(M.SalaryStructure, { code: 'SHOP_DAILY' }, {
        name: 'Shop Staff (25-day rate)', payBasis: 'daily',
        description: 'Basic ÷ 25 × days worked, OT at the hourly rate (basic ÷ 25 ÷ 8), Sunday pay, late deduction, advances. No EPF/ETF.',
        lines: [
            { component: comps.get('BASIC')._id, formula: 'round(DailyRate * PresentDays, 2)' },
            { component: comps.get('OT')._id, formula: 'OTAmount_NORMAL' },
            { component: sunday._id },
            { component: comps.get('LATE')._id },
            { component: comps.get('ADVANCE')._id },
            { component: comps.get('LOAN')._id },
        ],
    }, 'structure SHOP_DAILY');
    const group = await ensure(M.EmployeeGroup, { code: 'SHOP_STAFF' }, {
        name: 'Shop Staff', defaultSalaryStructure: structure._id,
        settings: { workingDaysPerMonth: WORK_DAYS, workingHoursPerDay: WORK_HOURS, weeklyOffDays: [0] },
    }, 'group Shop Staff');
    for (const h of data.holidays || []) await ensure(M.Holiday, { date: h.date }, { name: h.name, type: 'public' }, `holiday ${h.date} ${h.name}`);

    console.log('• Employees');
    for (const s of data.staff) {
        let emp = await M.Employee.findOne({ employeeCode: s.code, deletedAt: null });
        if (emp) console.log(`  = ${s.code} ${emp.fullName} (exists)`);
        else {
            emp = await M.Employee.create({
                employeeCode: s.code, fullName: s.name, joiningDate: new Date(`${s.joined}T00:00:00Z`), company: company._id, group: group._id,
                paymentMethod: 'cash', attendanceRequired: !s.fixed,
                statutory: { epfApplicable: false, etfApplicable: false },
                notes: `Imported from ${data.source}.${s.checkJoined ? ' Joining date was hard to read on the sheet; please confirm.' : ''}`,
            });
            console.log(`  + ${s.code} ${s.name}`);
        }
        if (await M.EmployeeSalary.exists({ employee: emp._id, status: { $ne: 'cancelled' } })) continue;
        const hourly = round2(s.basic / WORK_DAYS / WORK_HOURS);
        const overrides = [];
        if (s.fixed) overrides.push({ component: comps.get('BASIC')._id, formula: 'BasicSalary' });
        if (s.sundayRate !== DEFAULT_SUNDAY_RATE) overrides.push({ component: sunday._id, formula: sundayFormula(s.sundayRate) });
        await M.EmployeeSalary.create({
            employee: emp._id, structure: structure._id, effectiveFrom: data.effectiveFrom, basicSalary: s.basic, otRate: hourly,
            overrides, reason: `Rates from ${data.source}`,
        });
        console.log(`    salary ${s.basic} · OT ${hourly}/h · Sunday ${s.sundayRate}/day${s.fixed ? ' · fixed monthly' : ''}`);
    }

    if (check) {
        console.log('\n• Check against the sheet (same formulas, sheet totals as inputs)');
        const lines = (await M.SalaryStructure.findById(structure._id).populate('lines.component').lean()).lines;
        let total = 0;
        let sheetTotal = 0;
        let mismatches = 0;
        for (const s of data.staff) {
            const daily = round2(s.basic / WORK_DAYS);
            const hourly = round2(daily / WORK_HOURS);
            const x = s.sheet;
            const vars = {
                BasicSalary: s.basic, DailyRate: daily, HourlyRate: hourly, PresentDays: x.days, LateMinutes: x.late * 60,
                OTAmount_NORMAL: round2(x.ot * hourly), OTHours_WEEKEND: x.sundayDays * 8 + x.sundayHours,
                AdvanceDeduction: x.advance, LoanDeduction: 0,
            };
            const formulaFor = (line) => {
                if (line.component.code === 'BASIC' && s.fixed) return 'BasicSalary';
                if (line.component.code === 'SUNDAY_PAY') return sundayFormula(s.sundayRate);
                return line.formula || line.component.formula;
            };
            let net = 0;
            for (const line of lines) {
                const v = round2(evaluate(formulaFor(line), vars).value);
                net += line.component.type === 'earning' ? v : -v;
            }
            net = round2(net);
            total += net;
            sheetTotal += x.salary;
            const ok = Math.abs(net - x.salary) < 0.01;
            if (!ok) mismatches += 1;
            console.log(`  ${ok ? '✓' : '✗'} ${s.code} ${s.name.padEnd(22)} system ${String(net).padStart(9)}  sheet ${String(x.salary).padStart(9)}`);
        }
        console.log(`  Total: system ${round2(total)}  sheet ${round2(sheetTotal)}  ${mismatches ? `${mismatches} mismatch(es)` : 'all match'}`);
    }
    await disconnectDB();
};

run().catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
