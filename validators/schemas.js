import { z } from 'zod';
import { ORDER_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS } from '../models/Order.js';
import { isObjectId } from '../utils/helpers.js';

const objectId = (label = 'id') => z.string().refine(isObjectId, `Invalid ${label}`);
const trimmed = (max, label) => z.string().trim().max(max, `${label} is too long`);
const requiredText = (max, label) => trimmed(max, label).min(1, `${label} is required`);
const money = (label) => z.coerce.number({ message: `${label} must be a number` }).min(0, `${label} cannot be negative`);
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);

// ── Auth / users ─────────────────────────────────────────────
export const registerSchema = z.object({
    name: requiredText(120, 'Name'),
    email,
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    phone: trimmed(30, 'Phone').optional(),
});

export const loginSchema = z.object({
    email,
    password: z.string().min(1, 'Password is required').max(128),
});

export const addressSchema = z.object({
    label: trimmed(40, 'Label').optional(),
    fullName: requiredText(120, 'Full name'),
    phone: trimmed(30, 'Phone').optional().default(''),
    line1: requiredText(200, 'Address'),
    line2: trimmed(200, 'Address line 2').optional().default(''),
    city: requiredText(80, 'City'),
    state: trimmed(80, 'State').optional().default(''),
    postalCode: trimmed(20, 'Postal code').optional().default(''),
    country: trimmed(60, 'Country').optional().default('Sri Lanka'),
    isDefault: z.boolean().optional(),
});

export const updateProfileSchema = z.object({
    name: requiredText(120, 'Name').optional(),
    phone: trimmed(30, 'Phone').optional(),
    addresses: z.array(addressSchema).max(10).optional(),
});

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

export const adminUserUpdateSchema = z.object({
    role: z.enum(['customer', 'admin']).optional(),
    active: z.boolean().optional(),
});

export const contactSchema = z.object({
    name: requiredText(120, 'Name'),
    email,
    phone: trimmed(30, 'Phone').optional().default(''),
    subject: trimmed(160, 'Subject').optional().default(''),
    message: requiredText(4000, 'Message'),
});

export const newsletterSchema = z.object({ email });

// ── Catalog ──────────────────────────────────────────────────
export const categorySchema = z.object({
    name: requiredText(80, 'Name'),
    slug: trimmed(80, 'Slug').optional(),
    description: trimmed(1000, 'Description').optional().default(''),
    image: trimmed(500, 'Image').optional().default(''),
    active: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
});

const variantSchema = z.object({
    _id: z.string().optional(),
    sku: trimmed(60, 'Variant SKU').optional().default(''),
    size: trimmed(20, 'Size').optional().default(''),
    color: trimmed(40, 'Colour').optional().default(''),
    stock: z.coerce.number().int('Stock must be a whole number').min(0, 'Stock cannot be negative'),
});

const productBase = z.object({
    name: requiredText(160, 'Product name'),
    slug: trimmed(160, 'Slug').optional(),
    description: trimmed(5000, 'Description').optional(),
    shortDescription: trimmed(300, 'Short description').optional(),
    category: objectId('category'),
    subCategory: trimmed(80, 'Sub-category').optional(),
    gender: z.enum(['men', 'women', 'kids', 'unisex']).optional(),
    brand: trimmed(80, 'Brand').optional(),
    price: money('Price'),
    salePrice: money('Sale price').nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    sku: requiredText(60, 'SKU'),
    stock: z.coerce.number().int().min(0, 'Stock cannot be negative').optional(),
    lowStockThreshold: z.coerce.number().int().min(0).optional(),
    sizes: z.array(trimmed(20, 'Size')).max(20).optional(),
    colors: z.array(z.object({
        name: requiredText(40, 'Colour name'),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #1A2B3C').optional(),
    })).max(20).optional(),
    variants: z.array(variantSchema).max(200).optional(),
    images: z.array(trimmed(500, 'Image URL')).max(12, 'A product can have at most 12 images').optional(),
    thumbnail: trimmed(500, 'Thumbnail').optional(),
    material: trimmed(200, 'Material').optional(),
    features: z.array(trimmed(200, 'Feature')).max(20).optional(),
    specifications: z.array(z.object({ key: requiredText(60, 'Spec name'), value: requiredText(300, 'Spec value') })).max(30).optional(),
    tags: z.array(trimmed(40, 'Tag')).max(30).optional(),
    featured: z.boolean().optional(),
    newArrival: z.boolean().optional(),
    active: z.boolean().optional(),
});

const salePriceCheck = (p) => p.salePrice == null || p.price == null || p.salePrice < p.price;
const salePriceIssue = { message: 'Sale price must be lower than the regular price', path: ['salePrice'] };

