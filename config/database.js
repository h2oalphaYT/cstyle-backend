import mongoose from 'mongoose';
import config from './env.js';

mongoose.set('strictQuery', true);

export const connectDB = async () => {
    const conn = await mongoose.connect(config.mongoUri, {
        dbName: config.mongoDbName,
        serverSelectionTimeoutMS: 15000,
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
};

export const disconnectDB = () => mongoose.connection.close();

mongoose.connection.on('error', (err) => {
    console.error(`❌ MongoDB connection error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
    console.log('🔌 MongoDB disconnected');
});
