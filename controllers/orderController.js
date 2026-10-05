import Order, { ORDER_STATUSES } from '../models/Order.js';
import Cart from '../models/Cart.js';
import Coupon from '../models/Coupon.js';
import Counter from '../models/Counter.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import { asyncHandler, escapeRegex, isObjectId, paginationMeta, parsePagination } from '../utils/helpers.js';
import { quote } from '../services/pricingService.js';
import { releaseStock, reserveStock } from '../services/inventoryService.js';

const stockLines = (items) => items.map(i => ({
    productId: i.product,
    variantId: i.variant || null,
    quantity: i.quantity,
    name: i.name,
}));

const presentQuote = (q) => ({
    subtotal: q.subtotal,
    discount: q.discount,
    shipping: q.shipping,
    total: q.total,
    currency: config.currency,
    coupon: q.coupon ? { code: q.coupon.code, type: q.coupon.type, value: q.coupon.value, description: q.coupon.description } : null,
    freeShippingThreshold: config.freeShippingThreshold,
    shippingFee: config.shippingFee,
});

// POST /api/orders/quote — price preview used by the checkout page.
export const quoteOrder = asyncHandler(async (req, res) => {
    const q = await quote({ items: req.body.items, couponCode: req.body.couponCode, user: req.user, email: req.body.email });
    res.json({ success: true, data: presentQuote(q) });
});

// POST /api/coupons/validate
export const validateCoupon = asyncHandler(async (req, res) => {
    const q = await quote({ items: req.body.items, couponCode: req.body.code, user: req.user, email: req.body.email });
    res.json({ success: true, message: `Coupon ${q.coupon.code} applied`, data: presentQuote(q) });
});

const claimCoupon = async (coupon) => {
    const res = await Coupon.updateOne(
        {
            _id: coupon._id,
            active: true,
            $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }],
        },
        { $inc: { usedCount: 1 } },
    );
    if (res.modifiedCount !== 1) throw ApiError.conflict('This coupon has just reached its usage limit');
};

const releaseCoupon = (code) => code && Coupon.updateOne({ code, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });

// POST /api/orders — open to guests and logged-in customers. Prices always come from the database.
export const createOrder = asyncHandler(async (req, res) => {
    const { items, customer, shippingAddress, billingAddress, paymentMethod, couponCode, notes } = req.body;
    const q = await quote({ items, couponCode, user: req.user, email: customer.email });

    const orderItems = q.lines.map(l => ({
        product: l.product._id,
        variant: l.variant?._id || null,
        name: l.product.name,
        sku: l.variant?.sku || l.product.sku,
        image: l.product.thumbnail || l.product.images?.[0] || '',
        size: l.variant?.size || '',
        color: l.variant?.color || '',
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
    }));

    await reserveStock(stockLines(orderItems));
    try {
        if (q.coupon) await claimCoupon(q.coupon);
    } catch (err) {
        await releaseStock(stockLines(orderItems));
        throw err;
    }

    let order;
    try {
        const seq = await Counter.next('order');
        order = await Order.create({
            orderNumber: `CS${String(100000 + seq)}`,
            user: req.user?._id || null,
            customer,
            items: orderItems,
            subtotal: q.subtotal,
            discount: q.discount,
            shipping: q.shipping,
            total: q.total,
            currency: config.currency,
            coupon: q.coupon ? { code: q.coupon.code, type: q.coupon.type, value: q.coupon.value } : undefined,
            paymentMethod,
            shippingAddress,
            billingAddress: billingAddress || shippingAddress,
            notes,
            statusHistory: [{ status: 'pending', note: 'Order placed', by: req.user?._id || null }],
        });
    } catch (err) {
        await releaseStock(stockLines(orderItems));
        await releaseCoupon(q.coupon?.code);
        throw err;
    }

    if (req.user) await Cart.updateOne({ user: req.user._id }, { items: [] });
    res.status(201).json({ success: true, message: 'Order placed successfully', data: order });
});

