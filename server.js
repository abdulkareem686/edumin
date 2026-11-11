
require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

const {
    dbPool,
    requestDbStorage,
    DB_POOL_LIMIT,
    DB_QUEUE_LIMIT
} = require('./config/db');

const { authenticate, requireRole } = require('./middleware/auth');
const { studentDisplayName } = require('./utils/helpers');
const routes = require('./routes');

const app = express();

// Environment
const isVercel =
    process.env.VERCEL === '1' ||
    process.env.VERCEL === 'true';

const isProduction = process.env.NODE_ENV === 'production';

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS =
    Number(process.env.REQUEST_TIMEOUT_MS) || 30000;

// Require a proper session secret in production
if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error(
        'SESSION_SECRET is required in production.'
    );
}

const SESSION_SECRET =
    process.env.SESSION_SECRET || 'local-development-secret';

// ---------------------------------------------------------------------
// EXPRESS CONFIGURATION
// ---------------------------------------------------------------------

app.set('trust proxy', 1);

app.use(compression());

app.use(express.json({
    limit: '2mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '2mb'
}));

// ---------------------------------------------------------------------
// REQUEST TIMEOUT
// ---------------------------------------------------------------------

app.use((req, res, next) => {
    req.setTimeout(REQUEST_TIMEOUT_MS);

    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent && !res.writableEnded) {
            console.error(
                'Request timeout:',
                req.method,
                req.originalUrl
            );

            res.status(504).send('Request timeout');
        }
    });

    next();
});

// ---------------------------------------------------------------------
// RATE LIMITING
// ---------------------------------------------------------------------

app.use(rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false
}));

// ---------------------------------------------------------------------
// REDIS SESSION CONFIGURATION
// ---------------------------------------------------------------------

let redisClient = null;
let redisConnectPromise = null;

const hasRedis = Boolean(process.env.REDIS_URL);

const workerCount = Math.max(
    1,
    Number(process.env.WEB_CONCURRENCY) || 1
);

const sessionConfig = {
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    rolling: true,

    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto'
    }
};

// Vercel requires a shared session store.
// Do not use Express MemoryStore in production.
if (isVercel && !hasRedis) {
    throw new Error(
        'REDIS_URL is required on Vercel. Configure Redis before deploying.'
    );
}

if (hasRedis) {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default;

    redisClient = createClient({
        url: process.env.REDIS_URL
    });

    redisClient.on('error', err => {
        console.error(
            'Redis session store error:',
            err.message
        );
    });

    redisClient.on('ready', () => {
        console.log('Redis session store is ready.');
    });

    redisClient.on('reconnecting', () => {
        console.warn('Redis is reconnecting...');
    });

    sessionConfig.store = new RedisStore({
        client: redisClient,
        prefix: 'smsess:'
    });

    console.log('Session store: Redis');

} else {
    console.warn(
        'REDIS_URL not configured. Using in-memory sessions.'
    );

    if (workerCount > 1) {
        console.warn(
            'Multiple workers are configured without a shared session store.'
        );
    }
}

// Connect Redis safely.
// Prevent multiple simultaneous connection attempts.
async function ensureRedisConnected() {
    if (!redisClient) {
        return;
    }

    if (redisClient.isReady) {
        return;
    }

    if (!redisConnectPromise) {
        redisConnectPromise = (async () => {

            if (!redisClient.isOpen) {
                await redisClient.connect();
            }

            if (!redisClient.isReady) {
                throw new Error(
                    'Redis client connected but is not ready.'
                );
            }

        })().finally(() => {
            redisConnectPromise = null;
        });
    }

    await redisConnectPromise;
}

// Expose readiness function
app.locals.ready = ensureRedisConnected;

// IMPORTANT:
// Connect Redis BEFORE express-session uses the Redis store.
app.use(async (req, res, next) => {
    try {
        await ensureRedisConnected();
        next();

    } catch (err) {
        console.error(
            'Redis connection failed:',
            err.message
        );

        if (!res.headersSent && !res.writableEnded) {
            return res.status(503).send(
                'Session service temporarily unavailable. Please try again.'
            );
        }
    }
});

// Session middleware runs only after Redis readiness middleware.
app.use(session(sessionConfig));

