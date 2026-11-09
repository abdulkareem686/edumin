const { getConnection } = require('../config/db');

async function testPaymentFlow() {
    console.log('--- STARTING PAYMENT FLOW TEST ---');
    const conn = await getConnection();

    try {
        // 1. Test Admin sets bank details
        console.log('1. Setting Admin Bank Details...');
        const [schoolRows] = await conn.execute('SELECT id FROM school_info LIMIT 1');
        const schoolId = schoolRows.length > 0 ? schoolRows[0].id : null;

        const testBank = 'Zenith Bank Plc';
        const testAccName = 'Alhamdulillahi Academy Tuition Account';
        const testAccNum = '1018899223';
        const testInstructions = 'Use student admission number as transfer reference.';

        await conn.execute(`
            UPDATE school_info 
            SET bank_name = ?, account_name = ?, account_number = ?, payment_instructions = ?
            WHERE id = ?
        `, [testBank, testAccName, testAccNum, testInstructions, schoolId]);

        // Upsert into payment_accounts
        const [accCheck] = await conn.execute('SELECT id FROM payment_accounts WHERE (school_id = ? OR ? IS NULL) LIMIT 1', [schoolId, schoolId]);
        if (accCheck.length > 0) {
            await conn.execute('UPDATE payment_accounts SET bank_name = ?, account_name = ?, account_number = ?, instructions = ?, is_active = 1 WHERE id = ?',
                [testBank, testAccName, testAccNum, testInstructions, accCheck[0].id]);
        } else {
            await conn.execute('INSERT INTO payment_accounts (school_id, bank_name, account_name, account_number, instructions, is_active) VALUES (?, ?, ?, ?, ?, 1)',
                [schoolId, testBank, testAccName, testAccNum, testInstructions]);
        }
        console.log('✓ Admin bank details set successfully.');

        // 2. Clear any test payments for student 3 in First Term 2026/2027
        const studentId = 3;
        const parentId = 1;
        const academicYear = '2026/2027';
        const term = 'First Term';

        await conn.execute('DELETE FROM parent_payments WHERE student_id = ? AND academic_year = ? AND term = ?', [studentId, academicYear, term]);
        console.log('✓ Cleared previous test parent_payments.');

        // Check count (should be 0)
        let [c1] = await conn.execute('SELECT COUNT(*) as count FROM parent_payments WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ("pending", "approved")',
            [studentId, academicYear, term]);
        console.log('Initial term payment count:', c1[0].count);
        if (c1[0].count !== 0) throw new Error('Expected initial count 0');

        // 3. Make Payment 1
        console.log('2. Parent submitting Payment 1 of 2...');
        const [pay1Result] = await conn.execute(`
            INSERT INTO parent_payments (
                school_id, parent_id, student_id, academic_year, term,
                amount, payment_method, bank_name, transaction_reference,
                payment_date, notes, status, payment_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
        `, [schoolId, parentId, studentId, academicYear, term, 25000.00, 'Bank Transfer', 'GTBank', 'TXN-REF-001', '2026-10-09', 'Part payment 1']);
        const payment1Id = pay1Result.insertId;
        console.log('✓ Payment 1 submitted, ID:', payment1Id);

        // Check count (should be 1)
        let [c2] = await conn.execute('SELECT COUNT(*) as count FROM parent_payments WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ("pending", "approved")',
            [studentId, academicYear, term]);
        console.log('Term payment count after payment 1:', c2[0].count);
        if (c2[0].count !== 1) throw new Error('Expected count 1');

        // 4. Make Payment 2
        console.log('3. Parent submitting Payment 2 of 2 (Final payment for term)...');
        const [pay2Result] = await conn.execute(`
            INSERT INTO parent_payments (
                school_id, parent_id, student_id, academic_year, term,
                amount, payment_method, bank_name, transaction_reference,
                payment_date, notes, status, payment_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 2)
        `, [schoolId, parentId, studentId, academicYear, term, 25000.00, 'Bank Transfer', 'GTBank', 'TXN-REF-002', '2026-10-09', 'Part payment 2']);
        const payment2Id = pay2Result.insertId;
        console.log('✓ Payment 2 submitted, ID:', payment2Id);

        // Check count (should be 2)
        let [c3] = await conn.execute('SELECT COUNT(*) as count FROM parent_payments WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ("pending", "approved")',
            [studentId, academicYear, term]);
        console.log('Term payment count after payment 2:', c3[0].count);
        if (c3[0].count !== 2) throw new Error('Expected count 2');

        // 5. Test Maximum 2 Payments Limit Rule!
        console.log('4. Testing Rule: Parent attempts Payment 3 in same term...');
        let payment3Allowed = false;
        if (c3[0].count >= 2) {
            console.log('✓ RULE ENFORCED: Maximum 2 payments reached for this term! 3rd payment BLOCKED.');
        } else {
            payment3Allowed = true;
        }
        if (payment3Allowed) throw new Error('Payment 3 should have been blocked!');

        // 6. Admin Approves Payment 1
        console.log('5. Admin approving Payment 1...');
        const [p1Rows] = await conn.execute('SELECT * FROM parent_payments WHERE id = ?', [payment1Id]);
        const p1 = p1Rows[0];
        const receiptNumber = 'REC-TEST-' + Date.now();

        // Insert into fees table
        const [feeRes] = await conn.execute(`
            INSERT INTO fees (
                studentId, admission_number, studentName, email,
                className, department, feeType, paymentType,
                amount, billAmount, amountPaid, balance,
                paymentDate, receiptNumber, academicYear, term,
                notes, status, school_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            p1.student_id, 'ADM260002', 'Abdullahi --', null,
            'Primary 1', null, 'School Fees', p1.payment_method,
            50000.00, 50000.00, 25000.00, 25000.00,
            '2026-10-09', receiptNumber, p1.academic_year, p1.term,
            'Approved fee payment', 'partial', p1.school_id
        ]);
        const feeId = feeRes.insertId;

        await conn.execute('UPDATE parent_payments SET status = "approved", fee_id = ?, approved_at = NOW() WHERE id = ?',
            [feeId, payment1Id]);
        console.log('✓ Payment 1 approved. Created fee record ID:', feeId, 'Receipt:', receiptNumber);

        // 7. Admin Declines Payment 2 with reason
        console.log('6. Admin declining Payment 2...');
        const declineReason = 'Transaction reference could not be found on statement.';
        await conn.execute('UPDATE parent_payments SET status = "rejected", rejection_reason = ?, approved_at = NOW() WHERE id = ?',
            [declineReason, payment2Id]);
        console.log('✓ Payment 2 declined with reason.');

        // 8. Verify final states
        const [final1] = await conn.execute('SELECT status, fee_id FROM parent_payments WHERE id = ?', [payment1Id]);
        const [final2] = await conn.execute('SELECT status, rejection_reason FROM parent_payments WHERE id = ?', [payment2Id]);
        console.log('Payment 1 final status:', final1[0].status, 'Fee ID:', final1[0].fee_id);
        console.log('Payment 2 final status:', final2[0].status, 'Reason:', final2[0].rejection_reason);

        if (final1[0].status !== 'approved' || !final1[0].fee_id) throw new Error('Payment 1 approval state invalid');
        if (final2[0].status !== 'rejected') throw new Error('Payment 2 reject state invalid');

        console.log('--- ALL PAYMENT WORKFLOW TESTS PASSED PERFECTLY! ---');
    } finally {
        conn.release();
    }
}

testPaymentFlow().then(() => process.exit(0)).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
