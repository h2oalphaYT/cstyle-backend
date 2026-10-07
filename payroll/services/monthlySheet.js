import ExcelJS from 'exceljs';
import ApiError from '../../utils/ApiError.js';
import { Advance, Attendance, Employee, Holiday, ImportBatch, Installment, OBSERVED, OvertimeEntry, OvertimeType } from '../models/index.js';
import { upsertAttendance } from './attendanceService.js';
import { assertEmployeePeriodOpen, audit, eachDay, periodBounds, round2, weekday } from './util.js';

/**
 * Import of the shop's monthly salary sheet: one row per employee with day columns 1–31
 * (1 = full day, 0.5 = half day, 0 = absent, "1a" = worked a Sunday) and monthly totals for
 * OT hours, late hours, Sundays worked, extra Sunday hours and advance.
 *
 * Weekday marks become attendance records. Monthly totals become one approved overtime entry,
 * one Sunday overtime entry, late minutes on the last day worked and an advance recovered this month.
 */

const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const text = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
        if (v.result != null) return text(v.result);
        if (v.text) return String(v.text).trim();
        if (v.richText) return v.richText.map(t => t.text).join('').trim();
        if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v).trim();
};
const num = (v) => {
    const t = text(v).replace(/,/g, '');
    if (t === '') return 0;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
};
const MARK_RE = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;

/** Finds the header row (the one with a NAME column) and maps the columns we need. */
const mapColumns = (ws) => {
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r += 1) {
        const headers = [];
        ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = text(cell.value); });
        const nameCol = headers.findIndex(h => norm(h) === 'NAME');
        if (nameCol < 0) continue;
        const find = (pred, from = 0) => headers.findIndex((h, i) => i >= from && h != null && pred(norm(h)));
        const days = {};
        headers.forEach((h, col) => {
            const n = Number(norm(h));
            if (h != null && /^\d{1,2}$/.test(norm(h)) && n >= 1 && n <= 31 && col > nameCol) days[n] = col;
        });
        const lastDayCol = Math.max(0, ...Object.values(days));
        const sundayCols = headers.map((h, i) => (h != null && /^SUNDA?YI+$/.test(norm(h)) ? i : -1)).filter(i => i > 0);
        const codeCol = norm(headers[nameCol - 1]) === 'NO' || /CODE|EMPNO/.test(norm(headers[nameCol - 1])) ? nameCol - 1 : find(h => /^(EMPLOYEECODE|CODE|EMPNO|EPFNO)$/.test(h));
        return {
            headerRow: r,
            nameCol,
            codeCol,
            days,
            daysTotalCol: lastDayCol ? lastDayCol + 1 : -1,
            workingDayCol: find(h => h === 'WORKINGDAY' || h === 'WORKINGDAYS'),
            otCol: find(h => h === 'OT' || h === 'OTHOURS'),
            lateCol: find(h => h.startsWith('LATE')),
            sundaysCol: find(h => h === 'SUNDAYS'),
            // "SUNDY II" holds extra Sunday hours; "SUNDAY II" is the amount. Fall back to the second such column.
            sundayHoursCol: find(h => h === 'SUNDYII') > 0 ? find(h => h === 'SUNDYII') : (sundayCols[1] ?? -1),
            advanceCol: find(h => h === 'ADVANCE'),
            salaryCol: find(h => h === 'SALARY' || h === 'NETSALARY'),
            extraCol: find(h => h === 'PRALV'),
        };
    }
    return null;
};

