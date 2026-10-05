import express from 'express';
import rateLimit from 'express-rate-limit';
import config from '../config/env.js';
import { adminOnly, optionalAuth, protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as s from '../validators/schemas.js';
import * as auth from '../controllers/authController.js';
import * as products from '../controllers/productController.js';
import * as catalog from '../controllers/catalogController.js';
import * as reviews from '../controllers/reviewController.js';
import * as uploads from '../controllers/uploadController.js';
import * as cart from '../controllers/cartController.js';
import * as orders from '../controllers/orderController.js';
import * as admin from '../controllers/adminController.js';
import * as inbox from '../controllers/inboxController.js';
import { uploadMiddleware } from '../services/imageService.js';

const router = express.Router();

const limiter = (windowMinutes, prodLimit, message) => rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: config.isProduction ? prodLimit : prodLimit * 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message },
});

// Brute-force protection for credential endpoints, and a softer limit on checkout.
const authLimiter = limiter(15, 20, 'Too many attempts. Please try again in a few minutes.');
const checkoutLimiter = limiter(10, 60, 'Too many requests. Please slow down.');

// ── Public store settings ───────────────────────────────────
router.get('/config', (req, res) => {
    res.json({
        success: true,
        data: {
            currency: config.currency,
            shippingFee: config.shippingFee,
            freeShippingThreshold: config.freeShippingThreshold,
            maxUploadSize: config.maxFileSize,
            paymentMethods: ['cod', 'bank_transfer'],
        },
    });
});

// ── Auth ────────────────────────────────────────────────────
router.post('/auth/register', authLimiter, validate(s.registerSchema), auth.register);
router.post('/auth/login', authLimiter, validate(s.loginSchema), auth.login);
router.post('/auth/logout', protect, auth.logout);
router.get('/auth/me', protect, auth.me);
router.put('/auth/me', protect, validate(s.updateProfileSchema), auth.updateMe);
router.put('/auth/password', authLimiter, protect, validate(s.changePasswordSchema), auth.changePassword);

// ── Products ────────────────────────────────────────────────
router.get('/products', optionalAuth, validate(s.productQuerySchema, 'query'), products.listProducts);
router.get('/products/suggestions', products.suggestions);
router.get('/products/slug/:slug', optionalAuth, products.getProductBySlug);
router.get('/products/:id', optionalAuth, products.getProduct);
router.get('/products/:id/related', products.relatedProducts);
router.post('/products/:id/view', optionalAuth, products.recordView);
router.get('/products/:id/reviews', reviews.listReviews);
router.post('/products/:id/reviews', protect, validate(s.reviewSchema), reviews.upsertReview);
router.delete('/reviews/:reviewId', protect, reviews.deleteReview);

router.post('/products', ...adminOnly, validate(s.productCreateSchema), products.createProduct);
router.put('/products/:id', ...adminOnly, validate(s.productUpdateSchema), products.updateProduct);
router.patch('/products/:id/status', ...adminOnly, validate(s.productStatusSchema), products.setProductStatus);
router.patch('/products/:id/restore', ...adminOnly, products.restoreProduct);
router.patch('/products/:id/thumbnail', ...adminOnly, products.setThumbnail);
router.delete('/products/:id/images', ...adminOnly, products.removeProductImage);
router.delete('/products/:id', ...adminOnly, products.deleteProduct);

// ── Categories & banners ────────────────────────────────────
router.get('/categories', optionalAuth, catalog.listCategories);
router.get('/categories/:id', optionalAuth, catalog.getCategory);
router.post('/categories', ...adminOnly, validate(s.categorySchema), catalog.createCategory);
router.put('/categories/:id', ...adminOnly, validate(s.categorySchema), catalog.updateCategory);
router.delete('/categories/:id', ...adminOnly, catalog.deleteCategory);

