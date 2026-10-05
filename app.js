import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/env.js';
import apiRoutes from './routes/index.js';
import { sanitizeInput } from './middleware/sanitize.js';
import { errorHandler, notFound } from './middleware/error.js';

const app = express();

app.set('trust proxy', 1); // correct client IPs for rate limiting behind Railway/Render/Nginx
app.disable('x-powered-by');

app.use(helmet({
    // Product images are loaded by the storefront from a different origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
    origin(origin, cb) {
        // Allow same-origin/non-browser requests and the configured storefront origins.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
    },
    credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(sanitizeInput);

// Uploaded images, served at /uploads/<folder>/<file>.webp
app.use('/uploads', express.static(config.uploadDir, {
    maxAge: config.isProduction ? '30d' : 0,
    immutable: config.isProduction,
    index: false,
    dotfiles: 'deny',
}));
app.use('/uploads', (req, res) => res.status(404).json({ success: false, message: 'Image not found' }));

app.get('/', (req, res) => {
    res.json({ success: true, message: 'CStyle E-commerce API', version: '2.0.0' });
});
app.get('/api/health', (req, res) => res.json({ success: true, message: 'ok' }));

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
