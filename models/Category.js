import mongoose from 'mongoose';
import { toPublicUrl } from '../utils/imageUrl.js';

const categorySchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Category name is required'], trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    image: { type: String, default: '' },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

categorySchema.set('toJSON', {
    virtuals: true,
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        ret.image = toPublicUrl(ret.image);
        delete ret.__v;
        return ret;
    },
});

const Category = mongoose.model('Category', categorySchema);
export default Category;
