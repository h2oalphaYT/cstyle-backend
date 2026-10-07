/* eslint-disable no-console, no-await-in-loop */
// Seeds categories, products (with generated images), coupons, banners, an admin, a sample customer
// and a few sample orders. Safe to run repeatedly: records are matched by slug / SKU / code / email
// and only created when missing. `npm run seed:fresh` wipes the catalog first (refused in production).
import sharp from 'sharp';
import config, { assertConfig } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/database.js';
import { ensureUploadDirs, processAndStoreImage } from '../services/imageService.js';
import { garmentSvg, sceneSvg } from './sampleImages.js';
import User from '../models/User.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import Coupon from '../models/Coupon.js';
import Banner from '../models/Banner.js';
import Order from '../models/Order.js';
import Cart from '../models/Cart.js';
import Wishlist from '../models/Wishlist.js';
import Review from '../models/Review.js';
import Counter from '../models/Counter.js';
import { reserveStock } from '../services/inventoryService.js';

const fresh = process.argv.includes('--fresh');
const adminOnly = process.argv.includes('--admin-only');

const C = {
    white: { name: 'White', hex: '#F2F0EB' },
    black: { name: 'Black', hex: '#1C1C1C' },
    navy: { name: 'Navy', hex: '#1F2A44' },
    sand: { name: 'Sand', hex: '#C8B79A' },
    olive: { name: 'Olive', hex: '#6B6B47' },
    charcoal: { name: 'Charcoal', hex: '#3A3A3A' },
    stone: { name: 'Stone', hex: '#B9B2A5' },
    sky: { name: 'Sky Blue', hex: '#8FB3D9' },
    khaki: { name: 'Khaki', hex: '#BFA77A' },
    lightBlue: { name: 'Light Blue', hex: '#A9C4E0' },
    pink: { name: 'Pink', hex: '#E8B9C0' },
    terracotta: { name: 'Terracotta', hex: '#B5603F' },
    sage: { name: 'Sage', hex: '#9CAF88' },
    beige: { name: 'Beige', hex: '#D9CBB0' },
    blush: { name: 'Blush', hex: '#E3B7A8' },
    green: { name: 'Bottle Green', hex: '#2F5233' },
    burgundy: { name: 'Burgundy', hex: '#6D2E3A' },
    cream: { name: 'Cream', hex: '#EFE6D2' },
    brown: { name: 'Brown', hex: '#6B4A35' },
    grey: { name: 'Grey', hex: '#8A8D91' },
    royal: { name: 'Royal Blue', hex: '#2A4D9B' },
    washedOlive: { name: 'Washed Olive', hex: '#7A7A5C' },
    offWhite: { name: 'Off White', hex: '#E9E4D8' },
    yellow: { name: 'Yellow', hex: '#E8C547' },
    red: { name: 'Red', hex: '#C8463D' },
    camel: { name: 'Camel', hex: '#B08B5A' },
};

const ADULT = ['S', 'M', 'L', 'XL'];
const ADULT_WIDE = ['S', 'M', 'L', 'XL', 'XXL'];
const WAIST = ['30', '32', '34', '36'];
const KIDS = ['4Y', '6Y', '8Y', '10Y', '12Y'];

const CATEGORIES = [
    { slug: 'linen-shirts', name: 'Linen Shirts', description: 'Breathable European-flax linen for warm days.', shape: 'mandarin', color: C.white.hex, fabric: 'linen', sortOrder: 1 },
    { slug: 'casual-shirts', name: 'Casual Shirts', description: 'Oxford, camp collar and everyday button-downs.', shape: 'shirt', color: C.lightBlue.hex, fabric: 'cotton', sortOrder: 2 },
    { slug: 'polo-shirts', name: 'Polo Shirts', description: 'Piqué and knitted polos for smart-casual dressing.', shape: 'polo', color: C.navy.hex, fabric: 'pique', sortOrder: 3 },
    { slug: 't-shirts', name: 'T-Shirts', description: 'Essential tees in premium combed cotton.', shape: 'tee', color: C.black.hex, fabric: 'cotton', sortOrder: 4 },
    { slug: 'shorts', name: 'Shorts', description: 'Linen, cotton and chino shorts for the tropics.', shape: 'shorts', color: C.sand.hex, fabric: 'linen', sortOrder: 5 },
    { slug: 'trousers', name: 'Trousers', description: 'Relaxed linen and tailored chinos.', shape: 'trousers', color: C.charcoal.hex, fabric: 'cotton', sortOrder: 6 },
];

