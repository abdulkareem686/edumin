require('dotenv').config();

const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const { tryApplyScaleIndexes } = require('../utils/scale');

// Vercel creates independent warm instances, each with its own pool. Keep each
// instance to one DB client so scaling traffic does not multiply a large pool.
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const configuredPoolLimit = Number(process.env.DB_POOL_LIMIT);
const DB_POOL_LIMIT = isVercel
    ? 1
    : (Number.isInteger(configuredPoolLimit) && configuredPoolLimit > 0
        ? configuredPoolLimit
        : 5);
const configuredQueueLimit = Number(process.env.DB_QUEUE_LIMIT);
const DB_QUEUE_LIMIT = Number.isInteger(configuredQueueLimit) && configuredQueueLimit > 0
    ? configuredQueueLimit
    : (isVercel ? 10 : 200);
const DB_MAX_IDLE = isVercel ? 0 : Math.max(0, Math.min(4, DB_POOL_LIMIT - 1));
const DB_IDLE_TIMEOUT = isVercel ? 30000 : 60000;

// Validate required database environment variables
const requiredDbVariables = [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME'
];

const missingDbVariables = requiredDbVariables.filter(
    key => !process.env[key]
);

if (missingDbVariables.length > 0) {
    throw new Error(
        `Missing database environment variables: ${missingDbVariables.join(', ')}`
    );
}

const dbPort = Number(process.env.DB_PORT);

if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
    throw new Error('Invalid DB_PORT. Check your Layerbase connection details.');
}

// Reusable MariaDB / MySQL connection pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: dbPort,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    // Layerbase TLS connection
    ssl: {
        minVersion: 'TLSv1.2'
    },

    waitForConnections: true,
    connectionLimit: DB_POOL_LIMIT,
    maxIdle: DB_MAX_IDLE,
    idleTimeout: DB_IDLE_TIMEOUT,
    queueLimit: DB_QUEUE_LIMIT,

    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,

    // Allow time for sleeping free databases to wake up
    connectTimeout: 30000
});

// Log database pool errors
dbPool.on('error', (err) => {
    console.error('Database pool error:', err.message);
});

// Apply schema/index changes only when explicitly requested. Do not execute DDL
// during application imports or Vercel function cold starts.
if (process.env.APPLY_SCALE_INDEXES_ON_START === 'true') {
    tryApplyScaleIndexes(dbPool).catch((err) => {
        console.warn('Scale indexes not applied:', err.message);
    });
}

// Request-level database connection storage
const requestDbStorage = new AsyncLocalStorage();

// Release a database connection
function releaseConnection(connection) {
    if (!connection) return;

    try {
        const store = requestDbStorage.getStore();

        if (store?.connections) {
            store.connections.delete(connection);
        }

        connection.release();
    } catch (err) {
        console.error('Error releasing DB connection:', err.message);
    }
}

// Get a reusable connection for the current request
async function getConnection() {
    const store = requestDbStorage.getStore();

    if (store) {
        if (!store.primaryConnection) {
            store.primaryConnection = await dbPool.getConnection();

            store.connections = store.connections || new Set();
            store.connections.add(store.primaryConnection);
        }

        return store.primaryConnection;
    }

    return dbPool.getConnection();
}

// Execute a callback using a database connection
async function withConnection(callback) {
    const connection = await dbPool.getConnection();

    try {
        return await callback(connection);
    } finally {
        connection.release();
    }
}

// Check if a table column exists
async function tableHasColumn(connection, tableName, columnName) {
    try {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS count
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = ?
             AND COLUMN_NAME = ?`,
            [tableName, columnName]
        );

        return Number(rows[0].count) > 0;

    } catch (err) {
        console.warn(
            `tableHasColumn check failed for ${tableName}.${columnName}:`,
            err.message
        );

        return false;
    }
}

// Check if a table exists
async function tableExists(connection, tableName) {
    try {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS count
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = ?`,
            [tableName]
        );

        return Number(rows[0].count) > 0;

    } catch (err) {
        console.warn(
            `tableExists check failed for ${tableName}:`,
            err.message
        );

        return false;
    }
}

// Test database connectivity
async function testConnection() {
    let connection;

    try {
        connection = await dbPool.getConnection();

        const [rows] = await connection.query(
            'SELECT 1 AS connected, DATABASE() AS database_name'
        );

        console.log('Database connected successfully!');
        console.log('Database:', rows[0].database_name);

        return rows[0];

    } catch (err) {
        console.error('Database connection failed:', {
            code: err.code,
            message: err.message
        });

        throw err;

    } finally {
        if (connection) {
            connection.release();
        }
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
    testConnection,
    DB_POOL_LIMIT,
    DB_QUEUE_LIMIT
};
