const { getConnection } = require('../config/db');

async function check() {
    const conn = await getConnection();
    const [pcols] = await conn.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'parent_notifications'");
    const [acols] = await conn.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_notifications'");
    console.log({
        parent_notifications: pcols.map(c => c.COLUMN_NAME),
        admin_notifications: acols.map(c => c.COLUMN_NAME)
    });
    conn.release();
    process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
