import ApiError from '../utils/ApiError.js';

// Validates and replaces req[source] with the parsed (coerced, stripped) zod result.
export const validate = (schema, source = 'body') => (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
        const errors = result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }));
        return next(ApiError.unprocessable(errors[0]?.message || 'Validation failed', errors));
    }
    if (source === 'query') {
        for (const key of Object.keys(req.query)) delete req.query[key];
        Object.assign(req.query, result.data);
    } else {
        req[source] = result.data;
    }
    next();
};