export const productCreateSchema = productBase.refine(salePriceCheck, salePriceIssue);
// Updates accept any subset of fields; omitted fields are left unchanged.
export const productUpdateSchema = productBase.partial();
export const productStatusSchema = z.object({ active: z.boolean() });

export const productQuerySchema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    search: trimmed(100, 'Search').optional(),
    category: trimmed(80, 'Category').optional(),
    subCategory: trimmed(80, 'Sub-category').optional(),
    gender: z.enum(['men', 'women', 'kids', 'unisex']).optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    size: trimmed(20, 'Size').optional(),
    color: trimmed(40, 'Colour').optional(),
    tag: trimmed(40, 'Tag').optional(),
    featured: z.enum(['true', 'false']).optional(),
    newArrival: z.enum(['true', 'false']).optional(),
    onSale: z.enum(['true', 'false']).optional(),
    inStock: z.enum(['true', 'false']).optional(),
    lowStock: z.enum(['true', 'false']).optional(),
    status: z.enum(['active', 'inactive', 'deleted', 'all']).optional(),
    ids: z.string().max(2000).optional(),
    exclude: z.string().max(100).optional(),
    sort: z.enum(['newest', 'oldest', 'price-asc', 'price-desc', 'name', 'rating', 'popular', 'best-selling', 'relevance', 'stock']).optional(),
}).strip();

export const reviewSchema = z.object({
    rating: z.coerce.number().int().min(1, 'Rating must be between 1 and 5').max(5, 'Rating must be between 1 and 5'),
    title: trimmed(120, 'Title').optional().default(''),
    comment: trimmed(2000, 'Review').optional().default(''),
});

export const bannerSchema = z.object({
    title: requiredText(120, 'Title'),
    subtitle: trimmed(300, 'Subtitle').optional().default(''),
    image: requiredText(500, 'Image'),
    ctaText: trimmed(40, 'Button text').optional().default('Shop Now'),
    link: trimmed(300, 'Link').regex(/^\/(?!\/)/, 'Link must be a path on this site, like /shop').optional().default('/shop'),
    placement: z.enum(['hero', 'promo']).optional().default('hero'),
    active: z.boolean().optional().default(true),
    sortOrder: z.coerce.number().int().optional().default(0),
});

// ── Cart / wishlist / checkout ──────────────────────────────
const lineSchema = z.object({
    productId: objectId('product'),
    variantId: z.string().optional().nullable(),
    size: trimmed(20, 'Size').optional().default(''),
    color: trimmed(40, 'Colour').optional().default(''),
    quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1').max(99, 'Quantity is too large'),
});

export const cartAddSchema = lineSchema;
export const cartUpdateSchema = z.object({ quantity: z.coerce.number().int().min(1).max(99) });
export const cartMergeSchema = z.object({ items: z.array(lineSchema).max(100) });

export const couponCheckSchema = z.object({
    code: requiredText(30, 'Coupon code'),
    items: z.array(lineSchema).min(1, 'Your cart is empty').max(100),
    email: email.optional(),
});

export const quoteSchema = z.object({
    items: z.array(lineSchema).min(1, 'Your cart is empty').max(100),
    couponCode: trimmed(30, 'Coupon code').optional(),
    email: email.optional(),
});

const orderAddress = addressSchema.omit({ label: true, isDefault: true });

export const orderCreateSchema = z.object({
    items: z.array(lineSchema).min(1, 'Your cart is empty').max(100),
    customer: z.object({
        name: requiredText(120, 'Name'),
        email,
        phone: requiredText(30, 'Phone number'),
    }),
    shippingAddress: orderAddress,
    billingAddress: orderAddress.optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional().default('cod'),
    couponCode: trimmed(30, 'Coupon code').optional(),
    notes: trimmed(500, 'Notes').optional().default(''),
});

export const orderStatusSchema = z.object({
    orderStatus: z.enum(ORDER_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    note: trimmed(300, 'Note').optional().default(''),
}).refine(v => v.orderStatus || v.paymentStatus, 'Choose a status to update');

export const couponSchema = z.object({
    code: requiredText(30, 'Code').regex(/^[A-Za-z0-9_-]+$/, 'Codes can only use letters, numbers, - and _'),
    description: trimmed(200, 'Description').optional().default(''),
    type: z.enum(['percentage', 'fixed']),
    value: money('Value'),
    minimumAmount: money('Minimum amount').optional().default(0),
    maxDiscount: money('Maximum discount').nullable().optional(),
    expiryDate: z.coerce.date().nullable().optional(),
    active: z.boolean().optional().default(true),
    usageLimit: z.coerce.number().int().min(0).nullable().optional(),
    firstOrderOnly: z.boolean().optional().default(false),
}).refine(c => c.type !== 'percentage' || c.value <= 100, { message: 'Percentage coupons cannot exceed 100%', path: ['value'] });
