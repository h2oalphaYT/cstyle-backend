import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const toInt = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'development';
const port = toInt(process.env.PORT, 5000);

const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,

    mongoUri: process.env.MONGODB_URI || '',
    mongoDbName: process.env.MONGODB_DB_NAME || undefined,

    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

    // Public base URL of this API, used to build absolute image URLs.
    apiBaseUrl: (process.env.API_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),

    // Comma separated list of allowed browser origins.
    corsOrigins: (process.env.FRONTEND_URL || 'http://localhost:5173'|| 'http://localhost:5174')
        .split(',')
        .map(o => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),

    uploadDir: path.resolve(process.env.UPLOAD_DIR || 'uploads'),
    maxFileSize: toInt(process.env.MAX_FILE_SIZE, 5 * 1024 * 1024),

    currency: process.env.CURRENCY || 'LKR',
    shippingFee: toInt(process.env.SHIPPING_FEE, 1500),
    freeShippingThreshold: toInt(process.env.FREE_SHIPPING_THRESHOLD, 30000),
};

export const assertConfig = () => {
    const missing = [];
    if (!config.mongoUri) missing.push('MONGODB_URI');
    if (!config.jwtSecret) missing.push('JWT_SECRET');
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}. See .env.example.`);
    }
    if (config.isProduction && config.jwtSecret.length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }
};

export default config;
