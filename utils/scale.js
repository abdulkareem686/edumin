'use strict';

const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const hotCache = new NodeCache({ stdTTL: 60, checkperiod: 120, useClones: false });

function parsePage(req, defaults = {}) {
    const maxLimit = defaults.maxLimit || 100;
    const defaultLimit = defaults.limit || 50;
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    return { page, limit, offset, q };
}

function searchLike(q) {
    return `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
}

async function getCachedSchoolInfo(connection, schoolId) {
    const key = `school_info:${schoolId || 'default'}`;
    const cached = hotCache.get(key);
    if (cached) return cached;

    const [rows] = schoolId
        ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
        : await connection.execute('SELECT * FROM school_info LIMIT 1');
    const school = rows[0] || null;
    if (school) hotCache.set(key, school);
    return school;
}

async function getCachedCurrentYearTerm(connection, schoolId) {
    const key = `year_term:${schoolId || 'all'}`;
    const cached = hotCache.get(key);
    if (cached) return cached;

    let yearName = null;
    let termName = null;
    try {
        const [years] = schoolId
            ? await connection.execute(
                'SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1',
                [schoolId]
            )
            : await connection.execute(
                'SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1'
            );
        yearName = years[0]?.year_name || null;
    } catch (_) { /* column/table may differ */ }

    try {
        const [terms] = schoolId
            ? await connection.execute(
                'SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1',
                [schoolId]
            )
            : await connection.execute(
                'SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1'
            );
        termName = terms[0]?.term_name || null;
    } catch (_) { /* ignore */ }

    const value = { yearName, termName };
    hotCache.set(key, value);
    return value;
}

async function tryApplyScaleIndexes(pool) {
    const sqlPath = path.join(__dirname, '..', 'sql', 'scale-indexes.sql');
    if (!fs.existsSync(sqlPath)) return;
    const raw = fs.readFileSync(sqlPath, 'utf8');
    const statements = raw
        .split(';')
        .map((s) => s.replace(/--[^\n]*/g, '').trim())
        .filter((s) => s.length > 10);

    const conn = await pool.getConnection();
    try {
        for (const stmt of statements) {
            try {
                await conn.query(stmt);
            } catch (err) {
                const msg = err.message || '';
                if (!/Duplicate key name|already exists|Unknown column|check that column|doesn't exist/i.test(msg)) {
                    console.warn('Index skip:', msg.split('\n')[0]);
                }
            }
        }
    } finally {
        conn.release();
    }
}

module.exports = {
    hotCache,
    parsePage,
    searchLike,
    getCachedSchoolInfo,
    getCachedCurrentYearTerm,
    tryApplyScaleIndexes
};
