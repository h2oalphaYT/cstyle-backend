import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const addressSchema = new mongoose.Schema({
    label: { type: String, trim: true, maxlength: 40, default: 'Home' },
    fullName: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    line1: { type: String, trim: true, maxlength: 200, required: true },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 80, required: true },
    state: { type: String, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, maxlength: 60, default: 'Sri Lanka' },
    isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email is invalid'],
    },
    passwordHash: { type: String, required: true, select: false },
    phone: { type: String, trim: true, maxlength: 30 },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer', index: true },
    addresses: [addressSchema],
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, select: false },
    lastLoginAt: Date,
    recentlyViewed: [{
        _id: false,
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        viewedAt: { type: Date, default: Date.now },
    }],
}, { timestamps: true });

userSchema.methods.setPassword = async function setPassword(password) {
    this.passwordHash = await bcrypt.hash(password, 12);
};

userSchema.methods.checkPassword = function checkPassword(password) {
    return bcrypt.compare(password, this.passwordHash || '');
};

userSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = String(ret._id);
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.recentlyViewed;
        delete ret.__v;
        return ret;
    },
});

const User = mongoose.model('User', userSchema);
export default User;