// ---------------------------------------------------------------------
// REQUEST-LEVEL DATABASE CONNECTION MANAGEMENT
// ---------------------------------------------------------------------

app.use((req, res, next) => {

    const connections = new Set();
    let cleaned = false;

    const cleanup = () => {
        if (cleaned) return;

        cleaned = true;

        for (const connection of connections) {
            try {
                connection.release();
            } catch (err) {
                console.error(
                    'Database connection cleanup error:',
                    err.message
                );
            }
        }

        connections.clear();
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);

    requestDbStorage.run(
        {
            connections,
            primaryConnection: null
        },
        next
    );
});

// ---------------------------------------------------------------------
// EJS CONFIGURATION
// ---------------------------------------------------------------------

app.set('view engine', 'ejs');

app.set(
    'views',
    path.join(__dirname, 'views', 'school_app')
);

// ---------------------------------------------------------------------
// FEEDBACK ASSETS
// ---------------------------------------------------------------------

function injectFeedbackAssets(html) {
    if (typeof html !== 'string') {
        return html;
    }

    let updatedHtml = html;

    if (
        !updatedHtml.includes(
            '/assets/css/form-feedback.css'
        )
    ) {
        updatedHtml = updatedHtml.replace(
            '</head>',
            '<link rel="stylesheet" href="/assets/css/form-feedback.css"></head>'
        );
    }

    if (
        !updatedHtml.includes(
            '/assets/js/form-feedback.js'
        )
    ) {
        updatedHtml = updatedHtml.replace(
            '</body>',
            '<script src="/assets/js/form-feedback.js"></script></body>'
        );
    }

    return updatedHtml;
}

// ---------------------------------------------------------------------
// GLOBAL VIEW LOCALS
// ---------------------------------------------------------------------

app.use((req, res, next) => {

    const role =
        req.session?.role ||
        (req.session?.parentId ? 'parent' : null);

    res.locals.role = role;
    res.locals.userRole = role;

    res.locals.username =
        req.session?.username ||
        req.session?.parentName ||
        '';

    res.locals.userId =
        req.session?.userId ||
        req.session?.parentId ||
        null;

    res.locals.session = req.session;

    next();
});

// ---------------------------------------------------------------------
// GLOBAL EJS RENDER OVERRIDE
// ---------------------------------------------------------------------

app.use((req, res, next) => {

    const originalRender = res.render.bind(res);

    res.render = function (view, options, callback) {

        if (typeof options === 'function') {
            return originalRender(view, {}, options);
        }

        const renderOptions = options || {};

        const done =
            typeof callback === 'function'
                ? callback
                : function (err, html) {

                    if (err) {
                        console.error(
                            'View rendering error:',
                            err
                        );

                        if (!res.headersSent) {
                            return res.status(500).send(
                                'Unable to render this page.'
                            );
                        }

                        return;
                    }

                    if (typeof html === 'string') {
                        html = injectFeedbackAssets(html);
                    }

                    res.send(html);
                };

        return originalRender(
            view,
            renderOptions,
            done
        );
    };

    next();
});

// ---------------------------------------------------------------------
// APP LOCALS
// ---------------------------------------------------------------------

app.locals.studentDisplayName = studentDisplayName;

// ---------------------------------------------------------------------
// STATIC FILES
// ---------------------------------------------------------------------

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

// ---------------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------------

