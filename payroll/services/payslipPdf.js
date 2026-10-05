import PDFDocument from 'pdfkit';

const money = (n) => Number(n || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/**
 * Draws one payslip page. lines: PayrollRunEmployee documents (lean), settings: payroll settings.
 * Several payslips can be written into one PDF (one per page) for a whole payroll run.
 */
const drawPayslip = (doc, line, { settings, period }) => {
    const s = line.snapshot || {};
    const left = 40;
    const width = doc.page.width - 80;
    const half = width / 2;

    doc.font('Helvetica-Bold').fontSize(16).text(settings.companyName || 'Company', left, 40);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(settings.companyAddress || '', left, doc.y);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text('PAYSLIP', left, 40, { width, align: 'right' });
    doc.font('Helvetica').fontSize(9).text(period.name, left, 56, { width, align: 'right' });
    doc.fontSize(8).text(line.payslipNumber ? `No. ${line.payslipNumber}` : 'DRAFT — not finalized', left, 68, { width, align: 'right' });
    doc.moveTo(left, 90).lineTo(left + width, 90).strokeColor('#D4AF37').lineWidth(1.5).stroke();

    // Employee block
    const info = [
        ['Employee', s.fullName], ['Employee ID', s.employeeCode],
        ['Department', s.department], ['Designation', s.designation],
        ['Branch / Hub', [s.branch, s.hub].filter(Boolean).join(' / ')], ['Employment', label(s.employmentType)],
        ['NIC', s.nic], ['EPF No.', s.epfNumber],
        ['Pay period', `${period.startDate} to ${period.endDate}`], ['Salary basis', label(s.payBasis)],
    ];
    let y = 100;
    doc.fontSize(8);
    info.forEach(([k, v], i) => {
        const x = left + (i % 2) * half;
        if (i % 2 === 0 && i) y += 13;
        doc.font('Helvetica').fillColor('#666').text(k, x, y, { width: 80 });
        doc.font('Helvetica-Bold').fillColor('#000').text(v || '—', x + 80, y, { width: half - 90 });
    });
    y += 24;

    // Earnings & deductions columns
    const visible = (line.items || []).filter(i => i.showOnPayslip !== false);
    const earnings = visible.filter(i => i.type === 'earning');
    const deductions = visible.filter(i => i.type === 'deduction');
    const employer = visible.filter(i => i.type === 'employer');
    const table = (title, items, x, total, totalLabel) => {
        let yy = y;
        doc.rect(x, yy, half - 10, 16).fill('#1F2937');
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8).text(title, x + 6, yy + 4).text('Amount (LKR)', x, yy + 4, { width: half - 16, align: 'right' });
        yy += 20;
        doc.fillColor('#000').font('Helvetica').fontSize(8);
        items.forEach((it) => {
            doc.text(it.name, x + 6, yy, { width: half - 110 });
            doc.text(money(it.amount), x, yy, { width: half - 16, align: 'right' });
            yy += 13;
        });
        doc.moveTo(x, yy).lineTo(x + half - 10, yy).strokeColor('#ccc').lineWidth(0.5).stroke();
        yy += 4;
        doc.font('Helvetica-Bold').text(totalLabel, x + 6, yy).text(money(total), x, yy, { width: half - 16, align: 'right' });
        return yy + 14;
    };
    const yE = table('EARNINGS', earnings, left, line.totalEarnings, 'Total earnings');
    const yD = table('DEDUCTIONS', deductions, left + half + 10, line.totalDeductions, 'Total deductions');
    y = Math.max(yE, yD) + 10;

    doc.rect(left, y, width, 30).fill('#F5F0E1');
    doc.fillColor('#000').font('Helvetica').fontSize(9).text(`Gross salary: ${money(line.gross)}`, left + 10, y + 10);
    doc.font('Helvetica-Bold').fontSize(13).text(`NET PAY  LKR ${money(line.net)}`, left, y + 8, { width: width - 10, align: 'right' });
    y += 42;

    if (employer.length) {
        doc.font('Helvetica-Bold').fontSize(8).text('Employer contributions (not deducted from pay)', left, y);
        y += 12;
        doc.font('Helvetica');
        employer.forEach(it => { doc.text(`${it.name}: ${money(it.amount)}`, left + 6, y); y += 11; });
        y += 6;
    }

    // Attendance / leave / payment summary
    const a = line.attendance || {};
    const v = line.variables || {};
    const rows = [
        ['Days present', v.PresentDays], ['Paid leave', v.PaidLeaveDays], ['No-pay days', v.NoPayDays], ['Holidays', v.HolidayDays],
        ['Worked hours', v.WorkedHours], ['Overtime hours', v.OTHours], ['Late (times / minutes)', `${v.LateCount ?? 0} / ${v.LateMinutes ?? 0}`], ['Absent', v.AbsentDays],
    ];
    doc.font('Helvetica-Bold').fontSize(8).text('ATTENDANCE & LEAVE', left, y);
    y += 12;
    doc.font('Helvetica');
    rows.forEach(([k, val], i) => {
        const x = left + (i % 4) * (width / 4);
        if (i && i % 4 === 0) y += 12;
        doc.fillColor('#666').text(k, x, y, { width: width / 4 - 40 }).fillColor('#000').text(String(val ?? 0), x + width / 4 - 40, y, { width: 34, align: 'right' });
    });
    y += 22;
    if (a.records === 0) { doc.fillColor('#999').text('No attendance records for this period.', left, y); y += 12; doc.fillColor('#000'); }

    doc.font('Helvetica-Bold').text('PAYMENT', left, y);
    y += 12;
    doc.font('Helvetica');
    const method = line.payment?.method || s.paymentMethod;
    const pay = [`Method: ${label(method)}`];
    if (method === 'bank_transfer') pay.push(`Bank: ${s.bankName || '—'}${s.bankBranch ? `, ${s.bankBranch}` : ''}`, `Account: ${s.accountNumber ? `••••${String(s.accountNumber).slice(-4)}` : '—'}`);
    pay.push(`Status: ${label(line.payment?.status)}${line.payment?.date ? ` on ${line.payment.date}` : ''}${line.payment?.reference ? ` (ref ${line.payment.reference})` : ''}`);
    doc.text(pay.join('    '), left, y, { width });
    y = Math.max(y + 50, doc.page.height - 120);

    doc.moveTo(left, y).lineTo(left + 160, y).strokeColor('#000').lineWidth(0.5).stroke();
    doc.moveTo(left + width - 160, y).lineTo(left + width, y).stroke();
    doc.fontSize(8).text('Authorized signature', left, y + 4).text('Employee signature', left + width - 160, y + 4);
    doc.fillColor('#777').fontSize(7).text(settings.payslipFooter || '', left, doc.page.height - 50, { width, align: 'center' });
    doc.fillColor('#000');
};

export const payslipPdf = (lines, { settings, period }) => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Payslips ${period.code}` } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    lines.forEach((line, i) => {
        if (i) doc.addPage();
        drawPayslip(doc, line, { settings, period });
    });
    doc.end();
});
