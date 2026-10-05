import express from 'express';
import ApiError from '../../utils/ApiError.js';
import { asyncHandler, escapeRegex, isObjectId, paginationMeta, parsePagination } from '../../utils/helpers.js';
import { protect } from '../../middleware/auth.js';
import { can } from '../permissions.js';
import { audit, pick } from '../services/util.js';

/**
 * Generic list / get / create / update / soft-delete endpoints for HR master data.
 *
 * options:
 *   entity       audit entity name
 *   fields       whitelist of writable fields (anything else in the body is ignored)
 *   read, write  permission lists
 *   search       fields used by ?search=
 *   filters      query params copied into the Mongo filter (e.g. ['type', 'active'])
 *   populate     populate spec for list/get
 *   sort         default sort
 *   label        (doc) => string for audit
 *   beforeSave   async (req, doc, body, isNew) => void   — extra validation / derived fields
 *   canDelete    async (doc) => void                     — throw to block deletion
 */
export const crudRouter = (Model, opts) => {
    const router = express.Router();
    const {
        entity, fields, read, write, search = ['name', 'code'], filters = [], populate = null,
        sort = { name: 1 }, label = (d) => d.code || d.name || String(d._id), beforeSave, afterSave, canDelete, softDelete = true,
    } = opts;
    const base = softDelete ? { deletedAt: null } : {};

    router.get('/', protect, can(...read), asyncHandler(async (req, res) => {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
        const q = { ...base };
        for (const f of filters) {
            const v = req.query[f];
            if (v === undefined || v === '') continue;
            q[f] = v === 'true' ? true : v === 'false' ? false : v;
        }
        if (req.query.search) {
            const re = new RegExp(escapeRegex(String(req.query.search).slice(0, 80)), 'i');
            q.$or = search.map(s => ({ [s]: re }));
        }
        let query = Model.find(q).sort(sort).skip(skip).limit(limit);
        if (populate) query = query.populate(populate);
        const [data, total] = await Promise.all([query, Model.countDocuments(q)]);
        res.json({ success: true, data, pagination: paginationMeta(page, limit, total) });
    }));

    router.get('/:id', protect, can(...read), asyncHandler(async (req, res) => {
        if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
        let query = Model.findOne({ _id: req.params.id, ...base });
        if (populate) query = query.populate(populate);
        const doc = await query;
        if (!doc) throw ApiError.notFound(`${entity} not found`);
        res.json({ success: true, data: doc });
    }));

    router.post('/', protect, can(...write), asyncHandler(async (req, res) => {
        const body = pick(req.body || {}, fields);
        const doc = new Model({ ...body, createdBy: req.user._id, updatedBy: req.user._id });
        if (beforeSave) await beforeSave(req, doc, body, true);
        await doc.save();
        if (afterSave) await afterSave(req, doc);
        await audit(req, { action: 'create', entity, after: doc, label: label(doc) });
        res.status(201).json({ success: true, message: `${entity} created`, data: doc });
    }));

    router.put('/:id', protect, can(...write), asyncHandler(async (req, res) => {
        if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
        const doc = await Model.findOne({ _id: req.params.id, ...base });
        if (!doc) throw ApiError.notFound(`${entity} not found`);
        const before = doc.toObject();
        const body = pick(req.body || {}, fields);
        doc.set({ ...body, updatedBy: req.user._id });
        if (beforeSave) await beforeSave(req, doc, body, false);
        await doc.save();
        if (afterSave) await afterSave(req, doc);
        await audit(req, { action: 'update', entity, before, after: doc, label: label(doc) });
        res.json({ success: true, message: `${entity} updated`, data: doc });
    }));

    router.delete('/:id', protect, can(...write), asyncHandler(async (req, res) => {
        if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid id');
        const doc = await Model.findOne({ _id: req.params.id, ...base });
        if (!doc) throw ApiError.notFound(`${entity} not found`);
        if (canDelete) await canDelete(doc);
        const before = doc.toObject();
        if (softDelete) {
            doc.deletedAt = new Date();
            doc.updatedBy = req.user._id;
            await doc.save();
        } else {
            await doc.deleteOne();
        }
        await audit(req, { action: 'delete', entity, before, label: label(doc) });
        res.json({ success: true, message: `${entity} deleted` });
    }));

    return router;
};
