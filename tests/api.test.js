// End-to-end API checks against a running server with seeded data.
//   npm run db:local   (or any MongoDB)   →   npm run seed   →   npm start   →   npm test
// Creates its own test product/customer and cleans the product up afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();
const BASE = process.env.TEST_API_URL || `http://localhost:${process.env.PORT || 5000}`;
const API = `${BASE}/api`;

const call = async (method, path, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
};

const imageBlob = async (color, format = 'jpeg') => {
    const buf = await sharp({ create: { width: 600, height: 800, channels: 3, background: color } })[format]().toBuffer();
    return new Blob([buf], { type: `image/${format}` });
};

let adminToken;
let customerToken;
let product;
let categoryId;
const uniq = Date.now().toString(36);

before(async () => {
    const admin = await call('POST', '/auth/login', { body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD } });
    assert.equal(admin.status, 200, `admin login failed: ${admin.message}`);
    adminToken = admin.data.token;
    const reg = await call('POST', '/auth/register', { body: { name: 'Test Shopper', email: `shopper-${uniq}@example.com`, password: 'Sh0pper-pass!' } });
    assert.equal(reg.status, 201, reg.message);
    customerToken = reg.data.token;
    const cats = await call('GET', '/categories');
    categoryId = cats.data.find(c => c.slug === 'shorts').id;
});

// Removes everything this run created so the store data stays clean.
after(async () => {
    const { default: mongoose } = await import('mongoose');
    const { deleteStoredImage } = await import('../services/imageService.js');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined });
    const db = mongoose.connection.db;
    const testProducts = await db.collection('products').find({ sku: /^TEST-/ }).toArray();
    const ids = testProducts.map(p => p._id);
    for (const p of testProducts) for (const img of p.images || []) await deleteStoredImage(img);
    const users = await db.collection('users').find({ email: /^(shopper|guest)-.*@example\.com$/ }).project({ _id: 1 }).toArray();
    const userIds = users.map(u => u._id);
    await Promise.all([
        db.collection('orders').deleteMany({ $or: [{ 'items.product': { $in: ids } }, { 'customer.email': /^(shopper|guest)-.*@example\.com$/ }] }),
        db.collection('reviews').deleteMany({ $or: [{ product: { $in: ids } }, { user: { $in: userIds } }] }),
        db.collection('carts').deleteMany({ user: { $in: userIds } }),
        db.collection('wishlists').deleteMany({ user: { $in: userIds } }),
        db.collection('users').deleteMany({ _id: { $in: userIds } }),
        db.collection('products').deleteMany({ _id: { $in: ids } }),
    ]);
    await mongoose.disconnect();
});

test('health and public config', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    const cfg = await call('GET', '/config');
    assert.equal(cfg.data.currency, 'LKR');
});

test('auth: me, wrong password, missing token, customer cannot use admin routes', async () => {
    const me = await call('GET', '/auth/me', { token: customerToken });
    assert.equal(me.data.role, 'customer');
    assert.equal(me.data.passwordHash, undefined);
    assert.equal((await call('POST', '/auth/login', { body: { email: process.env.SEED_ADMIN_EMAIL, password: 'nope' } })).status, 401);
    assert.equal((await call('POST', '/products', { body: { name: 'x' } })).status, 401);
    assert.equal((await call('POST', '/products', { token: customerToken, body: { name: 'x' } })).status, 403);
    assert.equal((await call('GET', '/orders', { token: customerToken })).status, 403);
    const dup = await call('POST', '/auth/register', { body: { name: 'Again', email: `shopper-${uniq}@example.com`, password: 'Sh0pper-pass!' } });
    assert.equal(dup.status, 409);
});

