import config, { assertConfig } from './config/env.js';
import { connectDB, disconnectDB } from './config/database.js';
import { ensureUploadDirs } from './services/imageService.js';
import app from './app.js';

const start = async () => {
    try {
        assertConfig();
        await ensureUploadDirs();
        await connectDB();
    } catch (err) {
        console.error(`❌ Startup failed: ${err.message}`);
        process.exit(1);
    }

    const server = app.listen(config.port, () => {
        console.log(`🚀 CStyle API running on port ${config.port} (${config.nodeEnv})`);
        console.log(`🌐 Public base URL: ${config.apiBaseUrl}`);
    });

    const shutdown = async (signal) => {
        console.log(`${signal} received, shutting down`);
        server.close(async () => {
            await disconnectDB();
            process.exit(0);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start();
