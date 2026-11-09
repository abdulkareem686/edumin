/**
 * Production entry: node cluster.js  (npm start)
 *
 * Env:
 *   PORT, WEB_CONCURRENCY, DB_POOL_LIMIT, REDIS_URL, SESSION_SECRET
 *   RATE_LIMIT_MAX, REQUEST_TIMEOUT_MS
 *
 * CRITICAL: WEB_CONCURRENCY > 1 REQUIRES a shared session store (REDIS_URL).
 * Without it, each worker keeps its own in-memory sessions and users get
 * randomly logged out when a request lands on a different worker.
 *
 * MySQL (on the database server):
 *   max_connections >= WEB_CONCURRENCY * DB_POOL_LIMIT + spare
 *   innodb_buffer_pool_size ~ 50-70% of RAM for large datasets
 *
 * Optional nginx in front:
 *   worker_connections 4096;
 *   proxy_read_timeout 60s;
 *   gzip on;
 */
'use strict';

require('dotenv').config();

const cluster = require('cluster');
const os = require('os');

const hasRedis = Boolean(process.env.REDIS_URL);
const configuredWorkers = Number.parseInt(process.env.WEB_CONCURRENCY, 10);
const defaultWorkers = Math.min(os.availableParallelism?.() || os.cpus().length || 1, 4);
const requestedWorkers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : defaultWorkers;
// MemoryStore is process-local. Never run multiple workers without a shared store.
const workers = hasRedis ? requestedWorkers : 1;

if (cluster.isPrimary || cluster.isMaster) {
    console.log(`Primary ${process.pid} starting ${workers} workers`);

    if (!hasRedis && requestedWorkers > 1) {
        console.warn(
            `WEB_CONCURRENCY=${requestedWorkers}, but REDIS_URL is unset. ` +
            'Starting one worker to prevent users from being logged out. Configure Redis to scale across workers.'
        );
    }

    for (let i = 0; i < workers; i++) {
        cluster.fork();
    }

    let shuttingDown = false;
    cluster.on('exit', (worker, code, signal) => {
        if (shuttingDown) return;
        console.error(`Worker ${worker.process.pid} died (${signal || code}). Restarting.`);
        cluster.fork();
    });

    function shutdownPrimary(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Primary ${process.pid} received ${signal} — shutting down workers...`);
        for (const id in cluster.workers) {
            try { cluster.workers[id].process.kill('SIGTERM'); } catch (_) { /* ignore */ }
        }
        setTimeout(() => process.exit(0), 12000).unref();
    }

    process.on('SIGTERM', () => shutdownPrimary('SIGTERM'));
    process.on('SIGINT', () => shutdownPrimary('SIGINT'));
} else {
    require('./server.js');
}
