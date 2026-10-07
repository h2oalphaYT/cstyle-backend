/* eslint-disable no-console, no-await-in-loop */
/**
 * Garment factory setup. Adds what does not exist yet and never changes or deletes existing records:
 *   - job roles as designations and employee groups (CEO, Factory Manager, Supervisor, Quality Checker,
 *     Cutter, Machine Operator, Ironer / Packer, Helper), editable afterwards in the admin panel
 *   - Sri Lanka public, bank and mercantile holidays (incl. Poya days) for this year and next, marked
 *     "factory closed" (paid holiday; work on the day is holiday OT). Untick it per day on the Holidays page.
 *     A date that already has a holiday (e.g. one entered by hand) is left as it is.
 *
 *   npm run setup:garment                       # run after `npm run migrate`
 *   npm run setup:garment -- --mercantile-only  # close only on mercantile holidays; Poya etc. stay working days
 *   npm run setup:garment -- --dry-run          # only list what would be added
 */
import { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import * as M from '../payroll/models/index.js';
import { holidayDocs } from '../payroll/data/sriLankaHolidays.js';
import { today } from '../payroll/services/util.js';

export const GARMENT_ROLES = [
    { code: 'GM-CEO', name: 'CEO', grade: 'M1', description: 'Owner / chief executive' },
    { code: 'GM-FM', name: 'Factory Manager', grade: 'M2', description: 'Runs the factory floor, planning and targets' },
    { code: 'GM-SUP', name: 'Supervisor', grade: 'S1', description: 'Leads a line, records output, first leave approval' },
    { code: 'GM-QC', name: 'Quality Checker', grade: 'S2', description: 'Checks finished pieces before packing' },
    { code: 'GM-CUT', name: 'Cutter', grade: 'W1', description: 'Marks and cuts fabric' },
    { code: 'GM-MO', name: 'Machine Operator', grade: 'W1', description: 'Sewing machine operator' },
    { code: 'GM-IRP', name: 'Ironer / Packer', grade: 'W2', description: 'Pressing, folding, tagging and packing' },
    { code: 'GM-HLP', name: 'Helper', grade: 'W3', description: 'Trimming, bundling and line support' },
];

const ensure = async (Model, filter, doc, label, dryRun) => {
    const existing = await Model.findOne({ ...filter, deletedAt: null });
    if (existing) return { doc: existing, created: false };
    if (dryRun) { console.log(`  + ${label} (dry run)`); return { doc: null, created: true }; }
    const created = await Model.create({ ...filter, ...doc });
    console.log(`  + ${label}`);
    return { doc: created, created: true };
};

export const setupGarment = async ({ dryRun = false, mercantileOnly = false, years = null } = {}) => {
    const year = Number(today().slice(0, 4));
    const counts = { designations: 0, groups: 0, holidays: 0 };

    console.log('• Job roles (designations)');
    for (const r of GARMENT_ROLES) {
        const { created } = await ensure(M.Designation, { code: r.code }, { name: r.name, grade: r.grade, description: r.description }, `designation ${r.name}`, dryRun);
        if (created) counts.designations += 1;
    }

    console.log('• Employee groups (pay rules per role)');
    const structure = await M.SalaryStructure.findOne({ code: 'MONTHLY_OFFICE', deletedAt: null }).lean();
    for (const r of GARMENT_ROLES) {
        const { created } = await ensure(M.EmployeeGroup, { code: r.code }, {
            name: r.name, description: r.description, payFrequency: 'monthly', defaultSalaryStructure: structure?._id || null,
        }, `group ${r.name}`, dryRun);
        if (created) counts.groups += 1;
    }

    console.log('• Sri Lanka holidays');
    const docs = holidayDocs(years || [year, year + 1], { mercantileOnly });
    for (const h of docs) {
        // Skip dates that already have a holiday entered some other way (e.g. "Poya" added by hand).
        const sameDay = await M.Holiday.find({ date: h.date, deletedAt: null }).select('name').lean();
        const ours = new Set(docs.filter(d => d.date === h.date).map(d => d.name));
        if (sameDay.some(d => !ours.has(d.name))) { console.log(`  = ${h.date} already has "${sameDay[0].name}"`); continue; }
        const { created } = await ensure(M.Holiday, { date: h.date, name: h.name }, h, `${h.date} ${h.name}${h.observed ? ' (closed)' : ' (working day)'}`, dryRun);
        if (created) counts.holidays += 1;
    }
    return counts;
};

const main = async () => {
    assertConfig();
    await connectDB();
    const dryRun = process.argv.includes('--dry-run');
    console.log(`▶ Garment setup${dryRun ? ' (dry run, nothing is saved)' : ''}`);
    const c = await setupGarment({ dryRun, mercantileOnly: process.argv.includes('--mercantile-only') });
    console.log(`✅ ${dryRun ? 'Would add' : 'Added'} ${c.designations} designation(s), ${c.groups} group(s), ${c.holidays} holiday(s).`);
};

if (process.argv[1] && process.argv[1].endsWith('setup-garment.js')) {
    main().catch((err) => { console.error('❌ Garment setup failed:', err); process.exitCode = 1; }).finally(() => disconnectDB());
}
