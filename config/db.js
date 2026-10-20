const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const { tryApplyScaleIndexes } = require('../utils/scale');
const {
    supabase,
    supabaseAdmin,
    isSupabaseConfigured,
    checkSupabaseHealth,
    verifySupabaseJwt
} = require('./supabase');

const DB_POOL_LIMIT = Number(process.env.DB_POOL_LIMIT) || 15;
const DB_QUEUE_LIMIT = Number(process.env.DB_QUEUE_LIMIT) || 200;

// Reusable database connection pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'inshallah',
    database: process.env.DB_NAME || 'school_management',
    waitForConnections: true,
    connectionLimit: DB_POOL_LIMIT,
    maxIdle: Math.min(10, DB_POOL_LIMIT),
    idleTimeout: 60000,
    queueLimit: DB_QUEUE_LIMIT,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000
});

tryApplyScaleIndexes(dbPool).catch((err) => {
    console.warn('Scale indexes not applied:', err.message);
});

const requestDbStorage = new AsyncLocalStorage();

function releaseConnection(connection) {
    if (!connection) return;
    try {
        const store = requestDbStorage.getStore();
        if (store?.connections) store.connections.delete(connection);
        connection.release();
    } catch (err) {
        console.error('Error releasing DB connection:', err);
    }
}

async function getConnection() {
    const store = requestDbStorage.getStore();
    let conn;
    if (store) {
        if (!store.primaryConnection) {
            store.primaryConnection = await dbPool.getConnection();
            store.connections = store.connections || new Set();
            store.connections.add(store.primaryConnection);
        }
        conn = store.primaryConnection;
    } else {
        conn = await dbPool.getConnection();
    }

    // Attach Supabase clients directly onto connection instance
    if (conn) {
        conn.supabase = supabase;
        conn.supabaseAdmin = supabaseAdmin;
    }
    return conn;
}

async function withConnection(callback) {
    const connection = await getConnection();
    try {
        return await callback(connection);
    } finally {
        releaseConnection(connection);
    }
}

// Check if a table column exists
async function tableHasColumn(connection, tableName, columnName) {
    try {
        const [rows] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = ? 
            AND COLUMN_NAME = ?
        `, [tableName, columnName]);
        return rows[0].count > 0;
    } catch (err) {
        console.warn(`tableHasColumn check failed for ${tableName}.${columnName}:`, err.message);
        return false;
    }
}

// Check if a table exists
async function tableExists(connection, tableName) {
    try {
        const [rows] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = ?
        `, [tableName]);
        return rows[0].count > 0;
    } catch (err) {
        console.warn(`tableExists check failed for ${tableName}:`, err.message);
        return false;
    }
}

module.exports = {
    dbPool,
    getConnection,
    releaseConnection,
    withConnection,
    requestDbStorage,
    tableHasColumn,
    tableExists,
    // Supabase data connection exports
    supabase,
    supabaseAdmin,
    isSupabaseConfigured,
    checkSupabaseHealth,
    verifySupabaseJwt,
    DB_POOL_LIMIT,
    DB_QUEUE_LIMIT
};
