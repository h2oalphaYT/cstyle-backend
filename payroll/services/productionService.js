import { Attendance, Holiday, ProductionLog, ProductionTarget } from '../models/index.js';
import { getGlobalSettings } from './settingsService.js';
import { addDays, eachDay, localTime, TIME_RE, today, weekday } from './util.js';

const WORKED = ['present', 'late', 'early_leave', 'half_day', 'remote'];
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Pace against a straight line from shift start (0) to shift end (target). */
export const paceFor = ({ achieved, target, nowMinutes, start, end }) => {
    if (!target) return { expected: 0, status: 'no_target' };
    if (achieved >= target) return { expected: target, status: 'done' };
    if (nowMinutes == null) return { expected: target, status: 'behind' }; // a past day that missed the target
    if (nowMinutes <= start) return { expected: 0, status: 'not_started' };
    const share = Math.min(1, (nowMinutes - start) / Math.max(1, end - start));
    const expected = Math.round(target * share);
    if (achieved >= expected) return { expected, status: 'ahead' };
    if (achieved >= expected * 0.9) return { expected, status: 'on_track' };
    return { expected, status: 'behind' };
};

/** Hour-by-hour pieces for the board's bar chart (shift hours, plus any hour outside the shift that has output). */
export const hourlyBuckets = (logs, shiftStart, shiftEnd) => {
    const first = Math.floor(minutes(shiftStart) / 60);
    const last = Math.max(first, Math.ceil(minutes(shiftEnd) / 60) - 1);
    const map = new Map();
    for (let h = first; h <= last; h += 1) map.set(h, 0);
    for (const l of logs) {
        const t = l.time || localTime(l.createdAt);
        const h = Number(t.slice(0, 2));
        map.set(h, (map.get(h) || 0) + l.quantity);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([h, quantity]) => ({ hour: `${String(h).padStart(2, '0')}:00`, quantity }));
};

/** Achieved pieces and targets for every day in a range. */
export const dailyTotals = async (from, to, settings = null) => {
    const cfg = settings || await getGlobalSettings();
    const [achieved, targets] = await Promise.all([
        ProductionLog.aggregate([
            { $match: { date: { $gte: from, $lte: to }, deletedAt: null } },
            { $group: { _id: '$date', achieved: { $sum: '$quantity' } } },
        ]),
        ProductionTarget.find({ date: { $gte: from, $lte: to }, deletedAt: null }).lean(),
    ]);
    const a = new Map(achieved.map(r => [r._id, r.achieved]));
    const t = new Map(targets.map(r => [r.date, r]));
    const offDays = cfg.weeklyOffDays || [];
    return eachDay(from, to).map((date) => {
        const target = t.has(date) ? t.get(date).target : (offDays.includes(weekday(date)) ? 0 : Number(cfg.dailyProductionTarget) || 0);
        const done = a.get(date) || 0;
        return {
            date, target, achieved: done, percent: target ? Math.round((done / target) * 100) : null,
            met: target > 0 && done >= target, custom: t.has(date), offDay: offDays.includes(weekday(date)),
        };
    });
};