test('uploads: rejects non-images and wrong types', async () => {
    const form = new FormData();
    form.append('image', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
    assert.equal((await call('POST', '/uploads/product', { token: adminToken, form })).status, 422);

    const spoofed = new FormData();
    spoofed.append('image', new Blob(['<?php echo 1; ?>'], { type: 'image/jpeg' }), 'evil.jpg');
    assert.equal((await call('POST', '/uploads/product', { token: adminToken, form: spoofed })).status, 422);

    const anon = new FormData();
    anon.append('image', await imageBlob('#ff0000'), 'a.jpg');
    assert.equal((await call('POST', '/uploads/product', { form: anon })).status, 401);
});

test('ADMIN → create product → upload 3 images → storefront sees all 3', async () => {
    const form = new FormData();
    form.append('images', await imageBlob('#c8b79a', 'jpeg'), 'IMG_0001 original name.jpg');
    form.append('images', await imageBlob('#1f2a44', 'png'), 'side.png');
    form.append('images', await imageBlob('#6b6b47', 'webp'), 'back.webp');
    const up = await call('POST', '/uploads/products', { token: adminToken, form });
    assert.equal(up.status, 201, up.message);
    assert.equal(up.data.length, 3);
    for (const img of up.data) {
        assert.match(img.url, /^http:\/\/.+\/uploads\/products\/product-[0-9a-f]{8}-\d\.webp$/);
        assert.ok(!img.url.includes('IMG_0001'), 'original filename must not be used');
    }

    const created = await call('POST', '/products', {
        token: adminToken,
        body: {
            name: `Test Linen Short ${uniq}`, sku: `TEST-${uniq}`, category: categoryId, price: 4500, salePrice: 3990,
            description: 'Created by the API test', sizes: ['M', 'L'], colors: [{ name: 'Sand', hex: '#C8B79A' }],
            variants: [{ size: 'M', color: 'Sand', stock: 3 }, { size: 'L', color: 'Sand', stock: 1 }],
            images: up.data.map(i => i.url), tags: ['test'], specifications: [{ key: 'Material', value: 'Linen' }],
        },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    product = created.data;
    assert.equal(product.stock, 4);
    assert.equal(product.thumbnail, up.data[0].url);

    const list = await call('GET', `/products?search=${encodeURIComponent(`Test Linen Short ${uniq}`)}`);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].thumbnail, up.data[0].url);

    const detail = await call('GET', `/products/${product.id}`);
    assert.deepEqual(detail.data.images, up.data.map(i => i.url));
    const bySlug = await call('GET', `/products/slug/${product.slug}`);
    assert.equal(bySlug.data.id, product.id);

    for (const url of detail.data.images) {
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/webp');
    }
});

test('admin: change primary image, remove an image, deactivate hides from store', async () => {
    const third = product.images[2];
    const primary = await call('PATCH', `/products/${product.id}/thumbnail`, { token: adminToken, body: { url: third } });
    assert.equal(primary.data.thumbnail, third);
    assert.equal(primary.data.images[0], third);

    const removed = await call('DELETE', `/products/${product.id}/images`, { token: adminToken, body: { url: product.images[1] } });
    assert.equal(removed.data.images.length, 2);
    assert.equal((await fetch(product.images[1])).status, 404, 'removed file is deleted from storage');

    await call('PATCH', `/products/${product.id}/status`, { token: adminToken, body: { active: false } });
    assert.equal((await call('GET', `/products/${product.id}`)).status, 404);
    assert.equal((await call('GET', `/products/${product.id}`, { token: adminToken })).status, 200);
    await call('PATCH', `/products/${product.id}/status`, { token: adminToken, body: { active: true } });

    const bad = await call('PUT', `/products/${product.id}`, { token: adminToken, body: { salePrice: 99999 } });
    assert.equal(bad.status, 422);
});

test('catalog queries: filters, sort, pagination', async () => {
    const page = await call('GET', '/products?limit=5&page=2&sort=price-asc');
    assert.equal(page.pagination.page, 2);
    assert.equal(page.pagination.limit, 5);
    assert.ok(page.data.length <= 5);
    const prices = page.data.map(p => p.finalPrice);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

    const shorts = await call('GET', '/products?category=shorts');
    assert.ok(shorts.data.length >= 3);
    assert.ok(shorts.data.every(p => p.category.slug === 'shorts'));

    const ranged = await call('GET', '/products?minPrice=4000&maxPrice=6000');
    assert.ok(ranged.data.every(p => p.finalPrice >= 4000 && p.finalPrice <= 6000));

    const featured = await call('GET', '/products?featured=true');
    assert.ok(featured.data.length > 0 && featured.data.every(p => p.featured));

    const sale = await call('GET', '/products?onSale=true');
    assert.ok(sale.data.every(p => p.salePrice < p.price));

    const bySku = await call('GET', '/products?search=CS-PO-001');
    assert.equal(bySku.data[0].sku, 'CS-PO-001');
    const byCategoryName = await call('GET', '/products?search=trousers');
    assert.ok(byCategoryName.data.length >= 3);

    const injection = await call('GET', '/products?search[$ne]=x');
    assert.equal(injection.status, 422, 'operator objects in the query string are rejected');

    const related = await call('GET', `/products/${product.id}/related`);
    assert.ok(related.data.length > 0);
});

test('cart, wishlist and stock validation', async () => {
    const add = await call('POST', '/cart/items', { token: customerToken, body: { productId: product.id, size: 'M', color: 'Sand', quantity: 2 } });
    assert.equal(add.status, 201, add.message);
    assert.equal(add.data.items[0].unitPrice, 3990);

    const tooMany = await call('POST', '/cart/items', { token: customerToken, body: { productId: product.id, size: 'M', color: 'Sand', quantity: 5 } });
    assert.equal(tooMany.status, 409);

    const itemId = add.data.items[0].id;
    const upd = await call('PATCH', `/cart/items/${itemId}`, { token: customerToken, body: { quantity: 3 } });
    assert.equal(upd.data.items[0].quantity, 3);
    assert.equal((await call('DELETE', `/cart/items/${itemId}`, { token: customerToken })).data.items.length, 0);

    const wl = await call('POST', `/wishlist/${product.id}`, { token: customerToken });
    assert.equal(wl.data.length, 1);
    assert.equal((await call('DELETE', `/wishlist/${product.id}`, { token: customerToken })).data.length, 0);
});

test('coupons: valid, minimum amount, expired', async () => {
    const items = [{ productId: product.id, size: 'M', color: 'Sand', quantity: 2 }];
    const ok = await call('POST', '/coupons/validate', { token: customerToken, body: { code: 'cstyle10', items } });
    assert.equal(ok.status, 200, ok.message);
    assert.equal(ok.data.discount, 798);

    const min = await call('POST', '/coupons/validate', { body: { code: 'SUMMER20', items } });
    assert.equal(min.status, 422);
    const expired = await call('POST', '/coupons/validate', { body: { code: 'FLASH15', items } });
    assert.equal(expired.status, 422);
    assert.match(expired.message, /expired/);
});

test('checkout: server pricing, stock deduction, overselling blocked, cancel restores stock', async () => {
    const before = (await call('GET', `/products/${product.id}`)).data;
    const order = await call('POST', '/orders', {
        token: customerToken,
        body: {
            items: [{ productId: product.id, size: 'M', color: 'Sand', quantity: 2, price: 1 }],
            customer: { name: 'Test Shopper', email: `shopper-${uniq}@example.com`, phone: '0771234567' },
            shippingAddress: { fullName: 'Test Shopper', line1: '1 Main St', city: 'Colombo' },
            couponCode: 'NEWUSER',
        },
    });
    assert.equal(order.status, 201, order.message);
    assert.equal(order.data.subtotal, 7980, 'client-sent price is ignored');
    assert.equal(order.data.discount, 1000);
    assert.equal(order.data.total, 7980 - 1000 + 1500);
    assert.match(order.data.orderNumber, /^CS\d{6}$/);

    const after = (await call('GET', `/products/${product.id}`)).data;
    assert.equal(after.stock, before.stock - 2);

    const oversell = await call('POST', '/orders', {
        body: {
            items: [{ productId: product.id, size: 'M', color: 'Sand', quantity: 2 }],
            customer: { name: 'Guest', email: 'guest@example.com', phone: '0770000000' },
            shippingAddress: { fullName: 'Guest', line1: '2 Main St', city: 'Kandy' },
        },
    });
    assert.equal(oversell.status, 409);

    const reuse = await call('POST', '/coupons/validate', { token: customerToken, body: { code: 'NEWUSER', items: [{ productId: product.id, size: 'L', color: 'Sand', quantity: 1 }] } });
    assert.equal(reuse.status, 422, 'NEWUSER only works once');

    const mine = await call('GET', '/orders/my', { token: customerToken });
    assert.equal(mine.data[0].orderNumber, order.data.orderNumber);
    const tracked = await call('GET', `/orders/track?orderNumber=${order.data.orderNumber}&email=shopper-${uniq}@example.com`);
    assert.equal(tracked.status, 200);

    const cancelled = await call('PATCH', `/orders/${order.data.id}/cancel`, { token: customerToken });
    assert.equal(cancelled.data.orderStatus, 'cancelled');
    assert.equal((await call('GET', `/products/${product.id}`)).data.stock, before.stock);
});

test('admin orders: status transitions, dashboard numbers', async () => {
    const order = await call('POST', '/orders', {
        body: {
            items: [{ productId: product.id, size: 'L', color: 'Sand', quantity: 1 }],
            customer: { name: 'Guest Buyer', email: `guest-${uniq}@example.com`, phone: '0770000001' },
            shippingAddress: { fullName: 'Guest Buyer', line1: '3 Main St', city: 'Galle' },
        },
    });
    assert.equal(order.status, 201, order.message);
    const id = order.data.id;
    assert.equal((await call('GET', `/orders/${id}`, { token: customerToken })).status, 404, 'other customers cannot read it');

    for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
        const r = await call('PATCH', `/orders/${id}/status`, { token: adminToken, body: { orderStatus: status } });
        assert.equal(r.data.orderStatus, status);
    }
    const back = await call('PATCH', `/orders/${id}/status`, { token: adminToken, body: { orderStatus: 'processing' } });
    assert.equal(back.status, 409);

    const list = await call('GET', `/orders?search=${order.data.orderNumber}`, { token: adminToken });
    assert.equal(list.data[0].paymentStatus, 'paid');

    const dash = await call('GET', '/admin/dashboard', { token: adminToken });
    assert.ok(dash.data.totals.products >= 18);
    assert.ok(dash.data.totals.revenue > 0);
    assert.ok(Array.isArray(dash.data.recentOrders));
    assert.ok(Array.isArray(dash.data.topProducts));
    const sales = await call('GET', '/admin/sales?range=week', { token: adminToken });
    assert.ok(sales.data.length >= 7);
});

test('reviews update product rating', async () => {
    const r = await call('POST', `/products/${product.id}/reviews`, { token: customerToken, body: { rating: 4, comment: 'Nice' } });
    assert.equal(r.status, 201, r.message);
    const p = (await call('GET', `/products/${product.id}`)).data;
    assert.equal(p.ratingCount, 1);
    assert.equal(p.ratingAverage, 4);
    const list = await call('GET', `/products/${product.id}/reviews`);
    assert.equal(list.distribution[4], 1);
});

test('logout revokes the token', async () => {
    const login = await call('POST', '/auth/login', { body: { email: `shopper-${uniq}@example.com`, password: 'Sh0pper-pass!' } });
    const token = login.data.token;
    assert.equal((await call('POST', '/auth/logout', { token })).status, 200);
    assert.equal((await call('GET', '/auth/me', { token })).status, 401);
});
