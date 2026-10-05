import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/helpers.js';
import { processAndStoreImage, processMany } from '../services/imageService.js';

const requireFile = (req) => {
    if (!req.file) throw ApiError.badRequest('Attach an image in the "image" field');
    return req.file;
};

// POST /api/uploads/product — single image (e.g. the thumbnail)
export const uploadProductImage = asyncHandler(async (req, res) => {
    const image = await processAndStoreImage(requireFile(req).buffer, 'product');
    res.status(201).json({ success: true, data: image });
});

// POST /api/uploads/products — up to 10 images in the "images" field
export const uploadProductImages = asyncHandler(async (req, res) => {
    if (!req.files?.length) throw ApiError.badRequest('Attach one or more images in the "images" field');
    const images = await processMany(req.files, 'product');
    res.status(201).json({ success: true, data: images });
});

// POST /api/uploads/category
export const uploadCategoryImage = asyncHandler(async (req, res) => {
    const image = await processAndStoreImage(requireFile(req).buffer, 'category');
    res.status(201).json({ success: true, data: image });
});

// POST /api/uploads/banner
export const uploadBannerImage = asyncHandler(async (req, res) => {
    const image = await processAndStoreImage(requireFile(req).buffer, 'banner');
    res.status(201).json({ success: true, data: image });
});
