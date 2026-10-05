import Product from '../models/Product.js';
import Category from '../models/Category.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler, escapeRegex, isObjectId, paginationMeta, parsePagination, slugify } from '../utils/helpers.js';
import { toStoredPath } from '../utils/imageUrl.js';
import { deleteStoredImage } from '../services/imageService.js';

const CATEGORY_FIELDS = 'name slug';

const SORTS = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    'price-asc': { finalPrice: 1, createdAt: -1 },
    'price-desc': { finalPrice: -1, createdAt: -1 },
    name: { name: 1 },
    rating: { ratingAverage: -1, ratingCount: -1 },
    popular: { viewCount: -1, createdAt: -1 },
    'best-selling': { soldCount: -1, createdAt: -1 },
    stock: { stock: 1 },
};

const isAdmin = (req) => req.user?.role === 'admin';

// Accepts a category id, slug or (case-insensitive) name.
const resolveCategoryIds = async (value) => {
    if (isObjectId(value)) return [value];
    const re = new RegExp(`^${escapeRegex(value)}$`, 'i');
    const cats = await Category.find({ $or: [{ slug: value.toLowerCase() }, { name: re }] }).select('_id');
    return cats.map(c => c._id);
};

const visibilityFilter = (req, status) => {
    if (!isAdmin(req)) return { isDeleted: false, active: true };
    switch (status) {
        case 'active': return { isDeleted: false, active: true };
        case 'inactive': return { isDeleted: false, active: false };
        case 'deleted': return { isDeleted: true };
        case 'all': return {};
        default: return { isDeleted: false };
    }
};

const buildFilter = async (req) => {
    const q = req.query;
    const and = [visibilityFilter(req, q.status)];

    if (q.category) {
        const ids = await resolveCategoryIds(q.category);
        and.push({ category: { $in: ids } });
    }
    if (q.subCategory) and.push({ subCategory: new RegExp(`^${escapeRegex(q.subCategory)}$`, 'i') });
    if (q.gender) and.push({ gender: { $in: [q.gender, 'unisex'] } });
    if (q.minPrice != null || q.maxPrice != null) {
        const range = {};
        if (q.minPrice != null) range.$gte = q.minPrice;
        if (q.maxPrice != null) range.$lte = q.maxPrice;
        and.push({ finalPrice: range });
    }
    if (q.size) and.push({ sizes: q.size });
    if (q.color) and.push({ 'colors.name': new RegExp(`^${escapeRegex(q.color)}$`, 'i') });
    if (q.tag) and.push({ tags: q.tag.toLowerCase() });
    if (q.featured === 'true') and.push({ featured: true });
    if (q.newArrival === 'true') and.push({ newArrival: true });
    if (q.onSale === 'true') and.push({ salePrice: { $ne: null }, $expr: { $lt: ['$salePrice', '$price'] } });
    if (q.inStock === 'true') and.push({ stock: { $gt: 0 } });
    if (q.inStock === 'false') and.push({ stock: { $lte: 0 } });
    if (q.lowStock === 'true') and.push({ $expr: { $lte: ['$stock', '$lowStockThreshold'] } });
    if (q.ids) {
        const ids = q.ids.split(',').map(s => s.trim()).filter(isObjectId).slice(0, 50);
        and.push({ _id: { $in: ids } });
    }
    if (q.exclude && isObjectId(q.exclude)) and.push({ _id: { $ne: q.exclude } });

    if (q.search) {
        const re = new RegExp(escapeRegex(q.search), 'i');
        const catIds = (await Category.find({ name: re }).select('_id')).map(c => c._id);
        and.push({
            $or: [
                { name: re }, { sku: re }, { tags: re }, { description: re },
                { subCategory: re }, { 'variants.sku': re }, { category: { $in: catIds } },
            ],
        });
    }
    return and.length === 1 ? and[0] : { $and: and };
};

// GET /api/products
export const listProducts = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const filter = await buildFilter(req);
    let sort = SORTS[req.query.sort] || SORTS.newest;

    // Keep the order of an explicit id list (used for recently viewed).
    if (req.query.ids && !req.query.sort) sort = undefined;

    const [items, total] = await Promise.all([
        Product.find(filter).populate('category', CATEGORY_FIELDS).sort(sort).skip(skip).limit(limit),
        Product.countDocuments(filter),
    ]);

    let data = items;
    if (req.query.ids && !req.query.sort) {
        const order = req.query.ids.split(',');
        data = [...items].sort((a, b) => order.indexOf(String(a._id)) - order.indexOf(String(b._id)));
    }

    res.json({ success: true, data, pagination: paginationMeta(page, limit, total) });
});

