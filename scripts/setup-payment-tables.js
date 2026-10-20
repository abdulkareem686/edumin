const { getConnection, dbPool } = require('../config/db');

async function setupTables() {
    console.log('Running setupTables...');
    const conn = await getConnection();
    try {
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS payment_accounts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                school_id INT DEFAULT NULL,
                bank_name VARCHAR(150) NOT NULL,
                account_name VARCHAR(150) NOT NULL,
                account_number VARCHAR(50) NOT NULL,
                instructions TEXT DEFAULT NULL,
                is_active TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('payment_accounts table ready');

        // Check columns in school_info
        const [cols] = await conn.execute(`
            SELECT COLUMN_NAME FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'school_info'
        `);
        const colNames = cols.map(c => c.COLUMN_NAME);

        if (!colNames.includes('bank_name')) {
            await conn.execute(`ALTER TABLE school_info ADD COLUMN bank_name VARCHAR(150) DEFAULT NULL`);
        }
        if (!colNames.includes('account_name')) {
            await conn.execute(`ALTER TABLE school_info ADD COLUMN account_name VARCHAR(150) DEFAULT NULL`);
        }
        if (!colNames.includes('account_number')) {
            await conn.execute(`ALTER TABLE school_info ADD COLUMN account_number VARCHAR(50) DEFAULT NULL`);
        }
        if (!colNames.includes('payment_instructions')) {
            await conn.execute(`ALTER TABLE school_info ADD COLUMN payment_instructions TEXT DEFAULT NULL`);
        }
        console.log('school_info columns ready');

        await conn.execute(`
            CREATE TABLE IF NOT EXISTS parent_payments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                school_id INT DEFAULT NULL,
                parent_id INT NOT NULL,
                student_id INT NOT NULL,
                academic_year VARCHAR(50) NOT NULL,
                term VARCHAR(50) NOT NULL,
                amount DECIMAL(12,2) NOT NULL,
                payment_method VARCHAR(50) DEFAULT 'Bank Transfer',
                bank_name VARCHAR(100) DEFAULT NULL,
                transaction_reference VARCHAR(100) DEFAULT NULL,
                payment_date DATE NOT NULL,
                proof_document VARCHAR(255) DEFAULT NULL,
                notes TEXT DEFAULT NULL,
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                rejection_reason TEXT DEFAULT NULL,
                payment_number INT DEFAULT 1,
                fee_id INT DEFAULT NULL,
                approved_by INT DEFAULT NULL,
                approved_at DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_parent_student_term (student_id, academic_year, term),
                INDEX idx_school_status (school_id, status)
            )
        `);
        console.log('parent_payments table ready');

    } finally {
        conn.release();
    }
}

if (require.main === module) {
    setupTables().then(() => {
        console.log('Setup completed successfully.');
        process.exit(0);
    }).catch(err => {
        console.error('Setup failed:', err);
        process.exit(1);
    });
}

module.exports = { setupTables };