/** Everything the factory TV board shows for one day. */
export const productionBoard = async (date = today(), { now = new Date() } = {}) => {
    const settings = await getGlobalSettings();
    const isToday = date === today();
    const [logs, targetDoc, holidays, present] = await Promise.all([
        ProductionLog.find({ date, deletedAt: null }).sort({ time: 1, createdAt: 1 }).lean(),
        ProductionTarget.findOne({ date, deletedAt: null }).lean(),
        Holiday.find({ date: { $gte: date, $lte: addDays(date, 60) }, deletedAt: null }).sort({ date: 1 }).lean(),
        Attendance.countDocuments({ date, deletedAt: null, status: { $in: WORKED } }),
    ]);
    const shiftStart = TIME_RE.test(settings.productionShiftStart) ? settings.productionShiftStart : '08:00';
    const shiftEnd = TIME_RE.test(settings.productionShiftEnd) ? settings.productionShiftEnd : '17:00';
    const target = targetDoc ? targetDoc.target : Number(settings.dailyProductionTarget) || 0;
    const achieved = logs.reduce((s, l) => s + l.quantity, 0);

    const hourly = hourlyBuckets(logs, shiftStart, shiftEnd);
    let running = 0;
    for (const h of hourly) { running += h.quantity; h.cumulative = running; }

    const nowMinutes = isToday ? minutes(localTime(now)) : null;
    const pace = date > today() ? { expected: 0, status: 'not_started' }
        : paceFor({ achieved, target, nowMinutes, start: minutes(shiftStart), end: minutes(shiftEnd) });
    const remaining = Math.max(0, target - achieved);
    const minutesLeft = isToday ? Math.max(0, minutes(shiftEnd) - nowMinutes) : 0;
    // Spread what is left over the hours left (the last hour counts as a full hour).
    const neededPerHour = remaining && minutesLeft ? Math.ceil(remaining / Math.max(1, minutesLeft / 60)) : 0;

    // Last 30 days: week chart, best day and the run of days the target was met.
    const history = await dailyTotals(addDays(date, -30), addDays(date, -1), settings);
    // Days with nothing recorded (before tracking started, closed days) are left out of the week, streak and month.
    const recorded = (d) => d.achieved > 0 || d.custom;
    const worked = history.filter(recorded);
    // Days in a row (before today) the target was met; today joins the run once it is reached.
    let streak = 0;
    for (let i = worked.length - 1; i >= 0 && worked[i].met; i -= 1) streak += 1;
    if (target > 0 && achieved >= target) streak += 1;
    const best = worked.reduce((b, d) => (d.achieved > (b?.achieved || 0) ? d : b), null);
    const month = (await dailyTotals(`${date.slice(0, 7)}-01`, date, settings)).filter(d => recorded(d) || d.date === date);

    const byItem = new Map();
    for (const l of logs) byItem.set(l.item || settings.productionItem, (byItem.get(l.item || settings.productionItem) || 0) + l.quantity);

    const holidayToday = holidays.find(h => h.date === date) || null;
    const next = holidays.find(h => h.date > date) || null;
    return {
        date,
        isToday,
        item: targetDoc?.item || settings.productionItem,
        target,
        targetNote: targetDoc?.note || '',
        customTarget: Boolean(targetDoc),
        achieved,
        remaining,
        percent: target ? Math.round((achieved / target) * 100) : 0,
        pace: { ...pace, neededPerHour, minutesLeft },
        shift: { start: shiftStart, end: shiftEnd },
        hourly,
        lastEntry: logs.length ? { time: logs[logs.length - 1].time, quantity: logs[logs.length - 1].quantity, item: logs[logs.length - 1].item } : null,
        byItem: [...byItem.entries()].map(([item, quantity]) => ({ item, quantity })),
        week: worked.slice(-6).concat([{ date, target, achieved, percent: target ? Math.round((achieved / target) * 100) : null, met: target > 0 && achieved >= target }]),
        streak,
        best: best ? { date: best.date, achieved: best.achieved } : null,
        month: {
            achieved: month.reduce((s, d) => s + d.achieved, 0),
            target: month.reduce((s, d) => s + d.target, 0),
            daysMet: month.filter(d => d.met).length,
            workingDays: month.filter(d => d.target > 0).length,
        },
        peopleAtWork: present,
        holiday: holidayToday ? { name: holidayToday.name, observed: holidayToday.observed !== false, poya: Boolean(holidayToday.poya) } : null,
        nextHoliday: next ? { date: next.date, name: next.name, poya: Boolean(next.poya), observed: next.observed !== false } : null,
        message: settings.productionBoardMessage || '',
        updatedAt: new Date().toISOString(),
    };
};
