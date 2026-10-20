require('dotenv').config();
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}
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
    DB_QUEUE_LIMIT,
    supabase,
    supabaseAdmin,
    checkSupabaseHealth,
    isSupabaseConfigured
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

// Session configuration
let redisClient = null;
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
    }
};

if (process.env.REDIS_URL) {
    try {
        const { createClient } = require('redis');
        const RedisStore = require('connect-redis').default;
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.error('Redis session store error:', err.message));
        redisClient.connect().catch((err) => console.error('Redis connect failed:', err.message));
        sessionConfig.store = new RedisStore({ client: redisClient, prefix: 'smsess:' });
        console.log('Session store: Redis');
    } catch (err) {
        console.warn('Redis session store unavailable:', err.message);
    }
} else {
    console.warn('REDIS_URL not set — using in-memory sessions (not for thousands of users)');
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
    // Attach Supabase to request and view locals
    req.supabase = supabase;
    req.supabaseAdmin = supabaseAdmin;
    res.locals.supabase = supabase;

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
    let dbStatus = false;
    let supabaseStatus = { ok: false };
    try {
        const conn = await dbPool.getConnection();
        try {
            await conn.ping();
            dbStatus = true;
        } finally {
            conn.release();
        }
    } catch (_) {
        dbStatus = false;
    }

    try {
        supabaseStatus = await checkSupabaseHealth();
    } catch (err) {
        supabaseStatus = { ok: false, error: err.message };
    }

    const isHealthy = dbStatus || supabaseStatus.ok;
    res.status(isHealthy ? 200 : 503).json({
        ok: isHealthy,
        pid: process.pid,
        database: dbStatus ? 'connected' : 'unavailable',
        supabase: supabaseStatus,
        redis: Boolean(process.env.REDIS_URL),
        poolLimit: DB_POOL_LIMIT
    });
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
const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT} (pid ${process.pid})`);
    console.log(`Database connection pool ready (limit: ${DB_POOL_LIMIT}, queue: ${DB_QUEUE_LIMIT})`);
    if (isSupabaseConfigured()) {
        console.log(`Supabase data connection active: ${process.env.SUPABASE_URL}`);
    }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
if (typeof server.requestTimeout !== 'undefined') {
    server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
}
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

function shutdown(signal) {
    console.log(`${signal} received — closing server and DB pool...`);
    server.close(async () => {
        try { await dbPool.end(); } catch (_) { /* ignore */ }
        try { if (redisClient) await redisClient.quit(); } catch (_) { /* ignore */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;