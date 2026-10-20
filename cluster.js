/**
 * Production entry: node cluster.js  (npm start)
 *
 * Env:
 *   PORT, WEB_CONCURRENCY, DB_POOL_LIMIT, REDIS_URL, SESSION_SECRET
 *   RATE_LIMIT_MAX, REQUEST_TIMEOUT_MS
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

const cluster = require('cluster');
const os = require('os');

const workers = Math.max(1, Number(process.env.WEB_CONCURRENCY) || os.cpus().length || 2);

if (cluster.isPrimary || cluster.isMaster) {
    console.log(`Primary ${process.pid} starting ${workers} workers`);
    for (let i = 0; i < workers; i++) {
        cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
        console.error(`Worker ${worker.process.pid} died (${signal || code}). Restarting.`);
        cluster.fork();
    });
} else {
    require('./server.js');
}