// GET /api/products/suggestions?q=
export const suggestions = asyncHandler(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 60);
    if (term.length < 2) return res.json({ success: true, data: { products: [], categories: [] } });
    const re = new RegExp(escapeRegex(term), 'i');
    const [products, categories] = await Promise.all([
        Product.find({ isDeleted: false, active: true, $or: [{ name: re }, { sku: re }, { tags: re }] })
            .select('name slug thumbnail images price salePrice finalPrice sku')
            .sort({ soldCount: -1 })
            .limit(6),
        Category.find({ active: true, name: re }).select('name slug').limit(4),
    ]);
    res.json({
        success: true,
        data: {
            products: products.map(p => ({ id: p.id, name: p.name, slug: p.slug, thumbnail: p.toJSON().thumbnail, price: p.finalPrice })),
            categories,
        },
    });
});

const findVisible = async (req, filter) => {
    const product = await Product.findOne({ ...filter, ...(isAdmin(req) ? {} : { isDeleted: false, active: true }) })
        .populate('category', CATEGORY_FIELDS);
    if (!product) throw ApiError.notFound('Product not found');
    return product;
};

// GET /api/products/:id  (also accepts a slug for convenience)
export const getProduct = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const product = await findVisible(req, isObjectId(id) ? { _id: id } : { slug: id.toLowerCase() });
    res.json({ success: true, data: product });
});

// GET /api/products/slug/:slug
export const getProductBySlug = asyncHandler(async (req, res) => {
    const product = await findVisible(req, { slug: req.params.slug.toLowerCase() });
    res.json({ success: true, data: product });
});

// GET /api/products/:id/related — same category first, then shared tags, then best sellers.
export const relatedProducts = asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid product id');
    const product = await Product.findById(req.params.id).select('category tags gender');
    if (!product) throw ApiError.notFound('Product not found');
    const limit = Math.min(12, parseInt(req.query.limit, 10) || 4);
    const base = { _id: { $ne: product._id }, isDeleted: false, active: true };

    const picked = [];
    const seen = new Set([String(product._id)]);
    const take = (list) => list.forEach(p => {
        if (picked.length < limit && !seen.has(String(p._id))) { picked.push(p); seen.add(String(p._id)); }
    });

    take(await Product.find({ ...base, category: product.category }).populate('category', CATEGORY_FIELDS).sort({ soldCount: -1 }).limit(limit));
    if (picked.length < limit && product.tags?.length) {
        take(await Product.find({ ...base, tags: { $in: product.tags } }).populate('category', CATEGORY_FIELDS).sort({ soldCount: -1 }).limit(limit));
    }
    if (picked.length < limit) {
        take(await Product.find(base).populate('category', CATEGORY_FIELDS).sort({ soldCount: -1 }).limit(limit * 2));
    }
    res.json({ success: true, data: picked });
});

// POST /api/products/:id/view — counts a view and records it for logged-in shoppers.
export const recordView = asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid product id');
    const updated = await Product.updateOne({ _id: req.params.id, isDeleted: false }, { $inc: { viewCount: 1 } });
    if (!updated.matchedCount) throw ApiError.notFound('Product not found');
    if (req.user) {
        await User.updateOne({ _id: req.user._id }, { $pull: { recentlyViewed: { product: req.params.id } } });
        await User.updateOne({ _id: req.user._id }, {
            $push: { recentlyViewed: { $each: [{ product: req.params.id, viewedAt: new Date() }], $position: 0, $slice: 20 } },
        });
    }
    res.json({ success: true });
});

// ── Admin ──────────────────────────────────────────────────────

const normalizeImages = (body) => {
    if (body.images) body.images = [...new Set(body.images.map(toStoredPath).filter(Boolean))];
    if (body.thumbnail !== undefined) body.thumbnail = toStoredPath(body.thumbnail);
};