router.get('/banners', optionalAuth, catalog.listBanners);
router.post('/banners', ...adminOnly, validate(s.bannerSchema), catalog.createBanner);
router.put('/banners/:id', ...adminOnly, validate(s.bannerSchema), catalog.updateBanner);
router.delete('/banners/:id', ...adminOnly, catalog.deleteBanner);

// ── Uploads (admin) ─────────────────────────────────────────
router.post('/uploads/product', ...adminOnly, uploadMiddleware.single('image'), uploads.uploadProductImage);
router.post('/uploads/products', ...adminOnly, uploadMiddleware.array('images', 10), uploads.uploadProductImages);
router.post('/uploads/category', ...adminOnly, uploadMiddleware.single('image'), uploads.uploadCategoryImage);
router.post('/uploads/banner', ...adminOnly, uploadMiddleware.single('image'), uploads.uploadBannerImage);

// ── Cart & wishlist (logged-in shoppers; guests keep them in the browser) ──
router.get('/cart', protect, cart.getCart);
router.post('/cart/items', protect, validate(s.cartAddSchema), cart.addToCart);
router.patch('/cart/items/:itemId', protect, validate(s.cartUpdateSchema), cart.updateCartItem);
router.delete('/cart/items/:itemId', protect, cart.removeCartItem);
router.delete('/cart', protect, cart.clearCart);
router.post('/cart/merge', protect, validate(s.cartMergeSchema), cart.mergeCart);

router.get('/wishlist', protect, cart.getWishlist);
router.post('/wishlist/merge', protect, cart.mergeWishlist);
router.post('/wishlist/:productId', protect, cart.addToWishlist);
router.delete('/wishlist/:productId', protect, cart.removeFromWishlist);

router.get('/users/me/recently-viewed', protect, admin.recentlyViewed);

// ── Coupons ─────────────────────────────────────────────────
router.get('/coupons/public', admin.publicCoupons);
router.post('/coupons/validate', checkoutLimiter, optionalAuth, validate(s.couponCheckSchema), orders.validateCoupon);
router.get('/coupons', ...adminOnly, admin.listCoupons);
router.post('/coupons', ...adminOnly, validate(s.couponSchema), admin.createCoupon);
router.put('/coupons/:id', ...adminOnly, validate(s.couponSchema), admin.updateCoupon);
router.delete('/coupons/:id', ...adminOnly, admin.deleteCoupon);

// ── Orders ──────────────────────────────────────────────────
// Placing an order is open to guests and customers; prices are always computed server-side.
router.post('/orders/quote', checkoutLimiter, optionalAuth, validate(s.quoteSchema), orders.quoteOrder);
router.post('/orders', checkoutLimiter, optionalAuth, validate(s.orderCreateSchema), orders.createOrder);
router.get('/orders/my', protect, orders.myOrders);
router.get('/orders/track', checkoutLimiter, orders.trackOrder);
router.get('/orders', ...adminOnly, orders.listOrders);
router.get('/orders/:id', protect, orders.getOrder);
router.patch('/orders/:id/cancel', protect, orders.cancelMyOrder);
router.patch('/orders/:id/status', ...adminOnly, validate(s.orderStatusSchema), orders.updateOrderStatus);

// ── Contact form & newsletter ───────────────────────────────
router.post('/contact', checkoutLimiter, validate(s.contactSchema), inbox.sendContactMessage);
router.post('/newsletter', checkoutLimiter, validate(s.newsletterSchema), inbox.subscribe);
router.get('/admin/messages', ...adminOnly, inbox.listMessages);
router.patch('/admin/messages/:id', ...adminOnly, inbox.markMessage);

// ── Admin dashboard & customers ─────────────────────────────
router.get('/admin/dashboard', ...adminOnly, admin.dashboard);
router.get('/admin/sales', ...adminOnly, admin.salesSeries);
router.get('/admin/customers', ...adminOnly, admin.listCustomers);
router.patch('/admin/customers/:id', ...adminOnly, validate(s.adminUserUpdateSchema), admin.updateCustomer);

export default router;