app.get('/health', async (req, res) => {

    if (hasRedis && !redisClient?.isReady) {
        return res.status(503).json({
            ok: false,
            error: 'Session store unavailable'
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();

        await connection.ping();

        return res.json({
            ok: true,
            message: 'EduSuite is running.',
            pid: process.pid,

            redis: hasRedis
                ? Boolean(redisClient?.isReady)
                : false,

            sessionStore: sessionConfig.store
                ? 'Redis'
                : 'MemoryStore',

            database: 'connected',

            poolLimit: DB_POOL_LIMIT,
            queueLimit: DB_QUEUE_LIMIT
        });

    } catch (err) {

        console.error(
            'Health check failed:',
            err.code,
            err.message
        );

        return res.status(503).json({
            ok: false,
            error: 'Database unavailable'
        });

    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// ---------------------------------------------------------------------
// ROLE-BASED ACCESS CONTROL
// ---------------------------------------------------------------------

// `authenticate` must run first. Without it these prefix guards answer with a
// 403 "Access Denied" page for signed-out visitors instead of redirecting them
// to the login screen (which is what a plain GET on a portal URL should do).
app.get('/admin/*', authenticate, requireRole('admin'));

app.get('/teacher/*', authenticate, requireRole('teacher'));

app.get('/student/*', authenticate, requireRole('student'));

app.get('/parent/*', authenticate, requireRole('parent'));

// ---------------------------------------------------------------------
// APPLICATION ROUTES
// ---------------------------------------------------------------------

app.use('/', routes);

// ---------------------------------------------------------------------
// 404 HANDLER
// ---------------------------------------------------------------------

app.use((req, res) => {

    res.status(404).render('error', {
        message: 'Page Not Found',

        error: {
            status: 404,
            message: 'The page you are looking for does not exist.'
        }
    });
});

// ---------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// ---------------------------------------------------------------------

app.use((err, req, res, next) => {

    console.error('Global error handler:', {
        message: err.message,
        code: err.code,
        stack: err.stack
    });

    if (res.headersSent) {
        return next(err);
    }

    const status = err.status || 500;

    if (req.path && req.path.startsWith('/api/')) {
        return res.status(status).json({
            success: false,
            error: err.message || 'Server error'
        });
    }

    return res.status(status).render('error', {
        message:
            status === 503
                ? 'Server Busy'
                : 'Something Went Wrong',

        error: {
            status,
            message: err.message || 'An unexpected error occurred.'
        }
    });
});

// ---------------------------------------------------------------------
// PROCESS ERROR HANDLERS
// ---------------------------------------------------------------------

process.on('uncaughtException', err => {

    console.error('Uncaught Exception:', err);

    if (err.code === 'EADDRINUSE') {
        process.exit(1);
    }
});

process.on('unhandledRejection', reason => {
    console.error(
        'Unhandled Rejection:',
        reason
    );
});

// ---------------------------------------------------------------------
// LOCAL SERVER STARTUP
// ---------------------------------------------------------------------

let server = null;

async function startServer() {

    // Local development must connect Redis before accepting requests.
    await ensureRedisConnected();

    server = app.listen(PORT, () => {

        console.log(
            `EduSuite running at http://localhost:${PORT}`
        );

        console.log(
            `MySQL pool limit: ${DB_POOL_LIMIT}`
        );

        console.log(
            `MySQL queue limit: ${DB_QUEUE_LIMIT}`
        );

        console.log(
            `Redis ready: ${hasRedis ? Boolean(redisClient?.isReady) : false}`
        );
    });

    server.on('error', err => {

        if (err.code === 'EADDRINUSE') {

            console.error(
                `Port ${PORT} is already in use.`
            );

            console.error(
                `Run: netstat -ano | findstr :${PORT}`
            );

            process.exit(1);
        }

        console.error(
            'Server startup failed:',
            err
        );

        process.exit(1);
    });

    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    if (typeof server.requestTimeout !== 'undefined') {
        server.requestTimeout =
            REQUEST_TIMEOUT_MS + 5000;
    }
}

// Vercel imports the Express app.
// Local environments start their own HTTP server.
if (!isVercel) {

    startServer().catch(err => {

        console.error(
            'Application startup failed:',
            err.message
        );

        process.exit(1);
    });
}

// ---------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------

let shutdownStarted = false;

async function shutdown(signal) {

    if (shutdownStarted) return;

    shutdownStarted = true;

    console.log(
        `${signal} received. Closing application resources...`
    );

    const closeResources = async () => {

        try {
            await dbPool.end();
        } catch (err) {
            console.error(
                'Database shutdown error:',
                err.message
            );
        }

        try {
            if (redisClient?.isOpen) {
                await redisClient.quit();
            }
        } catch (err) {
            console.error(
                'Redis shutdown error:',
                err.message
            );
        }

        process.exit(0);
    };

    if (server?.listening) {
        server.close(() => {
            closeResources();
        });
    } else {
        await closeResources();
    }

    setTimeout(() => {
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

process.on('SIGINT', () => {
    shutdown('SIGINT');
});

// ---------------------------------------------------------------------
// EXPORT APPLICATION
// ---------------------------------------------------------------------

module.exports = app;
