import mongoose from 'mongoose';

const productImageDetailSchema = new mongoose.Schema({
    productCode: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        index: true
    },
    imageUrl: {
        type: String,
        required: true,
        trim: true
    },
    imageOrder: {
        type: Number,
        default: 0,
        min: 0
    },
    altText: {
        type: String,
        trim: true
    },
    isPrimary: {
        type: Boolean,
        default: false
    },
    imageType: {
        type: String,
        enum: ['product', 'variant', 'detail', 'lifestyle'],
        default: 'product'
    }
}, {
    timestamps: true
});

// Compound index for product code and image order
productImageDetailSchema.index({ productCode: 1, imageOrder: 1 });
productImageDetailSchema.index({ productCode: 1, isPrimary: -1 });

// Ensure only one primary image per product
productImageDetailSchema.pre('save', async function(next) {
    if (this.isPrimary) {
        await mongoose.model('ProductImageDetail').updateMany(
            { 
                productCode: this.productCode, 
                _id: { $ne: this._id } 
            },
            { $set: { isPrimary: false } }
        );
    }
    next();
});

const ProductImageDetail = mongoose.model('ProductImageDetail', productImageDetailSchema);

export default ProductImageDetail;
