import mongoose from 'mongoose';
import Review from '../models/Review.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler, isObjectId, paginationMeta, parsePagination } from '../utils/helpers.js';

const assertProduct = async (id) => {
    if (!isObjectId(id)) throw ApiError.badRequest('Invalid product id');
    if (!(await Product.exists({ _id: id, isDeleted: false }))) throw ApiError.notFound('Product not found');
};

// GET /api/products/:id/reviews
export const listReviews = asyncHandler(async (req, res) => {
    await assertProduct(req.params.id);
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = { product: req.params.id };
    const [reviews, total, breakdown] = await Promise.all([
        Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        Review.countDocuments(filter),
        Review.aggregate([
            { $match: { product: new mongoose.Types.ObjectId(req.params.id) } },
            { $group: { _id: '$rating', count: { $sum: 1 } } },
        ]),
    ]);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    breakdown.forEach(b => { distribution[b._id] = b.count; });
    res.json({ success: true, data: reviews, distribution, pagination: paginationMeta(page, limit, total) });
});

// POST /api/products/:id/reviews — one review per customer per product; posting again updates it.
export const upsertReview = asyncHandler(async (req, res) => {
    await assertProduct(req.params.id);
    const verifiedPurchase = Boolean(await Order.exists({
        user: req.user._id,
        'items.product': req.params.id,
        orderStatus: 'delivered',
    }));
    const review = await Review.findOneAndUpdate(
        { product: req.params.id, user: req.user._id },
        { ...req.body, name: req.user.name, verifiedPurchase },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    await Review.recalculate(req.params.id);
    res.status(201).json({ success: true, message: 'Thanks for your review!', data: review });
});

// DELETE /api/reviews/:reviewId — author or admin
export const deleteReview = asyncHandler(async (req, res) => {
    const review = await Review.findById(req.params.reviewId);
    if (!review) throw ApiError.notFound('Review not found');
    if (String(review.user) !== String(req.user._id) && req.user.role !== 'admin') throw ApiError.forbidden();
    await review.deleteOne();
    await Review.recalculate(review.product);
    res.json({ success: true, message: 'Review deleted' });
});
