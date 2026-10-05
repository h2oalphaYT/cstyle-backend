import mongoose from 'mongoose';

// Messages sent from the storefront contact form.
const contactMessageSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    subject: { type: String, trim: true, maxlength: 160, default: '' },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    handled: { type: Boolean, default: false },
}, { timestamps: true });
contactMessageSchema.index({ createdAt: -1 });

const subscriberSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 160 },
}, { timestamps: true });

const transform = { transform: (doc, ret) => { ret.id = String(ret._id); delete ret.__v; return ret; } };
contactMessageSchema.set('toJSON', transform);
subscriberSchema.set('toJSON', transform);

export const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);
export const Subscriber = mongoose.model('Subscriber', subscriberSchema);
