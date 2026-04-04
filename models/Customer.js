import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String
    },
    avatar: {
        type: String
    },
    address: {
        street: String,
        city: String,
        state: String,
        zipCode: String,
        country: String
    },
    totalOrders: {
        type: Number,
        default: 0
    },
    totalSpent: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'blocked'],
        default: 'active'
    },
    lastOrderDate: {
        type: Date
    },
    tags: [{
        type: String
    }]
}, {
    timestamps: true
});

// Index for faster queries
customerSchema.index({ email: 1 });
customerSchema.index({ status: 1 });
customerSchema.index({ name: 'text', email: 'text' });

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