// GET /api/orders/my
export const myOrders = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = { user: req.user._id };
    const [orders, total] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Order.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: paginationMeta(page, limit, total) });
});

const findOrder = (idOrNumber) =>
    Order.findOne(isObjectId(idOrNumber) ? { _id: idOrNumber } : { orderNumber: String(idOrNumber).toUpperCase() });

// GET /api/orders/:id — the customer who placed it, or an admin.
export const getOrder = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw ApiError.notFound('Order not found');
    const owns = order.user && String(order.user) === String(req.user._id);
    if (!owns && req.user.role !== 'admin') throw ApiError.notFound('Order not found');
    res.json({ success: true, data: order });
});

// GET /api/orders/track?orderNumber=&email= — lets guests see their order.
export const trackOrder = asyncHandler(async (req, res) => {
    const orderNumber = String(req.query.orderNumber || '').trim().toUpperCase();
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!orderNumber || !email) throw ApiError.badRequest('Order number and email are required');
    const order = await Order.findOne({ orderNumber, 'customer.email': email });
    if (!order) throw ApiError.notFound('No order matches that number and email');
    res.json({ success: true, data: order });
});

const cancel = async (order, userId, note) => {
    if (order.stockReserved) {
        await releaseStock(stockLines(order.items));
        order.stockReserved = false;
    }
    await releaseCoupon(order.coupon?.code);
    order.orderStatus = 'cancelled';
    if (order.paymentStatus === 'paid') order.paymentStatus = 'refunded';
    order.statusHistory.push({ status: 'cancelled', note, by: userId });
};

// PATCH /api/orders/:id/cancel — customers may cancel before the order is processed.
export const cancelMyOrder = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order || !order.user || String(order.user) !== String(req.user._id)) throw ApiError.notFound('Order not found');
    if (!['pending', 'confirmed'].includes(order.orderStatus)) {
        throw ApiError.conflict('This order is already being processed and can no longer be cancelled');
    }
    await cancel(order, req.user._id, 'Cancelled by customer');
    await order.save();
    res.json({ success: true, message: 'Order cancelled', data: order });
});

// ── Admin ──────────────────────────────────────────────────────

// GET /api/orders
export const listOrders = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const filter = {};
    if (req.query.status && ORDER_STATUSES.includes(req.query.status)) filter.orderStatus = req.query.status;
    if (req.query.paymentStatus) filter.paymentStatus = String(req.query.paymentStatus);
    if (req.query.search) {
        const re = new RegExp(escapeRegex(String(req.query.search).slice(0, 80)), 'i');
        filter.$or = [{ orderNumber: re }, { 'customer.name': re }, { 'customer.email': re }, { 'customer.phone': re }];
    }
    const [orders, total] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Order.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: paginationMeta(page, limit, total) });
});

// PATCH /api/orders/:id/status
export const updateOrderStatus = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw ApiError.notFound('Order not found');
    const { orderStatus, paymentStatus, note } = req.body;

    if (orderStatus && orderStatus !== order.orderStatus) {
        if (order.orderStatus === 'cancelled') throw ApiError.conflict('Cancelled orders cannot be changed');
        if (order.orderStatus === 'delivered' && orderStatus !== 'cancelled') {
            throw ApiError.conflict('Delivered orders cannot move back to an earlier status');
        }
        if (orderStatus === 'cancelled') {
            await cancel(order, req.user._id, note || 'Cancelled by admin');
        } else {
            if (ORDER_STATUSES.indexOf(orderStatus) < ORDER_STATUSES.indexOf(order.orderStatus)) {
                throw ApiError.conflict(`An order cannot move back from ${order.orderStatus} to ${orderStatus}`);
            }
            order.orderStatus = orderStatus;
            order.statusHistory.push({ status: orderStatus, note, by: req.user._id });
            // Cash on delivery is collected at the door.
            if (orderStatus === 'delivered' && order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
                order.paymentStatus = 'paid';
            }
        }
    }
    if (paymentStatus) order.paymentStatus = paymentStatus;
    await order.save();
    res.json({ success: true, message: 'Order updated', data: order });
});
