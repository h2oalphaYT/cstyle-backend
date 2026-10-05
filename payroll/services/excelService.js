import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Attendance, Employee, ImportBatch } from '../models/index.js';
import { isValidDay, localTime, TIME_RE } from './util.js';
import { ATTENDANCE_STATUSES } from '../models/attendance.js';

export const ATTENDANCE_COLUMNS = ['Employee Code', 'Employee Name', 'Date', 'In Time', 'Out Time', 'Status', 'OT Hours', 'Remarks'];

const styleHeader = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
};

export const attendanceTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');
    ws.columns = ATTENDANCE_COLUMNS.map(h => ({ header: h, key: h, width: h === 'Remarks' ? 30 : 16 }));
    styleHeader(ws.getRow(1));
    ws.addRow(['EMP001', 'Sample Employee', '2026-10-01', '08:25', '17:10', 'present', 0, 'Delete this sample row']);
    const help = wb.addWorksheet('Instructions');
    [
        ['Column', 'Format / allowed values'],
        ['Employee Code', 'Required. Must match an employee code in the system.'],
        ['Employee Name', 'Optional, used to double-check the code.'],
        ['Date', 'Required. YYYY-MM-DD (or an Excel date cell).'],
        ['In Time / Out Time', 'HH:MM, 24-hour (e.g. 08:30, 17:15). Leave empty for absent / leave days.'],
        ['Status', `Optional. ${ATTENDANCE_STATUSES.join(', ')}. Empty = derived from the times.`],
        ['OT Hours', 'Optional. Overrides automatic overtime for the day.'],
        ['Remarks', 'Optional.'],
    ].forEach((r, i) => { const row = help.addRow(r); if (i === 0) styleHeader(row); });
    help.getColumn(1).width = 22;
    help.getColumn(2).width = 90;
    return wb.xlsx.writeBuffer();
};

const cellText = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
        if (v.text) return String(v.text).trim();
        if (v.result != null) return cellText(v.result);
        if (v.richText) return v.richText.map(t => t.text).join('').trim();
    }
    return String(v).trim();
};

const normDate = (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v || '').trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
        const [y, m, d] = s.split('-');
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    if (/^\d+(\.\d+)?$/.test(s)) { // Excel serial
        const d = new Date(Math.round((Number(s) - 25569) * 86400000));
        return d.toISOString().slice(0, 10);
    }
    return s;
};

const normTime = (v) => {
    if (v instanceof Date) return v.toISOString().slice(11, 16); // ExcelJS times are UTC-based day fractions
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
        const [h, m] = s.split(':');
        return `${h.padStart(2, '0')}:${m}`;
    }
    if (/^0?\.\d+$/.test(s)) { // day fraction
        const mins = Math.round(Number(s) * 1440);
        return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    }
    return s;
};

/** Reads an .xlsx or .csv buffer into plain row objects keyed by the template headers. */
export const readSheet = async (buffer, fileName) => {
    const wb = new ExcelJS.Workbook();
    if (/\.csv$/i.test(fileName)) {
        const { Readable } = await import('stream');
        await wb.csv.read(Readable.from(buffer));
    } else {
        await wb.xlsx.load(buffer);
    }
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers = [];
    ws.getRow(1).eachCell((cell, col) => { headers[col] = String(cellText(cell.value)).trim(); });
    const rows = [];
    ws.eachRow((row, n) => {
        if (n === 1) return;
        const obj = { __row: n };
        let any = false;
        headers.forEach((h, col) => {
            if (!h) return;
            const v = cellText(row.getCell(col).value);
            if (v !== '') any = true;
            obj[h] = v;
        });
        if (any) rows.push(obj);
    });
    return rows;
};

/**
 * Validates attendance rows and stores them in an ImportBatch for preview. Nothing is written to
 * attendance until the batch is confirmed.
 */
