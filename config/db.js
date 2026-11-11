
require('dotenv').config();

const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const { tryApplyScaleIndexes } = require('../utils/scale');

// Vercel and Layerbase connection limits
const isVercel =
    process.env.VERCEL === '1' ||
    process.env.VERCEL === 'true';

const configuredPoolLimit = Number(process.env.DB_POOL_LIMIT);

// Keep each Vercel instance to one MySQL connection.
// This reduces connection usage but does not guarantee the
// total across all Vercel instances stays below Layerbase's limit.
const DB_POOL_LIMIT = isVercel
    ? 1
    : (
        Number.isInteger(configuredPoolLimit) &&
        configuredPoolLimit > 0
            ? configuredPoolLimit
            : 5
    );

const configuredQueueLimit = Number(process.env.DB_QUEUE_LIMIT);

const DB_QUEUE_LIMIT =
    Number.isInteger(configuredQueueLimit) &&
    configuredQueueLimit > 0
        ? configuredQueueLimit
        : (isVercel ? 10 : 200);

// Validate required environment variables
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

if (
    !Number.isInteger(dbPort) ||
    dbPort < 1 ||
    dbPort > 65535
) {
    throw new Error(
        'Invalid DB_PORT. Check your database connection details.'
    );
}

// Create one reusable pool per running application instance.
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: dbPort,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    ssl: {
        minVersion: 'TLSv1.2'
    },

    waitForConnections: true,
    connectionLimit: DB_POOL_LIMIT,
    queueLimit: DB_QUEUE_LIMIT,

    // Keep at most one idle connection on Vercel.
    maxIdle: isVercel
        ? 1
        : Math.min(4, DB_POOL_LIMIT),

    idleTimeout: 60000,

    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,

    connectTimeout: 20000
});

// Log pool errors
dbPool.on('error', err => {
    console.error('MySQL pool error:', {
        code: err.code,
        message: err.message
    });
});

// Request-level connection storage
const requestDbStorage = new AsyncLocalStorage();

// Apply indexes only when explicitly enabled.
// Do not run database schema changes automatically on Vercel.
if (
    process.env.APPLY_SCALE_INDEXES_ON_START === 'true' &&
    !isVercel
) {
    tryApplyScaleIndexes(dbPool).catch(err => {
        console.error('Scale index application failed:', err.message);
    });
}

// Release a connection safely
function releaseConnection(connection) {
    if (!connection) return;

    const store = requestDbStorage.getStore();

    if (store) {
        if (store.connections) {
            store.connections.delete(connection);
        }

        if (store.primaryConnection === connection) {
            store.primaryConnection = null;
        }
    }

    try {
        connection.release();
    } catch (err) {
        console.error(
            'Database connection release error:',
            err.message
        );
    }
}

// Get a connection for the current request.
// A released connection is never reused.
async function getConnection() {
    const store = requestDbStorage.getStore();

    if (!store) {
        return dbPool.getConnection();
    }

    if (store.primaryConnection) {
        return store.primaryConnection;
    }

    const connection = await dbPool.getConnection();

    store.primaryConnection = connection;

    if (!store.connections) {
        store.connections = new Set();
    }

    store.connections.add(connection);

    return connection;
}

// Run a callback with a dedicated connection.
async function withConnection(callback) {
    if (typeof callback !== 'function') {
        throw new TypeError(
            'withConnection requires a callback function.'
        );
    }

    const connection = await dbPool.getConnection();

    try {
        return await callback(connection);
    } finally {
        connection.release();
    }
}

// Check whether a column exists
async function tableHasColumn(
    connection,
    tableName,
    columnName
) {
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
        console.error(
            `Column check failed for ${tableName}.${columnName}:`,
            err.message
        );

        throw err;
    }
}

// Check whether a table exists
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
        console.error(
            `Table check failed for ${tableName}:`,
            err.message
        );

        throw err;
    }
}

// Test database connectivity
async function testConnection() {
    let connection;

    try {
        connection = await dbPool.getConnection();

        const [rows] = await connection.query(
            `SELECT
                1 AS connected,
                DATABASE() AS database_name`
        );

        console.log('Database connected successfully.');
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

// Export database utilities
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
