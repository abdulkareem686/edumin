require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

const {
    dbPool,
    getConnection,
    requestDbStorage,
    DB_POOL_LIMIT,require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

const {
    dbPool,
    getConnection,
    requestDbStorage,
    DB_POOL_LIMIT,
    DB_QUEUE_LIMIT
} = require('./config/db');
const { requireRole } = require('./middleware/auth');
const { studentDisplayName } = require('./utils/helpers');
const routes = require('./routes');

const app = express();

// Trust proxy for rate limiting behind reverse proxies
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Request timeout
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;
app.use((req, res, next) => {
    req.setTimeout(REQUEST_TIMEOUT_MS);
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(504).send('Request timeout');
        }
    });
    next();
});

// Global Rate Limiter
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false
}));

// ---------------------------------------------------------------------------
// Session configuration
//
// CRITICAL: When running under cluster.js with WEB_CONCURRENCY > 1, sessions
// MUST be stored in a shared store (Redis). With the default MemoryStore each
// worker keeps its own copy, so a request routed to a different worker sees no
// session and the user is effectively logged out.
// ---------------------------------------------------------------------------
let redisClient = null;
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        // Use HTTPS-only cookies on HTTPS requests, but allow plain HTTP on
        // localhost even when NODE_ENV is set to production.
        secure: 'auto'
    }
};

const isProduction = process.env.NODE_ENV === 'production';
const hasRedis = Boolean(process.env.REDIS_URL);
const workerCount = Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);

if (process.env.VERCEL && !hasRedis) {
    throw new Error('REDIS_URL is required on Vercel so login sessions persist between serverless requests.');
}

if (hasRedis) {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default;
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis session store error:', err.message));
    sessionConfig.store = new RedisStore({ client: redisClient, prefix: 'smsess:' });
    console.log('Session store: Redis');
} else {
    console.warn('REDIS_URL not set — using in-memory sessions (not for thousands of users)');
    if (workerCount > 1) {
        console.warn(
            `WEB_CONCURRENCY=${workerCount}, but no shared session store is configured. ` +
            'cluster.js limits this process to one worker; configure Redis before scaling out.'
        );
    }
}

let redisConnectPromise = null;
async function ensureRedisConnected() {
    if (!redisClient || redisClient.isReady) return;
    if (!redisConnectPromise) {
        redisConnectPromise = redisClient.connect().catch((err) => {
            redisConnectPromise = null;
            throw err;
        });
    }
    await redisConnectPromise;
}

app.locals.ready = ensureRedisConnected;
app.use(session(sessionConfig));

// Return pooled connections when the HTTP response completes
app.use((req, res, next) => {
    const connections = new Set();
    const cleanup = () => {
        for (const conn of connections) {
            try { conn.release(); } catch (_) { /* already released */ }
        }
        connections.clear();
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    requestDbStorage.run({ connections }, next);
});

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views', 'school_app'));

function injectFeedbackAssets(html) {
    if (typeof html !== 'string') return html;

    let updatedHtml = html;
    if (!updatedHtml.includes('/assets/css/form-feedback.css')) {
        updatedHtml = updatedHtml.replace('</head>', '<link rel="stylesheet" href="/assets/css/form-feedback.css"></head>');
    }
    if (!updatedHtml.includes('/assets/js/form-feedback.js')) {
        updatedHtml = updatedHtml.replace('</body>', '<script src="/assets/js/form-feedback.js"></script></body>');
    }
    return updatedHtml;
}

// Global view locals for role-aware layouts
app.use((req, res, next) => {
    const role = req.session?.role || (req.session?.parentId ? 'parent' : null);
    res.locals.role = role;
    res.locals.userRole = role;
    res.locals.username = req.session?.username || req.session?.parentName || '';
    res.locals.userId = req.session?.userId || req.session?.parentId || null;
    res.locals.session = req.session;
    next();
});

app.use((req, res, next) => {
    const originalRender = res.render.bind(res);

    res.render = function (view, options, callback) {
        if (typeof options === 'function') {
            return originalRender(view, {}, options);
        }

        const renderOptions = options || {};
        const done = typeof callback === 'function'
            ? callback
            : function (err, html) {
                if (err) {
                    if (!res.headersSent) {
                        return res.status(500).send(err.message || err);
                    }
                    return;
                }

                if (typeof html === 'string') {
                    html = injectFeedbackAssets(html);
                }

                res.send(html);
            };

        return originalRender(view, renderOptions, done);
    };

    next();
});

// App locals
app.locals.studentDisplayName = studentDisplayName;

// Serve static files (CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
    if (hasRedis && !redisClient?.isReady) {
        return res.status(503).json({ ok: false, error: 'session store unavailable' });
    }

    try {
        const conn = await dbPool.getConnection();
        try {
            await conn.ping();
        } finally {
            conn.release();
        }
        res.json({
            ok: true,
            pid: process.pid,
            redis: hasRedis ? Boolean(redisClient?.isReady) : false,
            sessionStore: sessionConfig.store ? sessionConfig.store.constructor.name : 'MemoryStore',
            poolLimit: DB_POOL_LIMIT
        });
    } catch (err) {
        res.status(503).json({ ok: false, error: 'database unavailable' });
    }
});

