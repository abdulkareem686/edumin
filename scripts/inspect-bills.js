const { getConnection } = require('../config/db');

async function check() {
    const conn = await getConnection();
    const [cols] = await conn.execute("SHOW COLUMNS FROM class_bills LIKE 'term'");
    console.log('term column in class_bills:', cols);
    const [feeTermCols] = await conn.execute("SHOW COLUMNS FROM fees LIKE 'term'");
    console.log('term column in fees:', feeTermCols);
    conn.release();
    process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