/** Reads the sheet and checks it against employees, holidays and the period. Nothing is saved yet. */
export const validateMonthlySheet = async (req, buffer, fileName, period) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) throw ApiError.unprocessable('Choose the month of the sheet, e.g. 2026-09');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch { throw ApiError.unprocessable('The file could not be read. Save it as .xlsx and try again.'); }
    const ws = wb.worksheets.find(w => mapColumns(w)) || null;
    const map = ws && mapColumns(ws);
    if (!map) throw ApiError.unprocessable('Could not find the header row (a row with a NAME column and day columns 1–31).');
    if (!Object.keys(map.days).length) throw ApiError.unprocessable('No day columns (1–31) were found next to NAME.');

    const { start, end } = periodBounds(period);
    const dates = new Set(eachDay(start, end));
    const holidays = new Set((await Holiday.find({ date: { $gte: start, $lte: end }, deletedAt: null, ...OBSERVED }).lean()).map(h => h.date));
    const employees = await Employee.find({ deletedAt: null }).populate('group', 'settings').lean();
    const byCode = new Map(employees.map(e => [e.employeeCode, e]));
    const byName = new Map(employees.map(e => [norm(e.fullName), e]));

    const rows = [];
    for (let r = map.headerRow + 1; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const name = text(row.getCell(map.nameCol).value);
        if (!name) continue;
        const problems = [];
        const warnings = [];
        let code = map.codeCol > 0 ? text(row.getCell(map.codeCol).value) : '';
        if (/^\d+$/.test(code) && code.length < 3) code = code.padStart(3, '0');
        const emp = (code && byCode.get(code.toUpperCase())) || byName.get(norm(name));
        if (!emp) problems.push(`No employee with code "${code}" or name "${name}". Add the employee first.`);
        else if (code && emp.employeeCode !== code.toUpperCase()) warnings.push(`Matched by name to ${emp.employeeCode}`);

        const offDays = emp?.group?.settings?.weeklyOffDays || [0];
        const marks = {};
        let workedDays = 0;
        let sundayMarks = 0;
        for (const [day, col] of Object.entries(map.days)) {
            const raw = text(row.getCell(col).value);
            if (raw === '') continue;
            const date = `${period}-${String(day).padStart(2, '0')}`;
            if (!dates.has(date)) { warnings.push(`Day ${day} is not in ${period}; ignored`); continue; }
            const m = raw.match(MARK_RE);
            if (!m || Number(m[1]) > 1) { problems.push(`Day ${day}: "${raw}" is not 1, 0.5 or 0`); continue; }
            const value = Number(m[1]);
            if (offDays.includes(weekday(date)) || holidays.has(date)) {
                if (value > 0) sundayMarks += value;
                continue; // paid through the Sunday columns
            }
            marks[date] = value;
            workedDays += value;
        }
        const cell = (col) => (col > 0 ? num(row.getCell(col).value) : 0);
        const totals = {
            sheetDays: cell(map.workingDayCol > 0 ? map.workingDayCol : map.daysTotalCol),
            ot: cell(map.otCol), late: cell(map.lateCol), sundayDays: cell(map.sundaysCol), sundayHours: cell(map.sundayHoursCol),
            advance: cell(map.advanceCol), sheetSalary: cell(map.salaryCol), extra: cell(map.extraCol),
        };
        for (const [k, v] of Object.entries(totals)) if (Number.isNaN(v)) problems.push(`${k} is not a number`);
        if (Object.values(totals).some(v => v < 0)) problems.push('Totals cannot be negative');
        const attendanceRequired = emp?.attendanceRequired !== false;
        if (attendanceRequired && Object.keys(marks).length && totals.sheetDays && Math.abs(workedDays - totals.sheetDays) > 0.001) {
            warnings.push(`Day marks add up to ${workedDays} but the sheet says ${totals.sheetDays} days`);
        }
        if (!attendanceRequired && Object.keys(marks).length) warnings.push('Fixed monthly salary: day marks are not used');
        if (sundayMarks && !totals.sundayDays && !totals.sundayHours) warnings.push('Worked on a Sunday/holiday but the Sunday columns are empty');
        if (totals.extra) warnings.push(`"pr.alv" ${totals.extra} is not imported; add it as an allowance if it should be paid`);
        if (emp) {
            try { await assertEmployeePeriodOpen(emp._id, period, 'Attendance'); } catch (err) { problems.push(err.message); }
        }
        rows.push({
            row: r, problems, warnings,
            data: {
                employee: emp?._id || null, employeeCode: emp?.employeeCode || code, name: emp?.fullName || name, attendanceRequired,
                marks, workedDays: round2(workedDays), sundayMarks, ...totals,
            },
        });
    }
    if (!rows.length) throw ApiError.unprocessable('The sheet has no employee rows');

    const batch = await ImportBatch.create({
        kind: 'monthly_sheet', period, fileName, overwrite: true, rows,
        totalRows: rows.length, validRows: rows.filter(r => !r.problems.length).length, errorRows: rows.filter(r => r.problems.length).length,
        createdBy: req.user?._id,
    });
    return batch;
};

const removeBatchExtras = async (batchIds, employeeIds) => {
    const q = { importBatch: { $in: batchIds }, employee: { $in: employeeIds } };
    await OvertimeEntry.updateMany({ ...q, deletedAt: null }, { deletedAt: new Date() });
    const advances = await Advance.find({ ...q, deletedAt: null }).select('_id').lean();
    const ids = advances.map(a => a._id);
    if (await Installment.exists({ source: { $in: ids }, status: 'deducted' })) {
        throw ApiError.conflict('An advance from this import was already recovered in a finalized payroll');
    }
    await Installment.updateMany({ source: { $in: ids }, status: 'scheduled' }, { status: 'cancelled' });
    await Advance.updateMany({ _id: { $in: ids } }, { status: 'cancelled', deletedAt: new Date() });
};

