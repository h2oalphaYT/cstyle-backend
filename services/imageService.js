import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import config from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { toPublicUrl } from '../utils/imageUrl.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

// Folder and resize settings per upload kind.
export const IMAGE_KINDS = {
    product: { folder: 'products', prefix: 'product', maxWidth: 1600, maxHeight: 2000 },
    category: { folder: 'categories', prefix: 'category', maxWidth: 1200, maxHeight: 1600 },
    banner: { folder: 'banners', prefix: 'banner', maxWidth: 2400, maxHeight: 1400 },
};

export const ensureUploadDirs = async () => {
    await Promise.all(
        Object.values(IMAGE_KINDS).map(k => fs.mkdir(path.join(config.uploadDir, k.folder), { recursive: true })),
    );
};

// Files stay in memory until sharp has verified and re-encoded them, so nothing unverified touches disk.
export const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSize, files: 10 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
            return cb(ApiError.unprocessable('Only JPG, JPEG, PNG and WEBP images are allowed'));
        }
        cb(null, true);
    },
});

const newGroupId = () => crypto.randomBytes(4).toString('hex');

/**
 * Verifies the bytes really are an allowed image, re-encodes to WebP (dropping EXIF/GPS data)
 * and writes it under uploads/<folder>/<prefix>-<groupId>-<suffix>.webp.
 */
export const processAndStoreImage = async (buffer, kindKey, { groupId = newGroupId(), suffix = 'main', name } = {}) => {
    const kind = IMAGE_KINDS[kindKey];
    if (!kind) throw ApiError.badRequest('Unknown image type');

    let meta;
    try {
        meta = await sharp(buffer).metadata();
    } catch {
        throw ApiError.unprocessable('The file is not a valid image');
    }
    if (!ALLOWED_FORMATS.has(meta.format)) {
        throw ApiError.unprocessable('Only JPG, JPEG, PNG and WEBP images are allowed');
    }

    // `name` is only used by the seed script for readable sample file names.
    const filename = name ? `${name}.webp` : `${kind.prefix}-${groupId}-${suffix}.webp`;
    const absolute = path.join(config.uploadDir, kind.folder, filename);
    const info = await sharp(buffer)
        .rotate()
        .resize({ width: kind.maxWidth, height: kind.maxHeight, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(absolute);

    const storedPath = `/uploads/${kind.folder}/${filename}`;
    return {
        path: storedPath,
        url: toPublicUrl(storedPath),
        filename,
        width: info.width,
        height: info.height,
        size: info.size,
    };
};

export const processMany = async (files, kindKey) => {
    const groupId = newGroupId();
    const results = [];
    for (let i = 0; i < files.length; i += 1) {
        results.push(await processAndStoreImage(files[i].buffer, kindKey, { groupId, suffix: String(i + 1) }));
    }
    return results;
};

// Removes a previously stored upload. Paths outside the upload folder are ignored.
export const deleteStoredImage = async (storedPath) => {
    if (!storedPath || !storedPath.startsWith('/uploads/')) return false;
    const absolute = path.resolve(config.uploadDir, storedPath.replace(/^\/uploads\//, ''));
    if (!absolute.startsWith(config.uploadDir + path.sep)) return false;
    try {
        await fs.unlink(absolute);
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Failed to delete image', storedPath, err.message);
        return false;
    }
};