// stock: either a number for every variant or a function (size, colorIndex) => number
const PRODUCTS = [
    {
        name: 'Classic Linen Shorts', sku: 'CS-SH-001', category: 'shorts', shape: 'shorts', fabric: 'linen',
        price: 4500, salePrice: 3950, colors: [C.sand, C.navy, C.olive], sizes: ADULT, stock: 12, featured: true,
        shortDescription: 'Relaxed drawstring shorts in pure washed linen.',
        description: 'Cut from 100% washed linen, these relaxed shorts keep you cool through Colombo afternoons. An elasticated waist with drawstring, deep side pockets and a 7" inseam make them an easy weekend staple.',
        material: '100% Linen', features: ['Elasticated drawstring waist', 'Two side pockets, one back pocket', '7" inseam', 'Garment washed for softness'],
        tags: ['linen', 'summer', 'shorts', 'drawstring'],
    },
    {
        name: 'Drawstring Cotton Shorts', sku: 'CS-SH-002', category: 'shorts', shape: 'shorts', fabric: 'cotton',
        price: 3800, colors: [C.charcoal, C.stone, C.sky], sizes: ADULT, stock: 15,
        shortDescription: 'Soft cotton twill shorts with an easy drawstring fit.',
        description: 'Lightweight cotton twill shorts with a comfortable elasticated waistband and a clean, minimal finish. Made to be worn on repeat.',
        material: '100% Cotton Twill', features: ['Drawstring waist', 'Side and back pockets', '6" inseam'], tags: ['cotton', 'shorts', 'casual'],
    },
    {
        name: 'Tailored Chino Shorts', sku: 'CS-SH-003', category: 'shorts', shape: 'shorts', fabric: 'cotton',
        price: 5200, colors: [C.khaki, C.navy, C.white], sizes: WAIST, stock: 10, newArrival: true,
        shortDescription: 'Sharp chino shorts with a flat front and belt loops.',
        description: 'Tailored chino shorts in stretch cotton with a flat front, belt loops and a button fly. Dress them up with a linen shirt or down with a tee.',
        material: '98% Cotton, 2% Elastane', features: ['Flat front', 'Button and zip fly', 'Belt loops', '8" inseam'], tags: ['chino', 'shorts', 'smart casual'],
    },
    {
        name: 'Oxford Button-Down Shirt', sku: 'CS-CS-001', category: 'casual-shirts', shape: 'shirt', fabric: 'cotton',
        price: 6900, colors: [C.white, C.lightBlue, C.pink], sizes: ADULT_WIDE, stock: 9, featured: true,
        shortDescription: 'The everyday Oxford shirt with a soft button-down collar.',
        description: 'Woven from a soft Oxford cotton, this button-down shirt is the foundation of a smart-casual wardrobe. Regular fit with a chest pocket and a curved hem that works tucked or untucked.',
        material: '100% Cotton Oxford', features: ['Button-down collar', 'Chest pocket', 'Curved hem', 'Regular fit'], tags: ['oxford', 'shirt', 'office', 'cotton'],
    },
    {
        name: 'Relaxed Camp Collar Shirt', sku: 'CS-CS-002', category: 'casual-shirts', shape: 'camp', fabric: 'linen',
        price: 6200, salePrice: 4990, colors: [C.terracotta, C.black, C.sage], sizes: ADULT, stock: 7,
        shortDescription: 'Short-sleeve resort shirt with an open camp collar.',
        description: 'A relaxed short-sleeve shirt with an open camp collar, cut from a linen-cotton blend with a soft drape. Ideal for holidays, evenings out and everything in between.',
        material: '55% Linen, 45% Cotton', features: ['Open camp collar', 'Short sleeves', 'Straight hem', 'Relaxed fit'], tags: ['resort', 'camp collar', 'shirt', 'summer'],
    },
    {
        name: 'Mandarin Collar Linen Shirt', sku: 'CS-LS-001', category: 'linen-shirts', shape: 'mandarin', fabric: 'linen',
        price: 7900, colors: [C.white, C.sand, C.sky], sizes: ADULT_WIDE, stock: 8, featured: true, newArrival: true,
        shortDescription: 'Band-collar linen shirt with a half-button placket.',
        description: 'Our signature linen shirt with a clean mandarin collar and half-button placket. Pre-washed European flax linen that only gets softer with every wear.',
        material: '100% European Flax Linen', features: ['Mandarin collar', 'Half-button placket', 'Pre-washed', 'Relaxed fit'], tags: ['linen', 'mandarin', 'shirt', 'summer'],
    },
    {
        name: 'Classic Linen Long Sleeve Shirt', sku: 'CS-LS-002', category: 'linen-shirts', shape: 'shirt', fabric: 'linen',
        price: 7500, salePrice: 6400, colors: [C.navy, C.olive, C.beige], sizes: ADULT_WIDE, stock: 11,
        shortDescription: 'Long-sleeve linen shirt with a classic collar.',
        description: 'A timeless long-sleeve linen shirt with a classic point collar, chest pocket and button cuffs. Roll the sleeves for an easy, lived-in look.',
        material: '100% Linen', features: ['Point collar', 'Button cuffs', 'Chest pocket'], tags: ['linen', 'shirt', 'long sleeve'],
    },
    {
        name: "Women's Relaxed Linen Shirt", sku: 'CS-LS-003', category: 'linen-shirts', shape: 'shirt', fabric: 'linen', gender: 'women',
        price: 7200, colors: [C.white, C.blush, C.sage], sizes: ['XS', 'S', 'M', 'L'], stock: 9, newArrival: true,
        shortDescription: 'Oversized linen shirt with dropped shoulders.',
        description: 'An oversized linen shirt with dropped shoulders and a longer back hem. Wear it buttoned, open over a vest or knotted at the waist.',
        material: '100% Linen', features: ['Oversized fit', 'Dropped shoulders', 'Longer back hem'], tags: ['linen', 'women', 'shirt', 'oversized'],
    },
    {
        name: 'Piqué Polo Shirt', sku: 'CS-PO-001', category: 'polo-shirts', shape: 'polo', fabric: 'pique',
        price: 4900, colors: [C.navy, C.white, C.green, C.burgundy], sizes: ADULT_WIDE, stock: 14, featured: true,
        shortDescription: 'Breathable cotton piqué polo with a ribbed collar.',
        description: 'A classic polo in breathable cotton piqué with a ribbed collar, two-button placket and side vents. Holds its shape wash after wash.',
        material: '100% Cotton Piqué', features: ['Ribbed collar and cuffs', 'Two-button placket', 'Side vents'], tags: ['polo', 'pique', 'cotton', 'smart casual'],
    },
    {
        name: 'Knitted Resort Polo', sku: 'CS-PO-002', category: 'polo-shirts', shape: 'polo', fabric: 'pique',
        price: 6500, salePrice: 5500, colors: [C.cream, C.brown], sizes: ADULT, stock: 6,
        shortDescription: 'Fine-knit polo with an open collar.',
        description: 'A fine-gauge knitted polo with an open, buttonless collar. Light enough for warm evenings, polished enough for dinner.',
        material: '100% Cotton Knit', features: ['Fine-gauge knit', 'Open collar', 'Ribbed hem'], tags: ['polo', 'knit', 'resort'],
    },
    {
        name: 'Slim Fit Performance Polo', sku: 'CS-PO-003', category: 'polo-shirts', shape: 'polo', fabric: 'pique',
        price: 5400, colors: [C.black, C.grey, C.royal], sizes: ADULT_WIDE, stock: 12, newArrival: true,
        shortDescription: 'Quick-dry stretch polo for active days.',
        description: 'A slim-fit polo in a quick-dry stretch fabric that wicks moisture and resists creasing. From the course to the office.',
        material: '88% Polyester, 12% Elastane', features: ['Moisture wicking', 'Four-way stretch', 'Slim fit'], tags: ['polo', 'performance', 'golf', 'stretch'],
    },
    {
        name: 'Essential Crew Neck Tee', sku: 'CS-TS-001', category: 't-shirts', shape: 'tee', fabric: 'cotton',
        price: 2500, colors: [C.white, C.black, C.grey, C.navy], sizes: ADULT_WIDE, stock: 25, featured: true,
        shortDescription: 'The perfect everyday tee in combed cotton.',
        description: 'Our best-selling crew neck tee in a mid-weight combed cotton jersey. Pre-shrunk, tag-free and cut for a clean regular fit.',
        material: '100% Combed Cotton', features: ['Mid-weight jersey', 'Pre-shrunk', 'Tag-free neck'], tags: ['tee', 't-shirt', 'basics', 'cotton'],
    },
    {
        name: 'Heavyweight Oversized Tee', sku: 'CS-TS-002', category: 't-shirts', shape: 'tee', fabric: 'cotton',
        price: 3500, colors: [C.black, C.washedOlive, C.offWhite], sizes: ADULT, stock: 10, newArrival: true,
        shortDescription: 'Boxy 240gsm tee with dropped shoulders.',
        description: 'A boxy, oversized tee in a dense 240gsm cotton with dropped shoulders and a thick ribbed neckline. Garment dyed for a lived-in colour.',
        material: '100% Cotton, 240gsm', features: ['Oversized fit', 'Heavyweight cotton', 'Garment dyed'], tags: ['tee', 'oversized', 'streetwear'],
    },
    {
        name: 'Striped Breton Tee', sku: 'CS-TS-003', category: 't-shirts', shape: 'tee', fabric: 'stripe',
        price: 3900, salePrice: 3200, colors: [C.navy, C.red], sizes: ADULT, stock: 8,
        shortDescription: 'Nautical stripe tee in soft cotton jersey.',
        description: 'A classic Breton stripe tee in soft cotton jersey with a relaxed crew neck. A wardrobe essential with seaside charm.',
        material: '100% Cotton Jersey', features: ['Yarn-dyed stripes', 'Relaxed crew neck', 'Regular fit'], tags: ['stripe', 'breton', 'tee'],
    },
    {
        name: 'Kids Cotton Crew Tee', sku: 'CS-TS-004', category: 't-shirts', shape: 'tee', fabric: 'cotton', gender: 'kids',
        price: 1900, colors: [C.yellow, C.sky, C.red], sizes: KIDS, stock: 10,
        shortDescription: 'Soft, durable tee for kids.',
        description: 'A soft and durable cotton tee for kids with a comfortable crew neck and reinforced seams that survive the playground.',
        material: '100% Cotton', features: ['Reinforced seams', 'Soft jersey', 'Machine washable'], tags: ['kids', 'tee', 'cotton'],
    },
    {
        name: 'Relaxed Fit Linen Trousers', sku: 'CS-TR-001', category: 'trousers', shape: 'trousers', fabric: 'linen',
        price: 8500, colors: [C.sand, C.navy, C.black], sizes: WAIST, stock: 9, featured: true,
        shortDescription: 'Easy linen trousers with a drawstring waist.',
        description: 'Relaxed linen trousers with a drawstring waist, slant pockets and a gently tapered leg. The most comfortable way to look put-together in the heat.',
        material: '100% Linen', features: ['Drawstring waist', 'Slant pockets', 'Tapered leg'], tags: ['linen', 'trousers', 'relaxed fit'],
    },
    {
        name: 'Pleated Wide-Leg Trousers', sku: 'CS-TR-002', category: 'trousers', shape: 'trousers', fabric: 'cotton',
        price: 9200, salePrice: 7800, colors: [C.charcoal, C.camel], sizes: WAIST, stock: (size, ci) => (ci === 1 && size === '36' ? 2 : 6),
        shortDescription: 'Single-pleat wide-leg trousers with a high rise.',
        description: 'High-rise trousers with a single front pleat and a fluid wide leg. Tailored from a soft brushed twill with a hint of stretch.',
        material: '97% Cotton, 3% Elastane', features: ['Single pleat', 'High rise', 'Wide leg'], tags: ['trousers', 'pleated', 'wide leg', 'tailored'],
    },
    {
        name: 'Stretch Chino Trousers', sku: 'CS-TR-003', category: 'trousers', shape: 'trousers', fabric: 'cotton',
        price: 6800, colors: [C.khaki, C.navy, C.olive, C.black], sizes: WAIST, stock: (size) => (size === '30' ? 3 : 8),
        shortDescription: 'Slim-straight chinos with comfort stretch.',
        description: 'Slim-straight chinos in a stretch cotton twill that moves with you. Clean finish, button fly and a mid rise for all-day comfort.',
        material: '98% Cotton, 2% Elastane', features: ['Comfort stretch', 'Mid rise', 'Slim-straight leg'], tags: ['chino', 'trousers', 'stretch'],
    },
];

