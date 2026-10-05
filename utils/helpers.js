import mongoose from 'mongoose';

// Wraps an async route handler so rejected promises reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const slugify = (value) =>
    String(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

export const isObjectId = (value) => mongoose.isValidObjectId(value) && String(new mongoose.Types.ObjectId(value)) === String(value);

export const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
};

export const paginationMeta = (page, limit, total) => ({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
});

export const roundMoney = (n) => Math.round(n * 100) / 100;