/** Writes the valid rows: attendance, overtime, Sunday overtime, late minutes and advances. */
export const commitMonthlySheet = async (req, batch) => {
    if (batch.kind !== 'monthly_sheet') throw ApiError.badRequest('Not a monthly sheet import');
    if (batch.status !== 'validated') throw ApiError.conflict(`This import is already ${batch.status}`);
    const period = batch.period;
    const { start, end } = periodBounds(period);
    const [normalOt, sundayOt] = await Promise.all([
        OvertimeType.findOne({ code: 'NORMAL', deletedAt: null }), OvertimeType.findOne({ code: 'WEEKEND', deletedAt: null }),
    ]);
    if (!normalOt || !sundayOt) throw ApiError.unprocessable('Overtime types NORMAL and WEEKEND are required (run the payroll migration)');
    const valid = batch.rows.filter(r => !r.problems.length);

    // Re-importing a month replaces what earlier imports of the same month created for these employees.
    const earlier = await ImportBatch.find({ kind: 'monthly_sheet', period, status: 'imported', _id: { $ne: batch._id } }).select('_id').lean();
    if (earlier.length) await removeBatchExtras(earlier.map(b => b._id), valid.map(r => r.data.employee));

    let imported = 0;
    const tag = `Monthly sheet ${batch.fileName}`;
    for (const r of valid) {
        const d = r.data;
        try {
            const dates = Object.keys(d.marks).sort();
            const worked = dates.filter(x => d.marks[x] > 0);
            const lastWorked = worked[worked.length - 1] || null;
            if (d.attendanceRequired) {
                for (const date of dates) {
                    const v = d.marks[date];
                    await upsertAttendance(req, {
                        employee: d.employee, date, status: v >= 1 ? 'present' : v > 0 ? 'half_day' : 'absent', otHours: 0,
                        lateMinutes: date === lastWorked && d.late ? round2(d.late * 60) : 0,
                        remarks: date === lastWorked && d.late ? `Late hours for the month from sheet: ${d.late} h` : '',
                        reason: tag, importBatch: batch._id,
                    }, { overwrite: true, source: 'excel' });
                }
            }
            const otDate = lastWorked || end;
            const approved = { status: 'approved', approvedBy: req.user._id, approvedAt: new Date(), source: 'excel', importBatch: batch._id, createdBy: req.user._id };
            if (d.ot > 0) {
                await OvertimeEntry.create({ employee: d.employee, date: otDate, overtimeType: normalOt._id, hours: d.ot, requestedHours: d.ot, remarks: `OT hours for the month (${tag})`, ...approved });
            }
            const sundayHours = round2(d.sundayDays * 8 + d.sundayHours);
            if (sundayHours > 0) {
                const sundays = eachDay(start, end).filter(x => weekday(x) === 0);
                await OvertimeEntry.create({
                    employee: d.employee, date: sundays[sundays.length - 1] || end, overtimeType: sundayOt._id, hours: sundayHours, requestedHours: sundayHours,
                    remarks: `Sunday work: ${d.sundayDays} full day(s) + ${d.sundayHours} h (${tag})`, ...approved,
                });
            }
            if (d.advance > 0) {
                const adv = await Advance.create({
                    kind: 'advance', employee: d.employee, reference: `SHEET-${period.replace('-', '')}`, amount: d.advance, totalPayable: d.advance,
                    installmentCount: 1, installmentAmount: d.advance, date: start, startPeriod: period, endPeriod: period, reason: tag,
                    status: 'active', approvedBy: req.user._id, approvedAt: new Date(), importBatch: batch._id, createdBy: req.user._id,
                });
                await Installment.create({ source: adv._id, kind: 'advance', employee: d.employee, sequence: 1, period, amount: d.advance });
            }
            imported += 1;
        } catch (err) {
            r.problems.push(err.message);
        }
    }
    batch.status = 'imported';
    batch.importedCount = imported;
    batch.importedAt = new Date();
    batch.errorRows = batch.rows.filter(r => r.problems.length).length;
    batch.markModified('rows');
    await batch.save();
    await audit(req, { action: 'import', entity: 'Attendance', record: batch, label: batch.fileName, note: `Monthly sheet ${period}: ${imported} employee(s)` });
    return { imported, failed: batch.rows.filter(r => r.problems.length).map(r => ({ row: r.row, employeeCode: r.data.employeeCode, errors: r.problems })) };
};

/** Undoes an imported monthly sheet while the month is still open. */
export const revertMonthlySheet = async (req, batch) => {
    if (batch.kind !== 'monthly_sheet' || batch.status !== 'imported') throw ApiError.conflict('Only an imported monthly sheet can be undone');
    const employees = batch.rows.map(r => r.data.employee).filter(Boolean);
    for (const e of employees) await assertEmployeePeriodOpen(e, batch.period, 'Attendance');
    await removeBatchExtras([batch._id], employees);
    const res = await Attendance.updateMany({ importBatch: batch._id, deletedAt: null }, { deletedAt: new Date(), updatedBy: req.user._id });
    batch.status = 'reverted';
    batch.revertedAt = new Date();
    await batch.save();
    await audit(req, { action: 'revert-import', entity: 'Attendance', record: batch, label: batch.fileName, note: `${res.modifiedCount} attendance record(s) removed` });
    return { removed: res.modifiedCount };
};
