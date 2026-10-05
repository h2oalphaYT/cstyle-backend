// Starts a local MongoDB server for development without installing MongoDB system-wide.
// Data is kept in ./.mongo-data so it survives restarts. Usage: npm run db:local
import fs from 'fs';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const port = parseInt(process.env.LOCAL_MONGO_PORT || '27017', 10);
const dbPath = path.resolve(process.env.LOCAL_MONGO_PATH || '.mongo-data');
fs.mkdirSync(dbPath, { recursive: true });

const server = await MongoMemoryServer.create({
    instance: { port, dbPath, storageEngine: 'wiredTiger' },
});

console.log(`🍃 Local MongoDB running at ${server.getUri()}`);
console.log(`   Data directory: ${dbPath}`);
console.log(`   Use MONGODB_URI=mongodb://127.0.0.1:${port}/cstyle in .env. Press Ctrl+C to stop.`);

const stop = async () => {
    await server.stop({ doCleanup: false });
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
