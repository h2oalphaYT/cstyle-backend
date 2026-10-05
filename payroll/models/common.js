import mongoose from 'mongoose';

export const { ObjectId } = mongoose.Schema.Types;
export const ref = (model, extra = {}) => ({ type: ObjectId, ref: model, default: null, ...extra });

/** createdBy / updatedBy / soft delete / timestamps / id in JSON for every HR collection. */
export const hrPlugin = (schema, { softDelete = true } = {}) => {
    schema.add({
        createdBy: { type: ObjectId, ref: 'User', default: null },
        updatedBy: { type: ObjectId, ref: 'User', default: null },
    });
    if (softDelete) {
        schema.add({ deletedAt: { type: Date, default: null, index: true } });
    }
    schema.set('timestamps', true);
    schema.set('toJSON', {
        virtuals: true,
        transform: (doc, ret) => {
            ret.id = String(ret._id);
            delete ret.__v;
            return ret;
        },
    });
    schema.set('toObject', { virtuals: true });
};

export const model = (name, schema, opts) => {
    schema.plugin(hrPlugin, opts);
    return mongoose.models[name] || mongoose.model(name, schema);
};

/** "2026-10" style payroll period code */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** "2026-10-05" date-only string, used as the attendance day key */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Uploaded file reference (stored under uploads/hr, served only through authorised routes). */
export const attachmentSchema = new mongoose.Schema({
    name: String,
    path: String,
    mimeType: String,
    size: Number,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
}, { _id: true });
