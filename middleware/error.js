import multer from 'multer';
import ApiError from '../utils/ApiError.js';

export const notFound = (req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
    let status = 500;
    let message = 'Something went wrong. Please try again.';
    let errors;

    if (err instanceof ApiError) {
        status = err.statusCode;
        message = err.message;
        errors = err.errors;
    } else if (err instanceof multer.MulterError) {
        status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        message = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large' : `Upload error: ${err.message}`;
    } else if (err?.name === 'ValidationError') {
        status = 422;
        message = 'Validation failed';
        errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
    } else if (err?.name === 'CastError') {
        status = 400;
        message = `Invalid ${err.path}`;
    } else if (err?.code === 11000) {
        status = 409;
        const field = Object.keys(err.keyValue || {})[0] || 'field';
        message = `A record with this ${field} already exists`;
    } else if (err?.type === 'entity.parse.failed') {
        status = 400;
        message = 'Malformed JSON body';
    } else if (err?.type === 'entity.too.large') {
        status = 413;
        message = 'Request body is too large';
    }

    if (status >= 500) {
        console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    }

    const body = { success: false, message };
    if (errors) body.errors = errors;
    res.status(status).json(body);
};