const ensureCategory = async (categoryId) => {
    if (categoryId && !(await Category.exists({ _id: categoryId }))) {
        throw ApiError.unprocessable('Selected category does not exist');
    }
};

const uniqueSlug = async (wanted, excludeId) => {
    const base = slugify(wanted) || 'product';
    let slug = base;
    let n = 2;
    // eslint-disable-next-line no-await-in-loop
    while (await Product.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
        slug = `${base}-${n}`;
        n += 1;
    }
    return slug;
};

// Deletes uploaded files that no product references any more.
const cleanupImages = async (paths) => {
    for (const p of paths) {
        // eslint-disable-next-line no-await-in-loop
        if (p.startsWith('/uploads/') && !(await Product.exists({ $or: [{ images: p }, { thumbnail: p }] }))) {
            // eslint-disable-next-line no-await-in-loop
            await deleteStoredImage(p);
        }
    }
};

// POST /api/products
export const createProduct = asyncHandler(async (req, res) => {
    const body = { ...req.body };
    await ensureCategory(body.category);
    normalizeImages(body);
    body.slug = await uniqueSlug(body.slug || body.name);
    const product = await Product.create(body);
    await product.populate('category', CATEGORY_FIELDS);
    res.status(201).json({ success: true, message: 'Product created', data: product });
});

// PUT /api/products/:id
export const updateProduct = asyncHandler(async (req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('Invalid product id');
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');

    const body = { ...req.body };
    await ensureCategory(body.category);
    normalizeImages(body);
    if (body.slug !== undefined || (body.name && body.name !== product.name && !body.slug)) {
        body.slug = await uniqueSlug(body.slug || body.name, product._id);
    }
    // A cleared sale price arrives as null.
    if (Object.prototype.hasOwnProperty.call(req.body, 'salePrice') && req.body.salePrice == null) body.salePrice = null;

    const previousImages = [...product.images, product.thumbnail].filter(Boolean);
    product.set(body);
    await product.save();

    const kept = new Set([...product.images, product.thumbnail]);
    await cleanupImages(previousImages.filter(p => !kept.has(p)));

    await product.populate('category', CATEGORY_FIELDS);
    res.json({ success: true, message: 'Product updated', data: product });
});

// PATCH /api/products/:id/status
export const setProductStatus = asyncHandler(async (req, res) => {
    const product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { active: req.body.active },
        { new: true },
    ).populate('category', CATEGORY_FIELDS);
    if (!product) throw ApiError.notFound('Product not found');
    res.json({ success: true, message: product.active ? 'Product activated' : 'Product deactivated', data: product });
});

// DELETE /api/products/:id — soft delete so past orders keep their references.
export const deleteProduct = asyncHandler(async (req, res) => {
    const product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true, active: false, deletedAt: new Date() },
        { new: true },
    );
    if (!product) throw ApiError.notFound('Product not found');
    res.json({ success: true, message: 'Product deleted' });
});

// PATCH /api/products/:id/restore
export const restoreProduct = asyncHandler(async (req, res) => {
    const product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: true },
        { isDeleted: false, active: true, deletedAt: null },
        { new: true },
    ).populate('category', CATEGORY_FIELDS);
    if (!product) throw ApiError.notFound('Product not found or not deleted');
    res.json({ success: true, message: 'Product restored', data: product });
});

// DELETE /api/products/:id/images  { url }
export const removeProductImage = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    const target = toStoredPath(req.body?.url);
    if (!product.images.includes(target)) throw ApiError.notFound('Image not found on this product');
    product.images = product.images.filter(p => p !== target);
    if (product.thumbnail === target) product.thumbnail = product.images[0] || '';
    await product.save();
    await cleanupImages([target]);
    await product.populate('category', CATEGORY_FIELDS);
    res.json({ success: true, message: 'Image removed', data: product });
});

// PATCH /api/products/:id/thumbnail  { url }
export const setThumbnail = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    const target = toStoredPath(req.body?.url);
    if (!product.images.includes(target)) throw ApiError.unprocessable('The primary image must be one of the product images');
    product.thumbnail = target;
    // Primary image goes first so every consumer of images[0] agrees.
    product.images = [target, ...product.images.filter(p => p !== target)];
    await product.save();
    await product.populate('category', CATEGORY_FIELDS);
    res.json({ success: true, message: 'Primary image updated', data: product });
});
