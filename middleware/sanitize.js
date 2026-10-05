// Strips MongoDB operator keys ("$gt", "a.b") from user input to block NoSQL injection.
const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        const out = {};
        for (const [key, v] of Object.entries(value)) {
            if (key.startsWith('$') || key.includes('.')) continue;
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            out[key] = clean(v);
        }
        return out;
    }
    return value;
};

export const sanitizeInput = (req, res, next) => {
    if (req.body) req.body = clean(req.body);
    if (req.params) req.params = clean(req.params);
    // Express 4 lets us replace req.query; nested objects from "?a[$gt]=" are dropped here.
    if (req.query) {
        const q = clean(req.query);
        for (const key of Object.keys(req.query)) delete req.query[key];
        Object.assign(req.query, q);
    }
    next();
};
