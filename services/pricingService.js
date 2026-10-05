import config from '../config/env.js';
import Product from '../models/Product.js';
import Coupon from '../models/Coupon.js';
import Order from '../models/Order.js';
import ApiError from '../utils/ApiError.js';
import { isObjectId, roundMoney } from '../utils/helpers.js';

export const shippingFor = (amount) => {
    if (amount <= 0) return 0;
    return amount >= config.freeShippingThreshold ? 0 : config.shippingFee;
};

/**
 * Finds the variant a shopper picked. Products with a variant matrix require a match;
 * products without variants use product-level stock.
 */
export const resolveVariant = (product, { variantId, size, color } = {}) => {
    if (!product.variants?.length) return null;
    let variant = null;
    if (variantId && isObjectId(variantId)) variant = product.variants.id(variantId);
    if (!variant) {
        variant = product.variants.find(v =>
            (v.size || '') === (size || '') && (v.color || '').toLowerCase() === (color || '').toLowerCase());
    }
    if (!variant) {
        throw ApiError.unprocessable(`Please choose an available size and colour for ${product.name}`);
    }
    return variant;
};

export const availableStock = (product, variant) => (variant ? variant.stock : product.stock);

// Loads purchasable products for a set of requested lines and checks stock.
export const buildLines = async (requested) => {
    if (!Array.isArray(requested) || requested.length === 0) {
        throw ApiError.unprocessable('Your cart is empty');
    }
    const ids = [...new Set(requested.map(r => String(r.productId)))];
    if (ids.some(id => !isObjectId(id))) throw ApiError.badRequest('Invalid product in cart');

    const products = await Product.find({ _id: { $in: ids }, isDeleted: false, active: true });
    const byId = new Map(products.map(p => [String(p._id), p]));

    const lines = [];
    for (const r of requested) {
        const product = byId.get(String(r.productId));
        if (!product) throw ApiError.unprocessable('An item in your cart is no longer available');
        const quantity = Math.floor(Number(r.quantity));
        if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
            throw ApiError.unprocessable(`Invalid quantity for ${product.name}`);
        }
        const variant = resolveVariant(product, r);
        const stock = availableStock(product, variant);
        if (quantity > stock) {
            throw ApiError.conflict(stock > 0
                ? `Only ${stock} left of ${product.name}${variant ? ` (${[variant.size, variant.color].filter(Boolean).join(' / ')})` : ''}`
                : `${product.name} is out of stock`);
        }
        const unitPrice = product.effectivePrice;
        lines.push({
            product,
            variant,
            quantity,
            unitPrice,
            lineTotal: roundMoney(unitPrice * quantity),
        });
    }

    // The same variant requested twice must still fit in stock.
    const totals = new Map();
    for (const l of lines) {
        const key = `${l.product._id}:${l.variant?._id || ''}`;
        totals.set(key, (totals.get(key) || 0) + l.quantity);
        if (totals.get(key) > availableStock(l.product, l.variant)) {
            throw ApiError.conflict(`Not enough stock for ${l.product.name}`);
        }
    }
    return lines;
};

const hasPreviousOrders = async ({ user, email }) => {
    const or = [];
    if (user) or.push({ user: user._id });
    if (email) or.push({ 'customer.email': String(email).toLowerCase() });
    if (!or.length) return false;
    return Boolean(await Order.exists({ $or: or, orderStatus: { $ne: 'cancelled' } }));
};

/** Returns { coupon, discount } or throws a user-facing error explaining why the code is invalid. */
export const evaluateCoupon = async (code, subtotal, { user, email } = {}) => {
    const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() });
    if (!coupon || !coupon.active) throw ApiError.unprocessable('This coupon code is not valid');
    if (coupon.expiryDate && coupon.expiryDate < new Date()) throw ApiError.unprocessable('This coupon has expired');
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
        throw ApiError.unprocessable('This coupon has reached its usage limit');
    }
    if (subtotal < coupon.minimumAmount) {
        throw ApiError.unprocessable(`Spend at least ${config.currency} ${coupon.minimumAmount.toLocaleString()} to use this coupon`);
    }
    if (coupon.firstOrderOnly && await hasPreviousOrders({ user, email })) {
        throw ApiError.unprocessable('This coupon is only valid on your first order');
    }

    let discount = coupon.type === 'percentage' ? (subtotal * coupon.value) / 100 : coupon.value;
    if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
    discount = roundMoney(Math.min(discount, subtotal));
    return { coupon, discount };
};

export const quote = async ({ items, couponCode, user, email }) => {
    const lines = await buildLines(items);
    const subtotal = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
    let discount = 0;
    let coupon = null;
    if (couponCode) {
        ({ coupon, discount } = await evaluateCoupon(couponCode, subtotal, { user, email }));
    }
    const shipping = shippingFor(subtotal - discount);
    const total = roundMoney(subtotal - discount + shipping);
    return { lines, subtotal, discount, shipping, total, coupon };
};
