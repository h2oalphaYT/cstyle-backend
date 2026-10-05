import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/helpers.js';

export const signToken = (user) =>
    jwt.sign({ sub: String(user._id), role: user.role, tv: user.tokenVersion || 0 }, config.jwtSecret, {
        expiresIn: config.jwtExpiresIn,
    });

const readToken = (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return null;
};

const resolveUser = async (token) => {
    let payload;
    try {
        payload = jwt.verify(token, config.jwtSecret);
    } catch {
        throw ApiError.unauthorized('Your session has expired. Please log in again.');
    }
    const user = await User.findById(payload.sub).select('+tokenVersion');
    // tokenVersion is bumped on logout / password change, which revokes older tokens.
    if (!user || !user.active || (payload.tv ?? 0) !== (user.tokenVersion || 0)) {
        throw ApiError.unauthorized('Your session is no longer valid. Please log in again.');
    }
    return user;
};

// Requires a valid token.
export const protect = asyncHandler(async (req, res, next) => {
    const token = readToken(req);
    if (!token) throw ApiError.unauthorized();
    req.user = await resolveUser(token);
    next();
});

// Attaches req.user when a valid token is present; continues as a guest otherwise.
export const optionalAuth = asyncHandler(async (req, res, next) => {
    const token = readToken(req);
    if (token) {
        try {
            req.user = await resolveUser(token);
        } catch {
            req.user = undefined;
        }
    }
    next();
});

export const authorize = (...roles) => (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
};

export const adminOnly = [protect, authorize('admin')];
