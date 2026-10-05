import mongoose from 'mongoose';
import { toPublicUrl } from '../utils/imageUrl.js';

const bannerSchema = new mongoose.Schema({
    title: { type: String, required: [true, 'Banner title is required'], trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 300, default: '' },
    image: { type: String, required: [true, 'Banner image is required'] },
    ctaText: { type: String, trim: true, maxlength: 40, default: 'Shop Now' },
    link: { type: String, trim: true, maxlength: 300, default: '/shop' },
    placement: { type: String, enum: ['hero', 'promo'], default: 'hero' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

bannerSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        ret.image = toPublicUrl(ret.image);
        delete ret.__v;
        return ret;
    },
});

const Banner = mongoose.model('Banner', bannerSchema);
export default Banner;