const COUPONS = [
    { code: 'CSTYLE10', description: '10% off orders over Rs 5,000', type: 'percentage', value: 10, minimumAmount: 5000 },
    { code: 'SUMMER20', description: '20% off orders over Rs 15,000 (max Rs 5,000)', type: 'percentage', value: 20, minimumAmount: 15000, maxDiscount: 5000, expiryDate: new Date('2027-03-31T23:59:59Z'), usageLimit: 500 },
    { code: 'NEWUSER', description: 'Rs 1,000 off your first order over Rs 3,000', type: 'fixed', value: 1000, minimumAmount: 3000, firstOrderOnly: true },
    { code: 'FLASH15', description: 'Expired flash sale code (for testing)', type: 'percentage', value: 15, minimumAmount: 0, expiryDate: new Date('2025-01-01T00:00:00Z') },
];

const svgToBuffer = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

const storeImage = async (svg, kind, name) => {
    const stored = await processAndStoreImage(await svgToBuffer(svg), kind, { name });
    return stored.path;
};

const productImages = async (p) => {
    const base = p.sku.toLowerCase();
    const color = p.colors[0].hex;
    const views = [
        { view: 'front', color },
        { view: 'back', color },
        { view: 'detail', color },
    ];
    // A second colourway shot shows off the colour options.
    if (p.colors[1]) views.push({ view: 'front', color: p.colors[1].hex });
    const paths = [];
    for (let i = 0; i < views.length; i += 1) {
        const svg = garmentSvg({ shape: p.shape, fabric: p.fabric, ...views[i] });
        paths.push(await storeImage(svg, 'product', `${base}-${String(i + 1).padStart(2, '0')}`));
    }
    return paths;
};