// Role-based access control guards
app.get('/admin/*', requireRole('admin'));
app.get('/teacher/*', requireRole('teacher'));
app.get('/student/*', requireRole('student'));
app.get('/parent/*', requireRole('parent'));

// Mount all application routes
app.use('/', routes);

// 404 handler - must be after every route
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page Not Found',
        error: { status: 404, message: 'The page you are looking for does not exist.' }
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(status).json({ success: false, error: err.message || 'Server error' });
    }
    res.status(status).render('error', {
        message: status === 503 ? 'Server Busy' : 'Something Went Wrong',
        error: { status, message: err.message || 'An unexpected error occurred.' }
    });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection (server kept alive):', reason);
});

const PORT = process.env.PORT || 3000;
let server = null;

async function startServer() {
    await ensureRedisConnected();

    server = app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT} (pid ${process.pid})`);
        console.log(`MySQL connection pool ready (limit: ${DB_POOL_LIMIT}, queue: ${DB_QUEUE_LIMIT})`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Stop the other server first:`);
            console.error(`  netstat -ano | findstr :${PORT}`);
            console.error(`  taskkill /PID <pid> /F`);
            process.exit(1);
        }
        console.error('Server failed to start:', err);
        process.exit(1);
    });

    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    if (typeof server.requestTimeout !== 'undefined') {
        server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
    }
}

if (!process.env.VERCEL) {
    startServer().catch((err) => {
        console.error('Server startup failed:', err.message);
        process.exit(1);
    });
}

function shutdown(signal) {
    console.log(`${signal} received — closing server and DB pool...`);
    const closeResources = async () => {
        try { await dbPool.end(); } catch (_) { /* ignore */ }
        try { if (redisClient) await redisClient.quit(); } catch (_) { /* ignore */ }
        process.exit(0);
    };

    if (server?.listening) {
        server.close(closeResources);
    } else {
        closeResources();
    }
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
    DB_QUEUE_LIMIT
} = require('./config/db');
const { requireRole } = require('./middleware/auth');
const { studentDisplayName } = require('./utils/helpers');
const routes = require('./routes');

const app = express();

// Trust proxy for rate limiting behind reverse proxies
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Request timeout
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;
app.use((req, res, next) => {
    req.setTimeout(REQUEST_TIMEOUT_MS);
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(504).send('Request timeout');
        }
    });
    next();
});

// Global Rate Limiter
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false
}));

// ---------------------------------------------------------------------------
// Session configuration
//
// CRITICAL: When running under cluster.js with WEB_CONCURRENCY > 1, sessions
// MUST be stored in a shared store (Redis). With the default MemoryStore each
// worker keeps its own copy, so a request routed to a different worker sees no
// session and the user is effectively logged out.
// ---------------------------------------------------------------------------
let redisClient = null;
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
};

const isProduction = process.env.NODE_ENV === 'production';
const hasRedis = Boolean(process.env.REDIS_URL);
const workerCount = Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);

if (hasRedis) {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default;
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis session store error:', err.message));
    sessionConfig.store = new RedisStore({ client: redisClient, prefix: 'smsess:' });
    console.log('Session store: Redis');
} else {
    console.warn('REDIS_URL not set — using in-memory sessions (not for thousands of users)');
    if (workerCount > 1) {
        console.warn(
            `WEB_CONCURRENCY=${workerCount}, but no shared session store is configured. ` +
            'cluster.js limits this process to one worker; configure Redis before scaling out.'
        );
    }
}

app.use(session(sessionConfig));

