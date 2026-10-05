import Cart from '../models/Cart.js';
import Product from '../models/Product.js';
import Wishlist from '../models/Wishlist.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import { asyncHandler, isObjectId, roundMoney } from '../utils/helpers.js';
import { availableStock, resolveVariant, shippingFor } from '../services/pricingService.js';
import { toPublicUrl } from '../utils/imageUrl.js';

const getOrCreateCart = async (userId) =>
    (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });

// Shapes the cart with live prices and stock so the UI never shows stale numbers.
const presentCart = async (cart) => {
    const ids = cart.items.map(i => i.product);
    const products = await Product.find({ _id: { $in: ids } });
    const byId = new Map(products.map(p => [String(p._id), p]));

    const items = cart.items.map((item) => {
        const product = byId.get(String(item.product));
        const purchasable = product && product.active && !product.isDeleted;
        const variant = purchasable && item.variant ? product.variants.id(item.variant) : null;
        const stock = purchasable ? availableStock(product, variant) : 0;
        const unitPrice = purchasable ? product.effectivePrice : item.price;
        return {
            id: String(item._id),
            productId: String(item.product),
            variantId: item.variant ? String(item.variant) : null,
            name: product?.name || 'Unavailable product',
            slug: product?.slug || '',
            image: toPublicUrl(product?.thumbnail || product?.images?.[0] || ''),
            size: item.size,
            color: item.color,
            quantity: item.quantity,
            unitPrice,
            originalPrice: purchasable ? product.price : item.price,
            lineTotal: roundMoney(unitPrice * item.quantity),
            stock,
            available: Boolean(purchasable && stock >= item.quantity),
        };
    });
    const subtotal = roundMoney(items.filter(i => i.available).reduce((s, i) => s + i.lineTotal, 0));
    return {
        items,
        itemCount: items.reduce((s, i) => s + i.quantity, 0),
        subtotal,
        shipping: shippingFor(subtotal),
        freeShippingThreshold: config.freeShippingThreshold,
        currency: config.currency,
    };
};

const loadPurchasable = async (productId) => {
    if (!isObjectId(productId)) throw ApiError.badRequest('Invalid product');
    const product = await Product.findOne({ _id: productId, isDeleted: false, active: true });
    if (!product) throw ApiError.notFound('This product is no longer available');
    return product;
};

// Adds quantity to a cart line (or creates it), never exceeding stock.
const addLine = (cart, product, variant, { size, color, quantity }, { clampToStock = false } = {}) => {
    const stock = availableStock(product, variant);
    const existing = cart.items.find(i =>
        String(i.product) === String(product._id) && String(i.variant || '') === String(variant?._id || ''));
    const wanted = (existing?.quantity || 0) + quantity;
    if (wanted > stock) {
        if (!clampToStock) {
            throw ApiError.conflict(stock > 0 ? `Only ${stock} available for ${product.name}` : `${product.name} is out of stock`);
        }
        if (stock <= (existing?.quantity || 0)) return;
    }
    const finalQty = Math.min(wanted, stock, 99);
    if (existing) {
        existing.quantity = finalQty;
        existing.price = product.effectivePrice;
    } else if (finalQty > 0) {
        cart.items.push({
            product: product._id,
            variant: variant?._id || null,
            size: variant?.size || size || '',
            color: variant?.color || color || '',
            quantity: finalQty,
            price: product.effectivePrice,
        });
    }
};

// GET /api/cart
export const getCart = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    res.json({ success: true, data: await presentCart(cart) });
});

// POST /api/cart/items
export const addToCart = asyncHandler(async (req, res) => {
    const product = await loadPurchasable(req.body.productId);
    const variant = resolveVariant(product, req.body);
    const cart = await getOrCreateCart(req.user._id);
    addLine(cart, product, variant, req.body);
    await cart.save();
    res.status(201).json({ success: true, message: `${product.name} added to your cart`, data: await presentCart(cart) });
});

// PATCH /api/cart/items/:itemId
export const updateCartItem = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    const item = cart.items.id(req.params.itemId);
    if (!item) throw ApiError.notFound('Cart item not found');
    const product = await loadPurchasable(item.product);
    const variant = item.variant ? product.variants.id(item.variant) : null;
    const stock = availableStock(product, variant);
    if (req.body.quantity > stock) throw ApiError.conflict(`Only ${stock} available for ${product.name}`);
    item.quantity = req.body.quantity;
    item.price = product.effectivePrice;
    await cart.save();
    res.json({ success: true, data: await presentCart(cart) });
});

// DELETE /api/cart/items/:itemId
export const removeCartItem = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    const item = cart.items.id(req.params.itemId);
    if (!item) throw ApiError.notFound('Cart item not found');
    item.deleteOne();
    await cart.save();
    res.json({ success: true, data: await presentCart(cart) });
});

// DELETE /api/cart
export const clearCart = asyncHandler(async (req, res) => {
    await Cart.updateOne({ user: req.user._id }, { items: [] });
    const cart = await getOrCreateCart(req.user._id);
    res.json({ success: true, data: await presentCart(cart) });
});

// POST /api/cart/merge — moves a guest's browser cart into the account after login.
export const mergeCart = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    for (const line of req.body.items) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const product = await loadPurchasable(line.productId);
            const variant = resolveVariant(product, line);
            addLine(cart, product, variant, line, { clampToStock: true });
        } catch {
            // Skip items that are no longer purchasable.
        }
    }
    await cart.save();
    res.json({ success: true, data: await presentCart(cart) });
});

// ── Wishlist ───────────────────────────────────────────────────

const presentWishlist = async (userId) => {
    const wishlist = await Wishlist.findOne({ user: userId }).populate({
        path: 'products',
        match: { isDeleted: false, active: true },
        populate: { path: 'category', select: 'name slug' },
    });
    return wishlist?.products?.filter(Boolean) || [];
};

// GET /api/wishlist
export const getWishlist = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await presentWishlist(req.user._id) });
});

// POST /api/wishlist/:productId
export const addToWishlist = asyncHandler(async (req, res) => {
    await loadPurchasable(req.params.productId);
    await Wishlist.updateOne({ user: req.user._id }, { $addToSet: { products: req.params.productId } }, { upsert: true });
    res.status(201).json({ success: true, message: 'Saved to your wishlist', data: await presentWishlist(req.user._id) });
});

// DELETE /api/wishlist/:productId
export const removeFromWishlist = asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.productId)) throw ApiError.badRequest('Invalid product');
    await Wishlist.updateOne({ user: req.user._id }, { $pull: { products: req.params.productId } });
    res.json({ success: true, message: 'Removed from your wishlist', data: await presentWishlist(req.user._id) });
});

// POST /api/wishlist/merge  { productIds }
export const mergeWishlist = asyncHandler(async (req, res) => {
    const ids = (Array.isArray(req.body?.productIds) ? req.body.productIds : []).filter(isObjectId).slice(0, 100);
    const valid = await Product.find({ _id: { $in: ids }, isDeleted: false, active: true }).select('_id');
    if (valid.length) {
        await Wishlist.updateOne(
            { user: req.user._id },
            { $addToSet: { products: { $each: valid.map(p => p._id) } } },
            { upsert: true },
        );
    }
    res.json({ success: true, data: await presentWishlist(req.user._id) });
});
