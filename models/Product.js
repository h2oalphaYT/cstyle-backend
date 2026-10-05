import mongoose from 'mongoose';
import { toPublicUrl } from '../utils/imageUrl.js';
import { slugify } from '../utils/helpers.js';

const colorSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 40 },
    hex: { type: String, trim: true, match: [/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #1A2B3C'], default: '#888888' },
}, { _id: false });

const variantSchema = new mongoose.Schema({
    sku: { type: String, trim: true, uppercase: true, maxlength: 60 },
    size: { type: String, trim: true, maxlength: 20, default: '' },
    color: { type: String, trim: true, maxlength: 40, default: '' },
    stock: { type: Number, min: [0, 'Stock cannot be negative'], default: 0 },
});

const specSchema = new mongoose.Schema({
    key: { type: String, required: true, trim: true, maxlength: 60 },
    value: { type: String, required: true, trim: true, maxlength: 300 },
}, { _id: false });

const productSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    shortDescription: { type: String, trim: true, maxlength: 300, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: [true, 'Category is required'] },
    subCategory: { type: String, trim: true, maxlength: 80, default: '' },
    gender: { type: String, enum: ['men', 'women', 'kids', 'unisex'], default: 'men' },
    brand: { type: String, trim: true, maxlength: 80, default: 'CStyle' },
    price: { type: Number, required: [true, 'Price is required'], min: [0, 'Price cannot be negative'] },
    salePrice: {
        type: Number,
        min: [0, 'Sale price cannot be negative'],
        default: null,
        validate: {
            validator(v) { return v == null || v < this.price; },
            message: 'Sale price must be lower than the regular price',
        },
    },
    currency: { type: String, default: 'LKR', uppercase: true, maxlength: 3 },
    sku: { type: String, required: [true, 'SKU is required'], unique: true, uppercase: true, trim: true, maxlength: 60 },
    // Price shoppers pay (salePrice when on sale). Stored so it can be filtered, sorted and indexed.
    finalPrice: { type: Number, min: 0, default: 0 },
    stock: { type: Number, min: 0, default: 0 },
    lowStockThreshold: { type: Number, min: 0, default: 10 },
    sizes: [{ type: String, trim: true, maxlength: 20 }],
    colors: [colorSchema],
    variants: [variantSchema],
    images: [{ type: String, trim: true }],
    thumbnail: { type: String, trim: true, default: '' },
    material: { type: String, trim: true, maxlength: 200, default: '' },
    features: [{ type: String, trim: true, maxlength: 200 }],
    specifications: [specSchema],
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
    featured: { type: Boolean, default: false },
    newArrival: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    soldCount: { type: Number, default: 0, min: 0 },
    viewCount: { type: Number, default: 0, min: 0 },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
}, { timestamps: true });

const computeFinalPrice = (doc) => (doc.salePrice != null && doc.salePrice < doc.price ? doc.salePrice : doc.price);

productSchema.virtual('effectivePrice').get(function effectivePrice() {
    return computeFinalPrice(this);
});

productSchema.virtual('onSale').get(function onSale() {
    return this.salePrice != null && this.salePrice < this.price;
});

productSchema.virtual('discountPercent').get(function discountPercent() {
    if (this.salePrice == null || this.salePrice >= this.price || !this.price) return 0;
    return Math.round(((this.price - this.salePrice) / this.price) * 100);
});

productSchema.virtual('stockStatus').get(function stockStatus() {
    if (this.stock <= 0) return 'out_of_stock';
    if (this.stock <= this.lowStockThreshold) return 'low_stock';
    return 'in_stock';
});

productSchema.pre('validate', function syncDerivedFields(next) {
    if (!this.slug && this.name) this.slug = slugify(this.name);
    if (this.price != null) this.finalPrice = computeFinalPrice(this);
    if (this.variants?.length) {
        this.stock = this.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
        // Keep size/color option lists consistent with the variant matrix.
        const sizes = [...new Set(this.variants.map(v => v.size).filter(Boolean))];
        if (sizes.length && !this.sizes?.length) this.sizes = sizes;
    }
    if (this.images?.length && (!this.thumbnail || !this.images.includes(this.thumbnail))) {
        this.thumbnail = this.images[0];
    }
    // The primary image always comes first in the gallery.
    if (this.thumbnail && this.images?.[0] !== this.thumbnail && this.images.includes(this.thumbnail)) {
        this.images = [this.thumbnail, ...this.images.filter(p => p !== this.thumbnail)];
    }
    if (!this.images?.length && this.thumbnail) this.images = [this.thumbnail];
    next();
});

productSchema.index({ isDeleted: 1, active: 1, createdAt: -1 });
productSchema.index({ category: 1, isDeleted: 1, active: 1 });
productSchema.index({ featured: 1, isDeleted: 1, active: 1 });
productSchema.index({ finalPrice: 1 });
productSchema.index({ soldCount: -1 });
productSchema.index({ viewCount: -1 });
productSchema.index({ tags: 1 });
productSchema.index(
    { name: 'text', sku: 'text', tags: 'text', description: 'text', subCategory: 'text' },
    { weights: { name: 10, sku: 8, tags: 5, subCategory: 3, description: 1 }, name: 'product_text' },
);

productSchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        ret.images = (ret.images || []).map(toPublicUrl);
        ret.thumbnail = toPublicUrl(ret.thumbnail || doc.images?.[0] || '');
        delete ret.__v;
        return ret;
    },
});

const Product = mongoose.model('Product', productSchema);
export default Product;
