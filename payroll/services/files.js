import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import ApiError from '../../utils/ApiError.js';

/**
 * HR documents (contracts, medical certificates, payment proofs) are private: they are stored
 * outside the public uploads folder and only served through permission-checked routes.
 */
export const HR_FILES_DIR = path.resolve(process.env.HR_FILES_DIR || 'private_files/hr');
const MAX = Number(process.env.HR_MAX_FILE_SIZE) || 10 * 1024 * 1024;

const ALLOWED = {
    'application/pdf': ['.pdf'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'text/csv': ['.csv'],
    'application/vnd.ms-excel': ['.xls', '.csv'],
};

// Magic numbers for the binary types; prevents renamed executables / scripts.
const SIGNATURES = [
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
    { mime: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // docx / xlsx
];

export const hrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX, files: 5 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ALLOWED[file.mimetype]?.includes(ext)) return cb(ApiError.unprocessable('Allowed files: PDF, JPG, PNG, WEBP, DOCX, XLSX, CSV'));
        cb(null, true);
    },
});

export const spreadsheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!['.xlsx', '.csv'].includes(ext)) return cb(ApiError.unprocessable('Upload an .xlsx or .csv file'));
        cb(null, true);
    },
});

const sniff = (buf, mime) => {
    if (mime === 'text/csv' || mime === 'application/vnd.ms-excel') return !buf.subarray(0, 512).includes(0);
    const want = mime.includes('openxmlformats') ? 'zip' : mime;
    const sig = SIGNATURES.find(s => s.mime === want);
    return sig ? sig.bytes.every((b, i) => buf[i] === b) : false;
};

/** Saves an uploaded file and returns the attachment record stored on the document. */
export const saveHrFile = async (file, folder, userId) => {
    if (!sniff(file.buffer, file.mimetype)) throw ApiError.unprocessable(`${file.originalname} does not match its file type`);
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const dir = path.join(HR_FILES_DIR, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), file.buffer);
    return {
        name: path.basename(file.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 150),
        path: `${folder}/${name}`,
        mimeType: file.mimetype,
        size: file.size,
        uploadedBy: userId,
        uploadedAt: new Date(),
    };
};

export const sendHrFile = async (res, attachment) => {
    const abs = path.resolve(HR_FILES_DIR, attachment.path);
    if (!abs.startsWith(HR_FILES_DIR + path.sep)) throw ApiError.badRequest('Invalid file');
    try {
        await fs.access(abs);
    } catch {
        throw ApiError.notFound('File not found');
    }
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.name)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
};

export const removeHrFile = async (attachment) => {
    const abs = path.resolve(HR_FILES_DIR, attachment.path);
    if (abs.startsWith(HR_FILES_DIR + path.sep)) await fs.unlink(abs).catch(() => undefined);
};
