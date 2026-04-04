import mongoose from 'mongoose';

const colorVariantSchema = new mongoose.Schema({
    color: { type: String, required: true },
    colorCode: { type: String, required: true },
    colorName: { type: String, required: true }
}, { _id: false });

const variantStockSchema = new mongoose.Schema({
    color: { type: String, required: true },
    colorCode: { type: String, required: true },
    size: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0, default: 0 }
}, { _id: false });

const productSchema = new mongoose.Schema({
    productCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: ''
    },
    category: {
        type: String,
        required: true,
        enum: ['Men', 'Women', 'Kids']
    },
    subcategory: {
        type: String,
        trim: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    originalPrice: {
        type: Number,
        min: 0
    },
    discount: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    primaryImage: {
        type: String,
        required: true
    },
    colors: [colorVariantSchema],
    sizes: [{
        type: String,
        trim: true
    }],
    variantStock: [variantStockSchema],
    totalStock: {
        type: Number,
        default: 0,
        min: 0
    },
    lowStockThreshold: {
        type: Number,
        default: 20,
        min: 0
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    features: [{
        type: String,
        trim: true
    }],
    material: {
        type: String,
        trim: true
    },
    rating: {
        type: Number,
        default: 0,
        min: 0,
        max: 5
    },
    reviews: {
        type: Number,
        default: 0,
        min: 0
    },
    inStock: {
        type: Boolean,
        default: true
    },
    newArrival: {
        type: Boolean,
        default: false
    },
    isFeatured: {
        type: Boolean,
        default: false
    },
    isTrending: {
        type: Boolean,
        default: false
    },
    bDelete: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for product images
productSchema.virtual('images', {
    ref: 'ProductImageDetail',
    localField: 'productCode',
    foreignField: 'productCode'
});

// Calculate discounted price
productSchema.virtual('finalPrice').get(function() {
    if (this.discount > 0) {
        return this.price - (this.price * this.discount / 100);
    }
    return this.price;
});

// Calculate stock status
productSchema.virtual('stockStatus').get(function() {
    if (this.totalStock === 0) return 'out_of_stock';
    if (this.totalStock <= this.lowStockThreshold) return 'low_stock';
    return 'in_stock';
});

// Pre-save middleware to calculate total stock from variants
productSchema.pre('save', function(next) {
    if (this.variantStock && this.variantStock.length > 0) {
        this.totalStock = this.variantStock.reduce((sum, variant) => sum + variant.quantity, 0);
    }
    this.inStock = this.totalStock > 0;
    next();
});

// Index for faster queries
productSchema.index({ productCode: 1 });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ name: 'text', description: 'text' });

const Product = mongoose.model('Product', productSchema);

export default Product;
