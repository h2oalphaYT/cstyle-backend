import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema({
    code: { type: String, required: [true, 'Coupon code is required'], unique: true, uppercase: true, trim: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: [0, 'Value cannot be negative'] },
    minimumAmount: { type: Number, min: 0, default: 0 },
    maxDiscount: { type: Number, min: 0, default: null },
    expiryDate: { type: Date, default: null },
    active: { type: Boolean, default: true },
    usageLimit: { type: Number, min: 0, default: null },
    usedCount: { type: Number, min: 0, default: 0 },
    firstOrderOnly: { type: Boolean, default: false },
}, { timestamps: true });

couponSchema.path('value').validate(function validPercent(v) {
    return this.type !== 'percentage' || v <= 100;
}, 'Percentage coupons cannot exceed 100%');

couponSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
    },
});

const Coupon = mongoose.model('Coupon', couponSchema);
export default Coupon;