export const validateAttendanceImport = async (req, rows, fileName, { overwrite = false } = {}) => {
    if (rows.length > 20000) throw new Error('A single import is limited to 20,000 rows');
    const codes = [...new Set(rows.map(r => String(r['Employee Code'] || '').toUpperCase()).filter(Boolean))];
    const employees = await Employee.find({ employeeCode: { $in: codes }, deletedAt: null }).select('employeeCode fullName').lean();
    const byCode = new Map(employees.map(e => [e.employeeCode, e]));
    const seen = new Set();

    const keys = [];
    const out = rows.map((r) => {
        const problems = [];
        const warnings = [];
        const code = String(r['Employee Code'] || '').toUpperCase();
        const emp = byCode.get(code);
        const date = normDate(r.Date);
        const inTime = normTime(r['In Time']);
        const outTime = normTime(r['Out Time']);
        const status = String(r.Status || '').toLowerCase().replace(/\s+/g, '_');
        const ot = r['OT Hours'] === '' || r['OT Hours'] == null ? null : Number(r['OT Hours']);

        if (!code) problems.push('Employee code is missing');
        else if (!/^[A-Z0-9_-]+$/.test(code)) problems.push(`Invalid employee code "${code}"`);
        else if (!emp) problems.push(`Unknown employee "${code}"`);
        if (emp && r['Employee Name'] && emp.fullName.toLowerCase() !== String(r['Employee Name']).toLowerCase()) {
            warnings.push(`Name in sheet "${r['Employee Name']}" differs from "${emp.fullName}"`);
        }
        if (!isValidDay(date)) problems.push(`Invalid date "${r.Date}"`);
        if (inTime && !TIME_RE.test(inTime)) problems.push(`Invalid in time "${r['In Time']}"`);
        if (outTime && !TIME_RE.test(outTime)) problems.push(`Invalid out time "${r['Out Time']}"`);
        if (inTime && outTime && TIME_RE.test(inTime) && TIME_RE.test(outTime) && outTime <= inTime) problems.push('Out time is not after in time');
        if (outTime && !inTime) problems.push('Out time without an in time');
        if (inTime && !outTime && !['half_day', 'present', ''].includes(status)) warnings.push('Missing check-out');
        else if (inTime && !outTime) warnings.push('Missing check-out');
        if (status && !ATTENDANCE_STATUSES.includes(status)) problems.push(`Unknown status "${r.Status}"`);
        if (!inTime && !status) problems.push('Give in/out times or a status');
        if (ot != null && (!Number.isFinite(ot) || ot < 0 || ot > 16)) problems.push(`Invalid OT hours "${r['OT Hours']}"`);

        const key = `${code}|${date}`;
        if (seen.has(key)) problems.push('Duplicate row for this employee and date in the file');
        seen.add(key);
        if (emp && isValidDay(date)) keys.push({ employee: emp._id, date, key, row: r.__row });

        return {
            row: r.__row,
            data: { employeeCode: code, employeeName: emp?.fullName || r['Employee Name'] || '', employee: emp?._id || null, date, inTime, outTime, status, otHours: ot, remarks: r.Remarks || '' },
            problems,
            warnings,
        };
    });

    // Existing attendance for these employee/days.
    if (keys.length) {
        const existing = await Attendance.find({ deletedAt: null, $or: keys.map(k => ({ employee: k.employee, date: k.date })) }).select('employee date source').lean();
        const existingKeys = new Set(existing.map(e => `${String(e.employee)}|${e.date}`));
        for (const row of out) {
            if (row.data.employee && existingKeys.has(`${String(row.data.employee)}|${row.data.date}`)) {
                if (overwrite) row.warnings.push('Existing attendance will be replaced');
                else row.problems.push('Attendance already exists for this day (tick "replace existing" to overwrite)');
            }
        }
    }

    const batch = await ImportBatch.create({
        kind: 'attendance', fileName, overwrite,
        totalRows: out.length,
        validRows: out.filter(r => !r.problems.length).length,
        errorRows: out.filter(r => r.problems.length).length,
        rows: out,
        createdBy: req.user._id,
    });
    return batch;
};

// ── Generic exports ─────────────────────────────────────────────────
const cellValue = (v) => (v instanceof Date ? v : v == null ? '' : v);

/** columns: [{ key, header, width?, type? ('money'|'number'|'date') }] */
export const toXlsx = async (title, columns, rows, { summary = [] } = {}) => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CStyle Payroll';
    const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || Math.max(12, c.header.length + 2) }));
    styleHeader(ws.getRow(1));
    rows.forEach(r => ws.addRow(Object.fromEntries(columns.map(c => [c.key, cellValue(r[c.key])]))));
    columns.forEach((c, i) => {
        if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00';
    });
    if (summary.length) {
        ws.addRow([]);
        summary.forEach(([label, value]) => { const row = ws.addRow([label, value]); row.font = { bold: true }; });
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return wb.xlsx.writeBuffer();
};

export const toCsv = (columns, rows) => {
    const esc = (v) => {
        const s = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v);
        // Neutralise spreadsheet formula injection.
        const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return [columns.map(c => esc(c.header)).join(','), ...rows.map(r => columns.map(c => esc(r[c.key])).join(','))].join('\n');
};

export const toPdfTable = (title, subtitle, columns, rows, { summary = [] } = {}) => new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: columns.length > 7 ? 'landscape' : 'portrait', margin: 32 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const width = doc.page.width - 64;
    const colW = width / columns.length;
    doc.fontSize(14).font('Helvetica-Bold').text(title);
    doc.fontSize(8).font('Helvetica').fillColor('#555').text(subtitle || '').moveDown(0.6).fillColor('#000');
    const header = () => {
        const y = doc.y;
        doc.rect(32, y - 2, width, 14).fill('#1F2937').fillColor('#fff').font('Helvetica-Bold').fontSize(7);
        columns.forEach((c, i) => doc.text(c.header, 34 + i * colW, y + 1, { width: colW - 4, align: c.type === 'money' || c.type === 'number' ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        doc.fillColor('#000').font('Helvetica').moveDown(0.4);
        doc.y = y + 16;
    };
    header();
    const fmt = (c, v) => {
        if (v == null || v === '') return '';
        if (c.type === 'money') return Number(v).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v);
    };
    rows.forEach((r, idx) => {
        if (doc.y > doc.page.height - 50) { doc.addPage(); header(); }
        const y = doc.y;
        if (idx % 2) doc.rect(32, y - 2, width, 12).fill('#F3F4F6').fillColor('#000');
        doc.fontSize(7);
        columns.forEach((c, i) => doc.text(fmt(c, r[c.key]), 34 + i * colW, y, { width: colW - 4, align: c.type === 'money' || c.type === 'number' ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        doc.y = y + 12;
    });
    if (summary.length) {
        doc.moveDown();
        summary.forEach(([l, v]) => doc.font('Helvetica-Bold').fontSize(8).text(`${l}: ${typeof v === 'number' ? v.toLocaleString('en-LK', { minimumFractionDigits: 2 }) : v}`));
    }
    doc.fontSize(7).font('Helvetica').fillColor('#777').text(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, 32, doc.page.height - 30);
    doc.end();
});

export const sendExport = async (res, format, title, subtitle, columns, rows, opts = {}) => {
    const safe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
        return res.send(`﻿${toCsv(columns, rows)}`);
    }
    if (format === 'pdf') {
        const buf = await toPdfTable(title, subtitle, columns, rows, opts);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
        return res.send(buf);
    }
    const buf = await toXlsx(title, columns, rows, opts);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
    return res.send(Buffer.from(buf));
};

export { localTime };
