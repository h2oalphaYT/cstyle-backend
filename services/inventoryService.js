import Product from '../models/Product.js';
import ApiError from '../utils/ApiError.js';

// Atomically subtracts one line's quantity. The filter only matches when enough stock is left,
// so two shoppers can never buy the last item twice.
const decrement = (productId, variantId, qty) => {
    if (variantId) {
        return Product.updateOne(
            { _id: productId, variants: { $elemMatch: { _id: variantId, stock: { $gte: qty } } } },
            { $inc: { 'variants.$.stock': -qty, stock: -qty, soldCount: qty } },
        );
    }
    return Product.updateOne(
        { _id: productId, stock: { $gte: qty } },
        { $inc: { stock: -qty, soldCount: qty } },
    );
};

const increment = (productId, variantId, qty) => {
    if (variantId) {
        return Product.updateOne(
            { _id: productId, 'variants._id': variantId },
            { $inc: { 'variants.$.stock': qty, stock: qty, soldCount: -qty } },
        );
    }
    return Product.updateOne({ _id: productId }, { $inc: { stock: qty, soldCount: -qty } });
};

/**
 * Deducts stock for every line, or none of them. Uses compensating updates instead of a
 * transaction so it also works on standalone MongoDB servers.
 */
export const reserveStock = async (lines) => {
    const done = [];
    for (const line of lines) {
        const res = await decrement(line.productId, line.variantId, line.quantity);
        if (res.modifiedCount !== 1) {
            await Promise.all(done.map(d => increment(d.productId, d.variantId, d.quantity)));
            throw ApiError.conflict(`Sorry, ${line.name} just sold out in the quantity you chose`);
        }
        done.push(line);
    }
};

export const releaseStock = async (lines) => {
    await Promise.all(lines.map(l => increment(l.productId, l.variantId, l.quantity)));
};
