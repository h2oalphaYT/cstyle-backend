import Order from '../models/Order.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import Coupon from '../models/Coupon.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler, escapeRegex, paginationMeta, parsePagination } from '../utils/helpers.js';

// Orders that count as revenue.
const REVENUE_MATCH = { orderStatus: { $ne: 'cancelled' } };

const rangeStart = (range) => {
    const d = new Date();
    if (range === 'day') d.setDate(d.getDate() - 1);
    else if (range === 'month') d.setMonth(d.getMonth() - 1);
    else if (range === 'year') d.setFullYear(d.getFullYear() - 1);
    else d.setDate(d.getDate() - 7);
    return d;
};

// GET /api/admin/dashboard?range=week
export const dashboard = asyncHandler(async (req, res) => {
    const since = rangeStart(req.query.range);
    const previousSince = new Date(since.getTime() - (Date.now() - since.getTime()));

    const [
        totalProducts, activeProducts, totalOrders, totalCustomers, pendingOrders,
        revenueAll, revenueRange, revenuePrev, lowStock, recentOrders, topProducts, statusBreakdown,
    ] = await Promise.all([
        Product.countDocuments({ isDeleted: false }),
        Product.countDocuments({ isDeleted: false, active: true }),
        Order.countDocuments(),
        User.countDocuments({ role: 'customer' }),
        Order.countDocuments({ orderStatus: 'pending' }),
        Order.aggregate([{ $match: REVENUE_MATCH }, { $group: { _id: null, total: { $sum: '$total' } } }]),
        Order.aggregate([
            { $match: { ...REVENUE_MATCH, createdAt: { $gte: since } } },
            { $group: { _id: null, total: { $sum: '$total' }, orders: { $sum: 1 } } },
        ]),
        Order.aggregate([
            { $match: { ...REVENUE_MATCH, createdAt: { $gte: previousSince, $lt: since } } },
            { $group: { _id: null, total: { $sum: '$total' } } },
        ]),
        Product.find({ isDeleted: false, $expr: { $lte: ['$stock', '$lowStockThreshold'] } })
            .select('name sku stock lowStockThreshold thumbnail images')
            .sort({ stock: 1 })
            .limit(10),
        Order.find().sort({ createdAt: -1 }).limit(8),
        Order.aggregate([
            { $match: REVENUE_MATCH },
            { $unwind: '$items' },
            {
                $group: {
                    _id: '$items.product',
                    name: { $first: '$items.name' },
                    image: { $first: '$items.image' },
                    quantity: { $sum: '$items.quantity' },
                    revenue: { $sum: '$items.lineTotal' },
                },
            },
            { $sort: { quantity: -1 } },
            { $limit: 5 },
        ]),
        Order.aggregate([{ $group: { _id: '$orderStatus', count: { $sum: 1 } } }]),
    ]);

    const current = revenueRange[0]?.total || 0;
    const previous = revenuePrev[0]?.total || 0;
    const change = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
    const lowStockCount = await Product.countDocuments({ isDeleted: false, $expr: { $lte: ['$stock', '$lowStockThreshold'] } });

    res.json({
        success: true,
        data: {
            totals: {
                products: totalProducts,
                activeProducts,
                orders: totalOrders,
                customers: totalCustomers,
                revenue: revenueAll[0]?.total || 0,
                pendingOrders,
                lowStock: lowStockCount,
            },
            range: {
                from: since,
                revenue: current,
                orders: revenueRange[0]?.orders || 0,
                revenueChange: change,
            },
            ordersByStatus: Object.fromEntries(statusBreakdown.map(s => [s._id, s.count])),
            lowStockProducts: lowStock,
            recentOrders,
            topProducts: topProducts.map(p => ({ productId: p._id, name: p.name, image: p.image, quantity: p.quantity, revenue: p.revenue })),
        },
    });
});

// GET /api/admin/sales?range=month — revenue and orders per day for charts.
export const salesSeries = asyncHandler(async (req, res) => {
    const since = rangeStart(req.query.range || 'month');
    const rows = await Order.aggregate([
        { $match: { ...REVENUE_MATCH, createdAt: { $gte: since } } },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                revenue: { $sum: '$total' },
                orders: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);
    // Fill days without orders so charts have a continuous axis.
    const byDay = new Map(rows.map(r => [r._id, r]));
    const series = [];
    for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        series.push({ date: key, revenue: byDay.get(key)?.revenue || 0, orders: byDay.get(key)?.orders || 0 });
    }
    res.json({ success: true, data: series });
});

// GET /api/admin/customers
export const listCustomers = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (req.query.role) filter.role = req.query.role === 'admin' ? 'admin' : 'customer';
    if (req.query.search) {
        const re = new RegExp(escapeRegex(String(req.query.search).slice(0, 80)), 'i');
        filter.$or = [{ name: re }, { email: re }, { phone: re }];
    }
    const [users, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        User.countDocuments(filter),
    ]);
    const stats = await Order.aggregate([
        { $match: { user: { $in: users.map(u => u._id) }, ...REVENUE_MATCH } },
        { $group: { _id: '$user', orders: { $sum: 1 }, spent: { $sum: '$total' }, lastOrderAt: { $max: '$createdAt' } } },
    ]);
    const byUser = new Map(stats.map(s => [String(s._id), s]));
    res.json({
        success: true,
        data: users.map(u => {
            const s = byUser.get(String(u._id));
            return { ...u.toJSON(), orders: s?.orders || 0, totalSpent: s?.spent || 0, lastOrderAt: s?.lastOrderAt || null };
        }),
        pagination: paginationMeta(page, limit, total),
    });
});

// PATCH /api/admin/customers/:id
export const updateCustomer = asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
        throw ApiError.conflict('You cannot change your own role or status');
    }
    const user = await User.findById(req.params.id).select('+tokenVersion');
    if (!user) throw ApiError.notFound('User not found');
    if (req.body.role !== undefined) user.role = req.body.role;
    if (req.body.active !== undefined) user.active = req.body.active;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // force re-login with the new permissions
    await user.save();
    res.json({ success: true, message: 'User updated', data: user });
});

// ── Coupons ────────────────────────────────────────────────────

export const listCoupons = asyncHandler(async (req, res) => {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json({ success: true, data: coupons });
});

export const createCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.create({ ...req.body, code: req.body.code.toUpperCase() });
    res.status(201).json({ success: true, message: 'Coupon created', data: coupon });
});

export const updateCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw ApiError.notFound('Coupon not found');
    coupon.set({ ...req.body, code: req.body.code.toUpperCase() });
    await coupon.save();
    res.json({ success: true, message: 'Coupon updated', data: coupon });
});

export const deleteCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) throw ApiError.notFound('Coupon not found');
    res.json({ success: true, message: 'Coupon deleted' });
});

// GET /api/coupons/public — active codes that can be advertised in the storefront.
export const publicCoupons = asyncHandler(async (req, res) => {
    const now = new Date();
    const coupons = await Coupon.find({
        active: true,
        $and: [
            { $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] },
            { $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
        ],
    }).select('code description type value minimumAmount expiryDate firstOrderOnly').sort({ value: -1 }).limit(5);
    res.json({ success: true, data: coupons });
});

// GET /api/users/me/recently-viewed
export const recentlyViewed = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('recentlyViewed').populate({
        path: 'recentlyViewed.product',
        match: { isDeleted: false, active: true },
        populate: { path: 'category', select: 'name slug' },
    });
    const products = (user?.recentlyViewed || []).map(r => r.product).filter(Boolean).slice(0, 12);
    res.json({ success: true, data: products });
});
