import mongoose from 'mongoose';
import { DAY_RE, model } from './common.js';

/**
 * Finished pieces recorded during the day (e.g. "35 pants at 11:00"). The factory TV board adds them
 * up against the day's target.
 */
const productionLogSchema = new mongoose.Schema({
    date: { type: String, required: true, match: DAY_RE, index: true },
    time: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: null }, // when the pieces were counted
    item: { type: String, trim: true, maxlength: 80, default: '' }, // style / product, e.g. "Pants"
    quantity: { type: Number, required: true, min: 1, max: 100000 },
    note: { type: String, trim: true, maxlength: 300, default: '' },
});
productionLogSchema.index({ date: 1, time: 1 });
export const ProductionLog = model('ProductionLog', productionLogSchema);

/** A day's target when it differs from the default in settings (e.g. a short day or a rush order). */
const productionTargetSchema = new mongoose.Schema({
    date: { type: String, required: true, match: DAY_RE },
    target: { type: Number, required: true, min: 0, max: 100000 },
    item: { type: String, trim: true, maxlength: 80, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
});
productionTargetSchema.index({ date: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const ProductionTarget = model('ProductionTarget', productionTargetSchema);
