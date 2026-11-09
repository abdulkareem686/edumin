require('dotenv').config();
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const mysql = require('mysql2/promise');
const { supabaseAdmin, SUPABASE_URL, SUPABASE_SECRET_KEY } = require('../config/supabase');

if (!supabaseAdmin) {
    console.error('Supabase admin client not configured. Check .env variables.');
    process.exit(1);
}

// Strict migration order to respect foreign key constraints
const TABLE_ORDER = [
    'school_info',
    'users',
    'teachers',
    'classes',
    'subjects',
    'class_subjects',
    'academic_years',
    'academic_terms',
    'parents',
    'students',
    'parent_students',
    'system_settings',
    'payment_accounts',
    'fees',
    'class_bills',
    'parent_payments',
    'student_scores',
    'promotion_history',
    'question_banks',
    'question_bank_items',
    'questions',
    'question_options',
    'admin_notifications',
    'teacher_notifications',
    'parent_notifications'
];

async function fetchSupabaseDefinitions() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: { apikey: SUPABASE_SECRET_KEY }
    });
    const data = await res.json();
    return data.definitions || {};
}

function sanitizeAndMapRow(row, tableName, tableProperties) {
    const targetMap = {};
    if (tableProperties) {
        for (const key of Object.keys(tableProperties)) {
            targetMap[key.toLowerCase()] = key;
        }
    }

    const clean = {};
    for (const [key, value] of Object.entries(row)) {
        const lowerKey = key.toLowerCase();
        const targetKey = targetMap[lowerKey] || (tableProperties ? null : key);
        if (!targetKey) continue;

        // Skip generated columns in Postgres
        if (tableName === 'student_scores' && targetKey.toLowerCase() === 'total_score') {
            continue;
        }

        if (value instanceof Date) {
            clean[targetKey] = value.toISOString();
        } else if (Buffer.isBuffer(value)) {
            clean[targetKey] = value.toString('utf8');
        } else {
            clean[targetKey] = value;
        }
    }
    return clean;
}

async function migrateTable(conn, tableName, definitions) {
    try {
        const [rows] = await conn.execute(`SELECT * FROM \`${tableName}\``);
        if (!rows || rows.length === 0) {
            console.log(`[SKIP] Table ${tableName} is empty in MySQL.`);
            return;
        }

        const tableDef = definitions[tableName];
        const tableProperties = tableDef?.properties || null;

        console.log(`[MIGRATING] ${tableName}: ${rows.length} rows...`);

        const CHUNK_SIZE = 250;
        let successCount = 0;

        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            const chunk = rows.slice(i, i + CHUNK_SIZE).map((r) => sanitizeAndMapRow(r, tableName, tableProperties));
            const { error } = await supabaseAdmin
                .from(tableName)
                .upsert(chunk);

            if (error) {
                console.warn(`[WARN] Batch upsert for ${tableName} at offset ${i} failed (${error.message}). Retrying row-by-row...`);
                for (const row of chunk) {
                    const { error: rowErr } = await supabaseAdmin.from(tableName).upsert(row);
                    if (rowErr) {
                        console.error(`  Row error (${tableName} id=${row.id}):`, rowErr.message);
                    } else {
                        successCount++;
                    }
                }
            } else {
                successCount += chunk.length;
            }
        }

        console.log(`[DONE] ${tableName}: ${successCount}/${rows.length} rows synced to Supabase.`);
    } catch (err) {
        console.error(`[ERROR] Migrating table ${tableName}:`, err.message);
    }
}

async function runMigration() {
    console.log('--- Starting Schema-Aware Migration from MySQL to Supabase ---');
    const start = Date.now();

    console.log('Fetching Supabase schema definitions...');
    const definitions = await fetchSupabaseDefinitions();
    console.log(`Loaded ${Object.keys(definitions).length} table definitions.`);

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'inshallah',
        database: process.env.DB_NAME || 'school_management'
    });

    try {
        for (const table of TABLE_ORDER) {
            await migrateTable(conn, table, definitions);
        }
        console.log(`--- Migration Finished in ${((Date.now() - start) / 1000).toFixed(1)}s ---`);
    } finally {
        await conn.end();
    }
}

runMigration().catch((err) => {
    console.error('Fatal migration error:', err);
    process.exit(1);
});
