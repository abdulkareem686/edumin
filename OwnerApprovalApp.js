const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const path = require('path');
const moment = require('moment');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'owner-approval-secret', resave: false, saveUninitialized: true }));

// Works both in current location and when moved to project root.
const projectRoot = path.basename(__dirname).toLowerCase() === 'school_app'
    ? path.join(__dirname, '..', '..')
    : __dirname;

app.set('view engine', 'ejs');
app.set('views', path.join(projectRoot, 'views', 'owner_app'));
app.use(express.static(path.join(projectRoot, 'public')));

const OWNER_APP_PORT = Number(process.env.OWNER_APP_PORT || 4001);
const OWNER_APP_USER = process.env.OWNER_APP_USER || 'owner';
const OWNER_APP_PASS = process.env.OWNER_APP_PASS || 'owner123';

async function getConnection() {
    return await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: 'inshallah',
        database: 'school_management'
    });
}

const __columnExistsCache = new Map();
async function tableHasColumn(connection, tableName, columnName) {
    const key = `${tableName}.${columnName}`;
    if (__columnExistsCache.has(key)) return __columnExistsCache.get(key);

    const [rows] = await connection.execute(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [tableName, columnName]
    );
    const exists = Number(rows?.[0]?.cnt || 0) > 0;
    __columnExistsCache.set(key, exists);
    return exists;
}

function requireOwnerAuth(req, res, next) {
    if (req.session && req.session.ownerAuthenticated) return next();
    return res.redirect('/login');
}

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === OWNER_APP_USER && password === OWNER_APP_PASS) {
        req.session.ownerAuthenticated = true;
        return res.redirect('/');
    }
    return res.render('login', { error: 'Invalid owner credentials' });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireOwnerAuth, async (req, res) => {
    try {
        const connection = await getConnection();
        const [requests] = await connection.execute(
            `SELECT
                sr.id,
                sr.request_type,
                sr.status,
                sr.requested_at,
                si.id AS school_id,
                si.name AS school_name,
                si.email AS school_email
             FROM subscription_requests sr
             JOIN school_info si ON si.id = sr.school_id
             WHERE sr.status = 'pending'
             ORDER BY sr.requested_at DESC`
        );

        res.render('owner-approval', {
            requests,
            error: req.session.error || null,
            success: req.session.success || null,
            moment
        });
        delete req.session.error;
        delete req.session.success;
    } catch (error) {
        console.error('Error loading approval dashboard:', error);
        res.render('owner-approval', {
            requests: [],
            error: 'Failed to load requests',
            success: null,
            moment
        });
    }
});

app.post('/decide/:id', requireOwnerAuth, async (req, res) => {
    try {
        const connection = await getConnection();
        const requestId = req.params.id;
        const action = String(req.body.action || '');
        if (action !== 'approve' && action !== 'reject') {
            req.session.error = 'Invalid action.';
            return res.redirect('/');
        }

        const [reqRows] = await connection.execute(
            `SELECT * FROM subscription_requests WHERE id = ? AND status = 'pending' LIMIT 1`,
            [requestId]
        );
        if (!reqRows.length) {
            req.session.error = 'Request not found or already decided.';
            return res.redirect('/');
        }

        const request = reqRows[0];

        if (action === 'reject') {
            await connection.execute(
                `UPDATE subscription_requests SET status = 'rejected', decided_at = NOW() WHERE id = ?`,
                [requestId]
            );
            req.session.success = 'Request rejected.';
            return res.redirect('/');
        }

        const hasStatusCol = await tableHasColumn(connection, 'school_info', 'subscription_status');
        const hasTrialEndCol = await tableHasColumn(connection, 'school_info', 'trial_end');
        const hasSubEndCol = await tableHasColumn(connection, 'school_info', 'subscription_end');

        if (hasStatusCol) {
            if (request.request_type === 'trial') {
                const trialEnd = moment().add(1, 'month').format('YYYY-MM-DD');
                if (hasTrialEndCol) {
                    await connection.execute(
                        `UPDATE school_info
                         SET subscription_status = 'trial', trial_end = ?, subscription_end = NULL
                         WHERE id = ?`,
                        [trialEnd, request.school_id]
                    );
                } else {
                    await connection.execute(
                        `UPDATE school_info SET subscription_status = 'trial' WHERE id = ?`,
                        [request.school_id]
                    );
                }
            } else if (request.request_type === 'payment') {
                const [schoolRows] = await connection.execute(
                    `SELECT subscription_status, trial_end, subscription_end
                     FROM school_info
                     WHERE id = ? LIMIT 1`,
                    [request.school_id]
                );
                const school = schoolRows[0] || {};
                const today = moment();

                if (school.subscription_status === 'trial' && school.trial_end && today.isSameOrBefore(moment(school.trial_end))) {
                    const subEnd = moment(school.trial_end).add(1, 'month').format('YYYY-MM-DD');
                    if (hasSubEndCol) {
                        await connection.execute(
                            `UPDATE school_info SET subscription_status = 'active', subscription_end = ? WHERE id = ?`,
                            [subEnd, request.school_id]
                        );
                    } else {
                        await connection.execute(
                            `UPDATE school_info SET subscription_status = 'active' WHERE id = ?`,
                            [request.school_id]
                        );
                    }
                } else {
                    const trialEnd = moment().add(1, 'month').format('YYYY-MM-DD');
                    const subEnd = moment().add(2, 'months').format('YYYY-MM-DD');
                    if (hasTrialEndCol && hasSubEndCol) {
                        await connection.execute(
                            `UPDATE school_info
                             SET subscription_status = 'active', trial_end = ?, subscription_end = ?
                             WHERE id = ?`,
                            [trialEnd, subEnd, request.school_id]
                        );
                    } else if (hasSubEndCol) {
                        await connection.execute(
                            `UPDATE school_info SET subscription_status = 'active', subscription_end = ? WHERE id = ?`,
                            [subEnd, request.school_id]
                        );
                    } else {
                        await connection.execute(
                            `UPDATE school_info SET subscription_status = 'active' WHERE id = ?`,
                            [request.school_id]
                        );
                    }
                }
            }
        }

        await connection.execute(
            `UPDATE subscription_requests SET status = 'approved', decided_at = NOW() WHERE id = ?`,
            [requestId]
        );

        req.session.success = 'Request approved.';
        return res.redirect('/');
    } catch (error) {
        console.error('Error deciding request:', error);
        req.session.error = 'Failed to process request.';
        return res.redirect('/');
    }
});

app.listen(OWNER_APP_PORT, () => {
    console.log(`Owner approval app running on http://localhost:${OWNER_APP_PORT}`);
});

