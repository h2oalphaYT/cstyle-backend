import Category from '../models/Category.js';
import Banner from '../models/Banner.js';
import Product from '../models/Product.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler, isObjectId, slugify } from '../utils/helpers.js';
import { toStoredPath } from '../utils/imageUrl.js';
import { deleteStoredImage } from '../services/imageService.js';

// ── Categories ─────────────────────────────────────────────────

// GET /api/categories — includes the number of visible products in each.
export const listCategories = asyncHandler(async (req, res) => {
    const admin = req.user?.role === 'admin';
    const filter = admin && req.query.all === 'true' ? {} : { active: true };
    const [categories, counts] = await Promise.all([
        Category.find(filter).sort({ sortOrder: 1, name: 1 }),
        Product.aggregate([
            { $match: { isDeleted: false, active: true } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
        ]),
    ]);
    const countMap = new Map(counts.map(c => [String(c._id), c.count]));
    res.json({
        success: true,
        data: categories.map(c => ({ ...c.toJSON(), productCount: countMap.get(String(c._id)) || 0 })),
    });
});

// GET /api/categories/:idOrSlug
export const getCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const category = await Category.findOne(isObjectId(id) ? { _id: id } : { slug: id.toLowerCase() });
    if (!category || (!category.active && req.user?.role !== 'admin')) throw ApiError.notFound('Category not found');
    res.json({ success: true, data: category });
});

const categoryPayload = (body) => ({
    ...body,
    slug: slugify(body.slug || body.name),
    image: toStoredPath(body.image || ''),
});

export const createCategory = asyncHandler(async (req, res) => {
    const category = await Category.create(categoryPayload(req.body));
    res.status(201).json({ success: true, message: 'Category created', data: category });
});

export const updateCategory = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw ApiError.notFound('Category not found');
    const oldImage = category.image;
    category.set(categoryPayload(req.body));
    await category.save();
    if (oldImage && oldImage !== category.image) await deleteStoredImage(oldImage);
    res.json({ success: true, message: 'Category updated', data: category });
});

export const deleteCategory = asyncHandler(async (req, res) => {
    const inUse = await Product.countDocuments({ category: req.params.id, isDeleted: false });
    if (inUse) throw ApiError.conflict(`This category still has ${inUse} product(s). Move or delete them first.`);
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) throw ApiError.notFound('Category not found');
    await deleteStoredImage(category.image);
    res.json({ success: true, message: 'Category deleted' });
});

// ── Banners ────────────────────────────────────────────────────

export const listBanners = asyncHandler(async (req, res) => {
    const admin = req.user?.role === 'admin';
    const filter = admin && req.query.all === 'true' ? {} : { active: true };
    if (req.query.placement) filter.placement = req.query.placement;
    const banners = await Banner.find(filter).sort({ sortOrder: 1, createdAt: -1 });
    res.json({ success: true, data: banners });
});

export const createBanner = asyncHandler(async (req, res) => {
    const banner = await Banner.create({ ...req.body, image: toStoredPath(req.body.image) });
    res.status(201).json({ success: true, message: 'Banner created', data: banner });
});

export const updateBanner = asyncHandler(async (req, res) => {
    const banner = await Banner.findById(req.params.id);
    if (!banner) throw ApiError.notFound('Banner not found');
    const oldImage = banner.image;
    banner.set({ ...req.body, image: toStoredPath(req.body.image) });
    await banner.save();
    if (oldImage !== banner.image) await deleteStoredImage(oldImage);
    res.json({ success: true, message: 'Banner updated', data: banner });
});

export const deleteBanner = asyncHandler(async (req, res) => {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) throw ApiError.notFound('Banner not found');
    await deleteStoredImage(banner.image);
    res.json({ success: true, message: 'Banner deleted' });
});