// Return pooled connections when the HTTP response completes
app.use((req, res, next) => {
    const connections = new Set();
    const cleanup = () => {
        for (const conn of connections) {
            try { conn.release(); } catch (_) { /* already released */ }
        }
        connections.clear();
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    requestDbStorage.run({ connections }, next);
});

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views', 'school_app'));

function injectFeedbackAssets(html) {
    if (typeof html !== 'string') return html;

    let updatedHtml = html;
    if (!updatedHtml.includes('/assets/css/form-feedback.css')) {
        updatedHtml = updatedHtml.replace('</head>', '<link rel="stylesheet" href="/assets/css/form-feedback.css"></head>');
    }
    if (!updatedHtml.includes('/assets/js/form-feedback.js')) {
        updatedHtml = updatedHtml.replace('</body>', '<script src="/assets/js/form-feedback.js"></script></body>');
    }
    return updatedHtml;
}

// Global view locals for role-aware layouts
app.use((req, res, next) => {
    const role = req.session?.role || (req.session?.parentId ? 'parent' : null);
    res.locals.role = role;
    res.locals.userRole = role;
    res.locals.username = req.session?.username || req.session?.parentName || '';
    res.locals.userId = req.session?.userId || req.session?.parentId || null;
    res.locals.session = req.session;
    next();
});

app.use((req, res, next) => {
    const originalRender = res.render.bind(res);

    res.render = function (view, options, callback) {
        if (typeof options === 'function') {
            return originalRender(view, {}, options);
        }

        const renderOptions = options || {};
        const done = typeof callback === 'function'
            ? callback
            : function (err, html) {
                if (err) {
                    if (!res.headersSent) {
                        return res.status(500).send(err.message || err);
                    }
                    return;
                }

                if (typeof html === 'string') {
                    html = injectFeedbackAssets(html);
                }

                res.send(html);
            };

        return originalRender(view, renderOptions, done);
    };

    next();
});

// App locals
app.locals.studentDisplayName = studentDisplayName;

// Serve static files (CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
    if (hasRedis && !redisClient?.isReady) {
        return res.status(503).json({ ok: false, error: 'session store unavailable' });
    }

    try {
        const conn = await dbPool.getConnection();
        try {
            await conn.ping();
        } finally {
            conn.release();
        }
        res.json({
            ok: true,
            pid: process.pid,
            redis: hasRedis ? Boolean(redisClient?.isReady) : false,
            sessionStore: sessionConfig.store ? sessionConfig.store.constructor.name : 'MemoryStore',
            poolLimit: DB_POOL_LIMIT
        });
    } catch (err) {
        res.status(503).json({ ok: false, error: 'database unavailable' });
    }
});

// Role-based access control guards
app.get('/admin/*', requireRole('admin'));
app.get('/teacher/*', requireRole('teacher'));
app.get('/student/*', requireRole('student'));
app.get('/parent/*', requireRole('parent'));

// Mount all application routes
app.use('/', routes);

// 404 handler - must be after every route
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page Not Found',
        error: { status: 404, message: 'The page you are looking for does not exist.' }
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(status).json({ success: false, error: err.message || 'Server error' });
    }
    res.status(status).render('error', {
        message: status === 503 ? 'Server Busy' : 'Something Went Wrong',
        error: { status, message: err.message || 'An unexpected error occurred.' }
    });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection (server kept alive):', reason);
});

const PORT = process.env.PORT || 3000;
let server = null;

async function startServer() {
    if (redisClient && !redisClient.isReady) {
        await redisClient.connect();
    }

    server = app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT} (pid ${process.pid})`);
        console.log(`MySQL connection pool ready (limit: ${DB_POOL_LIMIT}, queue: ${DB_QUEUE_LIMIT})`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Stop the other server first:`);
            console.error(`  netstat -ano | findstr :${PORT}`);
            console.error(`  taskkill /PID <pid> /F`);
            process.exit(1);
        }
        console.error('Server failed to start:', err);
        process.exit(1);
    });

    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    if (typeof server.requestTimeout !== 'undefined') {
        server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
    }
}

startServer().catch((err) => {
    console.error('Server startup failed:', err.message);
    process.exit(1);
});

function shutdown(signal) {
    console.log(`${signal} received — closing server and DB pool...`);
    const closeResources = async () => {
        try { await dbPool.end(); } catch (_) { /* ignore */ }
        try { if (redisClient) await redisClient.quit(); } catch (_) { /* ignore */ }
        process.exit(0);
    };

    if (server?.listening) {
        server.close(closeResources);
    } else {
        closeResources();
    }
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
