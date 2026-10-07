/* eslint-disable no-console */
/**
 * Removes the payroll demo data created by `npm run payroll:demo` (employees DEMO-A … DEMO-E, the
 * "DEMO …" company, branches, departments, designations, groups, holiday, device, the January 2025
 * demo payroll and the @demo.cstyle.lk staff logins).
 *
 * Nothing else is touched: real employees, admin users, products and orders stay. It refuses to run
 * if a real employee or payroll still points at a demo record, and lists what to fix first.
 *
 *   npm run payroll:remove-demo           # shows what would be removed
 *   npm run payroll:remove-demo -- --yes  # removes it
 */
import { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import User from '../models/User.js';
import * as M from '../payroll/models/index.js';
import { removeDemo } from './seed-payroll-demo.js';

const ORG_FIELDS = ['company', 'branch', 'hub', 'location', 'department', 'costCenter', 'project'];

/** What the demo removal would delete, and anything real that still depends on it. */
export const demoReport = async () => {
    const employees = await M.Employee.find({ employeeCode: /^DEMO-/ }).select('_id employeeCode').lean();
    const ids = employees.map(e => e._id);
    const [orgUnits, designations, groups, runs, users, holidays, devices] = await Promise.all([
        M.OrgUnit.find({ code: /^DEMO/ }).select('_id code').lean(),
        M.Designation.find({ code: /^DEMO/ }).select('_id').lean(),
        M.EmployeeGroup.find({ code: /^DEMO/ }).select('_id').lean(),
        M.PayrollRun.find({ name: /^DEMO/ }).select('_id').lean(),
        User.find({ email: /@demo\.cstyle\.lk$/ }).select('email role').lean(),
        M.Holiday.countDocuments({ name: /^DEMO/ }),
        M.BiometricDevice.countDocuments({ deviceCode: /^DEMO/ }),
    ]);
    const blockers = [];
    const real = { employeeCode: { $not: /^DEMO-/ }, deletedAt: null };
    const orgIds = orgUnits.map(o => o._id);
    const usingOrg = orgIds.length ? await M.Employee.find({ ...real, $or: ORG_FIELDS.map(f => ({ [f]: { $in: orgIds } })) }).select('employeeCode').lean() : [];
    const usingDesig = designations.length ? await M.Employee.find({ ...real, designation: { $in: designations.map(d => d._id) } }).select('employeeCode').lean() : [];
    const usingGroup = groups.length ? await M.Employee.find({ ...real, group: { $in: groups.map(g => g._id) } }).select('employeeCode').lean() : [];
    const managed = ids.length ? await M.Employee.find({ ...real, manager: { $in: ids } }).select('employeeCode').lean() : [];
    if (usingOrg.length) blockers.push(`Employees in a DEMO company/branch/department: ${usingOrg.map(e => e.employeeCode).join(', ')}`);
    if (usingDesig.length) blockers.push(`Employees with a DEMO designation: ${usingDesig.map(e => e.employeeCode).join(', ')}`);
    if (usingGroup.length) blockers.push(`Employees in a DEMO group: ${usingGroup.map(e => e.employeeCode).join(', ')}`);
    if (managed.length) blockers.push(`Employees whose manager is a demo employee: ${managed.map(e => e.employeeCode).join(', ')}`);
    const mixedRuns = ids.length ? await M.PayrollRunEmployee.distinct('run', { employee: { $in: ids }, run: { $nin: runs.map(r => r._id) } }) : [];
    if (mixedRuns.length) blockers.push(`${mixedRuns.length} real payroll run(s) include demo employees; cancel those runs or remove the demo employees from them first`);
    const adminDemo = users.filter(u => u.role === 'admin');
    if (adminDemo.length) blockers.push(`Admin accounts with a demo email: ${adminDemo.map(u => u.email).join(', ')}`);
    return {
        counts: {
            employees: employees.length, orgUnits: orgUnits.length, designations: designations.length, groups: groups.length,
            payrollRuns: runs.length, staffLogins: users.length, holidays, devices,
        },
        blockers,
    };
};

const main = async () => {
    assertConfig();
    await connectDB();
    const { counts, blockers } = await demoReport();
    console.log('Demo payroll data found:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
    if (!Object.values(counts).some(Boolean)) { console.log('✅ Nothing to remove.'); return; }
    if (blockers.length) {
        console.log('\n❌ Not removed. Fix these first so no real record is left pointing at deleted demo data:');
        for (const b of blockers) console.log(`  - ${b}`);
        process.exitCode = 1;
        return;
    }
    if (!process.argv.includes('--yes')) {
        console.log('\nNothing was deleted. Run again with --yes to remove the demo data:  npm run payroll:remove-demo -- --yes');
        return;
    }
    await removeDemo();
    console.log('✅ Demo payroll data removed. Real employees, users, products and orders were not touched.');
};

if (process.argv[1] && process.argv[1].endsWith('remove-payroll-demo.js')) {
    main().catch((err) => { console.error('❌ Removing demo data failed:', err); process.exitCode = 1; }).finally(() => disconnectDB());
}
