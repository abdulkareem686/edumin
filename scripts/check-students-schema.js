const { getConnection } = require('../config/db');

async function check() {
    try {
        const conn = await getConnection();
        const [cols] = await conn.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students'");
        console.log('Students columns:', cols.map(c => c.COLUMN_NAME));
        conn.release();
    } catch (e) {
        console.log('DB error (might be using Supabase/Postgres or MySQL):', e.message);
    }
    process.exit(0);
}

check();