const variantsFor = (p) => {
    const variants = [];
    p.colors.forEach((c, ci) => {
        p.sizes.forEach((size) => {
            variants.push({
                sku: `${p.sku}-${c.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${size}`,
                size,
                color: c.name,
                stock: typeof p.stock === 'function' ? p.stock(size, ci) : p.stock,
            });
        });
    });
    return variants;
};

const upsertUser = async ({ email, password, name, role, phone }) => {
    if (!email || !password) return null;
    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) return { user, created: false };
    user = new User({ name, email, role, phone });
    await user.setPassword(password);
    await user.save();
    return { user, created: true };
};

const run = async () => {
    assertConfig();
    if (fresh && config.isProduction) throw new Error('Refusing to run --fresh against a production database');
    await connectDB();
    await ensureUploadDirs();

    if (fresh) {
        console.log('🧹 --fresh: clearing catalog, orders, carts, wishlists, reviews, coupons and banners');
        await Promise.all([Product, Category, Order, Cart, Wishlist, Review, Coupon, Banner, Counter].map(m => m.deleteMany({})));
    }
    await Promise.all([User, Category, Product, Coupon, Order, Review, Cart, Wishlist, Banner].map(m => m.syncIndexes()));

    // ── Users ──
    const admin = await upsertUser({
        email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD,
        name: 'CStyle Admin', role: 'admin',
    });
    const customer = adminOnly ? null : await upsertUser({
        email: process.env.SEED_CUSTOMER_EMAIL, password: process.env.SEED_CUSTOMER_PASSWORD,
        name: 'Nimal Perera', role: 'customer', phone: '+94 77 123 4567',
    });
    if (!admin) console.warn('⚠️  SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — no admin account created.');
    else console.log(`👤 Admin ${admin.user.email} ${admin.created ? 'created' : 'already exists'}`);
    if (customer) console.log(`👤 Customer ${customer.user.email} ${customer.created ? 'created' : 'already exists'}`);
    if (adminOnly) return;

    // ── Categories ──
    const catBySlug = {};
    for (const c of CATEGORIES) {
        let cat = await Category.findOne({ slug: c.slug });
        if (!cat) {
            const image = await storeImage(
                garmentSvg({ shape: c.shape, color: c.color, fabric: c.fabric, view: 'front' }),
                'category', `category-${c.slug}`,
            );
            cat = await Category.create({ name: c.name, slug: c.slug, description: c.description, image, sortOrder: c.sortOrder });
            console.log(`📁 Category ${c.name}`);
        }
        catBySlug[c.slug] = cat;
    }

    // ── Products ──
    let createdProducts = 0;
    for (const p of PRODUCTS) {
        if (await Product.exists({ sku: p.sku })) continue;
        const images = await productImages(p);
        await Product.create({
            name: p.name,
            sku: p.sku,
            description: p.description,
            shortDescription: p.shortDescription,
            category: catBySlug[p.category]._id,
            subCategory: CATEGORIES.find(c => c.slug === p.category).name,
            gender: p.gender || 'men',
            price: p.price,
            salePrice: p.salePrice ?? null,
            colors: p.colors,
            sizes: p.sizes,
            variants: variantsFor(p),
            images,
            thumbnail: images[0],
            material: p.material,
            features: p.features,
            specifications: [
                { key: 'Material', value: p.material },
                { key: 'Fit', value: p.features.find(f => /fit/i.test(f)) || 'Regular fit' },
                { key: 'Care', value: p.fabric === 'linen' ? 'Machine wash cold, line dry, warm iron' : 'Machine wash cold, tumble dry low' },
                { key: 'Origin', value: 'Designed in Sri Lanka' },
            ],
            tags: p.tags,
            featured: Boolean(p.featured),
            newArrival: Boolean(p.newArrival),
            lowStockThreshold: 15,
        });
        createdProducts += 1;
        console.log(`👕 ${p.name} (${images.length} images)`);
    }

    // ── Coupons ──
    for (const c of COUPONS) {
        if (!(await Coupon.exists({ code: c.code }))) {
            await Coupon.create(c);
            console.log(`🏷️  Coupon ${c.code}`);
        }
    }

    // ── Banners ──
    if (!(await Banner.exists({}))) {
        const banners = [
            {
                title: 'The Linen Edit', subtitle: 'Breathable essentials for island summers', placement: 'hero', sortOrder: 1, link: '/shop?category=linen-shirts',
                items: [{ shape: 'mandarin', color: C.white.hex, fabric: 'linen' }, { shape: 'trousers', color: C.sand.hex, fabric: 'linen' }, { shape: 'shorts', color: C.navy.hex, fabric: 'linen' }],
            },
            {
                title: 'Polo Season', subtitle: 'Piqué, knit and performance polos', placement: 'hero', sortOrder: 2, link: '/shop?category=polo-shirts',
                items: [{ shape: 'polo', color: C.navy.hex, fabric: 'pique' }, { shape: 'polo', color: C.cream.hex, fabric: 'pique' }, { shape: 'polo', color: C.green.hex, fabric: 'pique' }],
            },
            {
                title: 'Mid-Season Sale', subtitle: 'Up to 20% off selected styles', placement: 'promo', sortOrder: 1, link: '/shop?onSale=true', ctaText: 'Shop the Sale',
                items: [{ shape: 'camp', color: C.terracotta.hex, fabric: 'linen' }, { shape: 'tee', color: C.navy.hex, fabric: 'stripe' }, { shape: 'trousers', color: C.camel.hex }, { shape: 'polo', color: C.brown.hex, fabric: 'pique' }],
            },
        ];
        for (const [i, b] of banners.entries()) {
            const image = await storeImage(sceneSvg({ items: b.items }), 'banner', `banner-${String(i + 1).padStart(2, '0')}`);
            const { items, ...rest } = b;
            await Banner.create({ ...rest, image });
        }
        console.log('🖼️  Banners created');
    }

    // ── Sample orders and reviews for the sample customer ──
    if (customer && !(await Order.exists({ user: customer.user._id }))) {
        const pick = async (sku, colorIdx, sizeIdx, qty) => {
            const p = await Product.findOne({ sku });
            const v = p.variants[colorIdx * p.sizes.length + sizeIdx];
            return { p, v, qty };
        };
        const addr = { fullName: 'Nimal Perera', phone: '+94 77 123 4567', line1: '42 Galle Road', line2: 'Apartment 5B', city: 'Colombo 03', state: 'Western', postalCode: '00300', country: 'Sri Lanka' };
        const samples = [
            { lines: [await pick('CS-SH-001', 0, 1, 2), await pick('CS-TS-001', 1, 2, 1)], status: 'delivered', daysAgo: 20 },
            { lines: [await pick('CS-LS-001', 0, 2, 1), await pick('CS-TR-001', 0, 1, 1)], status: 'shipped', daysAgo: 6 },
            { lines: [await pick('CS-PO-001', 0, 2, 1)], status: 'pending', daysAgo: 1 },
        ];
        for (const s of samples) {
            const items = s.lines.map(({ p, v, qty }) => ({
                product: p._id, variant: v._id, name: p.name, sku: v.sku, image: p.thumbnail,
                size: v.size, color: v.color, unitPrice: p.finalPrice, quantity: qty, lineTotal: p.finalPrice * qty,
            }));
            await reserveStock(items.map(i => ({ productId: i.product, variantId: i.variant, quantity: i.quantity, name: i.name })));
            const subtotal = items.reduce((t, i) => t + i.lineTotal, 0);
            const shipping = subtotal >= config.freeShippingThreshold ? 0 : config.shippingFee;
            const createdAt = new Date(Date.now() - s.daysAgo * 86400000);
            const history = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
            const seq = await Counter.next('order');
            await Order.create({
                orderNumber: `CS${100000 + seq}`,
                user: customer.user._id,
                customer: { name: customer.user.name, email: customer.user.email, phone: customer.user.phone },
                items, subtotal, shipping, discount: 0, total: subtotal + shipping,
                paymentMethod: 'cod',
                paymentStatus: s.status === 'delivered' ? 'paid' : 'pending',
                orderStatus: s.status,
                statusHistory: history.slice(0, history.indexOf(s.status) + 1).map(st => ({ status: st, at: createdAt })),
                shippingAddress: addr, billingAddress: addr,
                createdAt, updatedAt: createdAt,
            });
        }
        const delivered = await Product.findOne({ sku: 'CS-SH-001' });
        await Review.updateOne(
            { product: delivered._id, user: customer.user._id },
            { name: customer.user.name, rating: 5, title: 'Perfect for the heat', comment: 'Light, breathable and the fit is spot on. Ordered a second colour already.', verifiedPurchase: true },
            { upsert: true },
        );
        await Review.recalculate(delivered._id);
        console.log('🧾 Sample orders and a review created for the sample customer');
    }

    const counts = await Promise.all([Category, Product, Coupon, Banner, Order, User].map(m => m.countDocuments()));
    console.log(`\n✅ Seed complete — categories: ${counts[0]}, products: ${counts[1]} (${createdProducts} new), coupons: ${counts[2]}, banners: ${counts[3]}, orders: ${counts[4]}, users: ${counts[5]}`);
    console.log(`   Images are in ${config.uploadDir} and served from ${config.apiBaseUrl}/uploads/...`);
};

run()
    .catch((err) => {
        console.error('❌ Seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => disconnectDB());
