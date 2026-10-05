import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/helpers.js';
import { signToken } from '../middleware/auth.js';
import { loadAccess } from '../payroll/permissions.js';

// Back-office permissions travel with the user so the admin panel can show the right menus.
const withAccess = async (req, user) => {
    req.user = user;
    const access = await loadAccess(req);
    return { ...user.toJSON(), permissions: [...access.permissions], dataScope: access.dataScope, staffRoleName: access.roleName };
};

const authResponse = async (req, res, user, status = 200) => {
    res.status(status).json({ success: true, data: { token: signToken(user), user: await withAccess(req, user) } });
};

// POST /api/auth/register
export const register = asyncHandler(async (req, res) => {
    const { name, email, password, phone } = req.body;
    if (await User.exists({ email })) throw ApiError.conflict('An account with this email already exists');
    const user = new User({ name, email, phone, role: 'customer' });
    await user.setPassword(password);
    await user.save();
    await authResponse(req, res, user, 201);
});

// POST /api/auth/login
export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+passwordHash +tokenVersion');
    // Same message for unknown email and wrong password so accounts cannot be enumerated.
    if (!user || !(await user.checkPassword(password))) throw ApiError.unauthorized('Incorrect email or password');
    if (!user.active) throw ApiError.forbidden('This account has been disabled');
    user.lastLoginAt = new Date();
    await user.save();
    await authResponse(req, res, user);
});

// POST /api/auth/logout — revokes every token issued to this user so far.
export const logout = asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    res.json({ success: true, message: 'Logged out' });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await withAccess(req, req.user) });
});

// PUT /api/auth/me
export const updateMe = asyncHandler(async (req, res) => {
    const { name, phone, addresses } = req.body;
    if (name !== undefined) req.user.name = name;
    if (phone !== undefined) req.user.phone = phone;
    if (addresses !== undefined) {
        // Exactly one default address.
        const defaultIdx = Math.max(0, addresses.findIndex(a => a.isDefault));
        req.user.addresses = addresses.map((a, i) => ({ ...a, isDefault: i === defaultIdx }));
    }
    await req.user.save();
    res.json({ success: true, data: await withAccess(req, req.user) });
});

// PUT /api/auth/password
export const changePassword = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash +tokenVersion');
    if (!(await user.checkPassword(req.body.currentPassword))) {
        throw ApiError.unprocessable('Current password is incorrect');
    }
    await user.setPassword(req.body.newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await authResponse(req, res, user);
});
