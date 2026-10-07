import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, isObjectId } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import { PayrollSetting, ProductionLog, ProductionTarget } from '../models/index.js';
import { can } from '../permissions.js';
import { dailyTotals, productionBoard } from '../services/productionService.js';
import { getGlobalSettings, sanitizeSettings } from '../services/settingsService.js';
import { addDays, audit, daysBetween, isValidDay, localTime, TIME_RE, today } from '../services/util.js';

const router = express.Router();
const VIEW = ['production.view', 'production.edit', 'production.manage'];

const dayParam = (value, fallback = today()) => {
    const day = value || fallback;
    if (!isValidDay(day)) throw ApiError.unprocessable('Invalid date');
    return day;
};

/** Everything the factory TV shows: target, achieved, pace, hourly output, week, streak, next holiday. */
router.get('/production/board', protect, can(...VIEW), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await productionBoard(dayParam(req.query.date)) });
}));

/** Target vs achieved for each day in a range (at most a year). */
router.get('/production/summary', protect, can(...VIEW), asyncHandler(async (req, res) => {
    const to = dayParam(req.query.to);
    const from = dayParam(req.query.from, addDays(to, -29));
    if (from > to || daysBetween(from, to) > 366) throw ApiError.unprocessable('Choose a range of up to one year');
    const days = await dailyTotals(from, to);
    // Totals cover days with output recorded (or their own target), so days before tracking began do not count as misses.
    const worked = days.filter(d => d.achieved > 0 || d.custom);
    res.json({
        success: true,
        data: days,
        totals: {
            achieved: worked.reduce((s, d) => s + d.achieved, 0),
            target: worked.reduce((s, d) => s + d.target, 0),
            daysMet: days.filter(d => d.met).length,
            workingDays: worked.length,
            average: worked.length ? Math.round(worked.reduce((s, d) => s + d.achieved, 0) / worked.length) : 0,
        },
    });
}));

router.get('/production/logs', protect, can(...VIEW), asyncHandler(async (req, res) => {
    const date = dayParam(req.query.date);
    const data = await ProductionLog.find({ date, deletedAt: null }).populate('createdBy', 'name').sort({ time: 1, createdAt: 1 });
    res.json({ success: true, data });
}));

router.post('/production/logs', protect, can('production.edit', 'production.manage'), asyncHandler(async (req, res) => {
    const { item = '', note = '' } = req.body || {};
    const date = dayParam(req.body?.date);
    if (date > today()) throw ApiError.unprocessable('Output cannot be recorded for a future date');
    const time = req.body?.time || (date === today() ? localTime(new Date()) : null);
    if (time && !TIME_RE.test(time)) throw ApiError.unprocessable('Time must be HH:mm');
    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw ApiError.unprocessable('Enter the number of finished pieces (a whole number)');
    const doc = await ProductionLog.create({
        date, time, item: String(item).slice(0, 80), quantity, note: String(note).slice(0, 300), createdBy: req.user._id, updatedBy: req.user._id,
    });
    await audit(req, { action: 'create', entity: 'ProductionLog', after: doc, label: `${date} ${quantity}` });
    res.status(201).json({ success: true, message: `${quantity} piece(s) added`, data: doc });
}));

router.delete('/production/logs/:id', protect, can('production.edit', 'production.manage'), asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
    const doc = await ProductionLog.findOne({ _id: req.params.id, deletedAt: null });
    if (!doc) throw ApiError.notFound('Entry not found');
    const before = doc.toObject();
    doc.deletedAt = new Date();
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, { action: 'delete', entity: 'ProductionLog', before, after: doc, label: `${doc.date} ${doc.quantity}` });
    res.json({ success: true, message: 'Entry removed' });
}));

router.get('/production/targets', protect, can(...VIEW), asyncHandler(async (req, res) => {
    const from = dayParam(req.query.from, addDays(today(), -31));
    const to = dayParam(req.query.to, addDays(today(), 31));
    const data = await ProductionTarget.find({ date: { $gte: from, $lte: to }, deletedAt: null }).sort({ date: 1 });
    res.json({ success: true, data });
}));

/** Sets one day's target (e.g. 90 on a short Saturday, 150 for a rush order). */
router.put('/production/targets/:date', protect, can('production.manage'), asyncHandler(async (req, res) => {
    const date = dayParam(req.params.date);
    const target = Number(req.body?.target);
    if (!Number.isInteger(target) || target < 0 || target > 100000) throw ApiError.unprocessable('Target must be a whole number');
    const doc = await ProductionTarget.findOne({ date, deletedAt: null }) || new ProductionTarget({ date, createdBy: req.user._id });
    const before = doc.isNew ? null : doc.toObject();
    doc.set({ target, item: String(req.body?.item || '').slice(0, 80), note: String(req.body?.note || '').slice(0, 300), updatedBy: req.user._id });
    await doc.save();
    await audit(req, { action: before ? 'update' : 'create', entity: 'ProductionTarget', before, after: doc, label: `${date} ${target}` });
    res.json({ success: true, message: 'Target saved', data: doc });
}));

/** Removes a day's own target so the default applies again. */
router.delete('/production/targets/:date', protect, can('production.manage'), asyncHandler(async (req, res) => {
    const date = dayParam(req.params.date);
    const doc = await ProductionTarget.findOne({ date, deletedAt: null });
    if (!doc) throw ApiError.notFound('This day uses the default target');
    const before = doc.toObject();
    doc.deletedAt = new Date();
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, { action: 'delete', entity: 'ProductionTarget', before, after: doc, label: date });
    res.json({ success: true, message: 'Back to the default target' });
}));

const BOARD_KEYS = ['dailyProductionTarget', 'productionItem', 'productionShiftStart', 'productionShiftEnd', 'productionBoardMessage'];

router.get('/production/settings', protect, can(...VIEW), asyncHandler(async (req, res) => {
    const settings = await getGlobalSettings();
    res.json({ success: true, data: Object.fromEntries(BOARD_KEYS.map(k => [k, settings[k]])) });
}));

/** Default daily target, item name, shift hours and the board's message. */
router.put('/production/settings', protect, can('production.manage'), asyncHandler(async (req, res) => {
    const values = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => BOARD_KEYS.includes(k)));
    const clean = sanitizeSettings(values);
    for (const k of ['productionShiftStart', 'productionShiftEnd']) {
        if (clean[k] !== undefined && !TIME_RE.test(clean[k])) throw ApiError.unprocessable('Shift times must be HH:mm');
    }
    if (clean.dailyProductionTarget !== undefined && !Number.isInteger(clean.dailyProductionTarget)) throw ApiError.unprocessable('Target must be a whole number');
    const doc = await PayrollSetting.findOne({ scope: 'global', scopeRef: null }) || new PayrollSetting({ scope: 'global', scopeRef: null, values: {} });
    const before = doc.isNew ? null : doc.toObject();
    doc.values = { ...doc.values, ...clean };
    doc.markModified('values');
    doc.updatedBy = req.user._id;
    await doc.save();
    await audit(req, { action: 'update', entity: 'PayrollSetting', before, after: doc, label: 'production' });
    res.json({ success: true, message: 'Production settings saved', data: Object.fromEntries(BOARD_KEYS.map(k => [k, doc.values[k]])) });
}));

export default router;
