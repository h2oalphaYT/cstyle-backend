import mongoose from 'mongoose';
import { toPublicUrl } from '../utils/imageUrl.js';

export const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded'];
export const PAYMENT_METHODS = ['cod', 'bank_transfer'];

const orderItemSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, required: true },
    sku: { type: String, default: '' },
    image: { type: String, default: '' },
    size: { type: String, default: '' },
    color: { type: String, default: '' },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
}, { _id: true });

const addressSchema = new mongoose.Schema({
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, trim: true, default: '' },
    city: { type: String, required: true, trim: true },
    state: { type: String, trim: true, default: '' },
    postalCode: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: 'Sri Lanka' },
}, { _id: false });

const statusEventSchema = new mongoose.Schema({
    status: { type: String, enum: ORDER_STATUSES, required: true },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { _id: false });

const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    customer: {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        phone: { type: String, trim: true, default: '' },
    },
    items: {
        type: [orderItemSchema],
        validate: [v => v.length > 0, 'An order needs at least one item'],
    },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    shipping: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'LKR' },
    coupon: {
        code: { type: String, default: '' },
        type: { type: String, default: '' },
        value: { type: Number, default: 0 },
    },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'cod' },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'pending' },
    orderStatus: { type: String, enum: ORDER_STATUSES, default: 'pending' },
    statusHistory: [statusEventSchema],
    shippingAddress: { type: addressSchema, required: true },
    billingAddress: { type: addressSchema, required: true },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    // True while the ordered quantities are deducted from product stock.
    stockReserved: { type: Boolean, default: true },
}, { timestamps: true });

orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ 'customer.email': 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

orderSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        ret.items = (ret.items || []).map(i => ({ ...i, image: toPublicUrl(i.image) }));
        delete ret.__v;
        return ret;
    },
});

const Order = mongoose.model('Order', orderSchema);
export default Order;
