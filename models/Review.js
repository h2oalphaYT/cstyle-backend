import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    rating: { type: Number, required: [true, 'Rating is required'], min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 120, default: '' },
    comment: { type: String, trim: true, maxlength: 2000, default: '' },
    verifiedPurchase: { type: Boolean, default: false },
}, { timestamps: true });

reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, createdAt: -1 });

reviewSchema.statics.recalculate = async function recalculate(productId) {
    const [stats] = await this.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(String(productId)) } },
        { $group: { _id: '$product', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    await mongoose.model('Product').updateOne(
        { _id: productId },
        { ratingAverage: stats ? Math.round(stats.avg * 10) / 10 : 0, ratingCount: stats?.count || 0 },
    );
};

reviewSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
    },
});

const Review = mongoose.model('Review', reviewSchema);
export default Review;
