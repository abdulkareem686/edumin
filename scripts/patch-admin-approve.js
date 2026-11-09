const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../routes/adminRoutes.js');
let content = fs.readFileSync(filePath, 'utf8');

// Target block in approve handler
const targetOld = `        // Check if there is an existing bill or fee for this student, term, and academic year
        const [prevFees] = await connection.execute(\`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
            FROM fees
            WHERE studentId = ? AND academicYear = ? AND term = ?
        \`, [payment.student_id, payment.academic_year, payment.term]);

        const totalPaidSoFar = parseFloat(prevFees[0]?.totalPaid) || 0;
        let billAmount = parseFloat(prevFees[0]?.billAmount) || 0;

        // If no billAmount found in fees, check class_bills
        if (!billAmount && payment.classId) {
            const [classBills] = await connection.execute(\`
                SELECT cb.total_amount 
                FROM class_bills cb
                JOIN academic_years ay ON cb.academic_year_id = ay.id
                JOIN academic_terms at ON cb.term_id = at.id
                WHERE cb.class_id = ? AND ay.year_name = ? AND at.term_name = ?
                LIMIT 1
            \`, [payment.classId, payment.academic_year, payment.term]);

            if (classBills.length > 0) {
                billAmount = parseFloat(classBills[0].total_amount) || 0;
            }
        }

        // Calculate balance & status
        const effectiveBill = billAmount > 0 ? billAmount : amountValue;
        const totalPaidAfter = totalPaidSoFar + amountValue;
        let feeStatus = 'paid';
        let balance = 0;

        if (totalPaidAfter < effectiveBill) {
            feeStatus = 'partial';
            balance = effectiveBill - totalPaidAfter;
        } else if (totalPaidAfter > effectiveBill) {
            feeStatus = 'overpaid';
            balance = -(totalPaidAfter - effectiveBill);
        } else {
            feeStatus = 'paid';
            balance = 0;
        }

        const receiptNumber = 'REC-' + Date.now().toString().slice(-6) + '-' + Math.floor(100 + Math.random() * 900);
        const formattedDate = moment(payment.payment_date).format('YYYY-MM-DD');

        // Insert into fees table
        const [feeResult] = await connection.execute(\`
            INSERT INTO fees (
                studentId, admission_number, studentName, email,
                className, department, feeType, paymentType,
                amount, billAmount, amountPaid, balance,
                paymentDate, receiptNumber, academicYear, term,
                notes, status, school_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`, [
            payment.student_id,
            payment.admission_number || '',
            studentName,
            payment.studentEmail || null,
            payment.className || '',
            payment.department || null,
            payment.fee_type || 'School Fees',
            payment.payment_method || 'Bank Transfer',
            effectiveBill,
            effectiveBill,
            amountValue,
            balance,
            formattedDate,
            receiptNumber,
            payment.academic_year,
            payment.term,
            payment.notes ? \`Approved Portal Payment (Ref: \${payment.transaction_reference || 'N/A'}). Note: \${payment.notes}\` : \`Approved Portal Payment (Ref: \${payment.transaction_reference || 'N/A'})\`,
            feeStatus,
            payment.school_id
        ]);

        const feeId = feeResult.insertId;

        // Update parent_payments
        await connection.execute(\`
            UPDATE parent_payments 
            SET status = 'approved', approved_by = ?, approved_at = NOW(), fee_id = ?
            WHERE id = ?
        \`, [req.session.userId || null, feeId, paymentId]);`;

const targetNew = `        // 1. Calculate student's total bill from class_bills first, then fees
        let billAmount = 0;
        if (payment.classId) {
            const [classBills] = await connection.execute(\`
                SELECT SUM(amount) as total_amount 
                FROM class_bills
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
            \`, [payment.classId, payment.academic_year, payment.term]);

            if (classBills.length > 0 && classBills[0].total_amount) {
                billAmount = parseFloat(classBills[0].total_amount) || 0;
            }
        }

        // 2. Check previous fee records for this student, term, and academic year
        const [prevFees] = await connection.execute(\`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as feeBillAmount
            FROM fees
            WHERE studentId = ? AND academicYear = ? AND term = ?
        \`, [payment.student_id, payment.academic_year, payment.term]);

        const totalPaidSoFar = parseFloat(prevFees[0]?.totalPaid) || 0;
        if (!billAmount && prevFees[0]?.feeBillAmount) {
            billAmount = parseFloat(prevFees[0].feeBillAmount) || 0;
        }

        // 3. Calculate balance & status
        const effectiveBill = billAmount > 0 ? billAmount : amountValue;
        const totalPaidAfter = totalPaidSoFar + amountValue;
        let feeStatus = 'paid';
        let balance = 0;

        if (totalPaidAfter < effectiveBill) {
            feeStatus = 'partial';
            balance = effectiveBill - totalPaidAfter;
        } else if (totalPaidAfter > effectiveBill) {
            feeStatus = 'overpaid';
            balance = -(totalPaidAfter - effectiveBill);
        } else {
            feeStatus = 'paid';
            balance = 0;
        }

        const receiptNumber = 'REC-' + Date.now().toString().slice(-6) + '-' + Math.floor(100 + Math.random() * 900);
        const formattedDate = moment(payment.payment_date).format('YYYY-MM-DD');

        // 4. Reconcile with existing fees table row or insert new row
        const [existingPendingFees] = await connection.execute(\`
            SELECT id, billAmount FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ?
            ORDER BY id ASC LIMIT 1
        \`, [payment.student_id, payment.academic_year, payment.term]);

        let feeId;
        const paymentNotes = payment.notes 
            ? \`Approved Portal Payment (Ref: \${payment.transaction_reference || 'N/A'}). Note: \${payment.notes}\`
            : \`Approved Portal Payment (Ref: \${payment.transaction_reference || 'N/A'})\`;

        if (existingPendingFees.length > 0) {
            feeId = existingPendingFees[0].id;
            await connection.execute(\`
                UPDATE fees SET
                    billAmount = ?,
                    amountPaid = ?,
                    balance = ?,
                    paymentDate = ?,
                    receiptNumber = ?,
                    status = ?,
                    paymentType = ?,
                    notes = ?
                WHERE id = ?
            \`, [
                effectiveBill,
                totalPaidAfter,
                balance,
                formattedDate,
                receiptNumber,
                feeStatus,
                payment.payment_method || 'Bank Transfer',
                paymentNotes,
                feeId
            ]);
        } else {
            const [feeResult] = await connection.execute(\`
                INSERT INTO fees (
                    studentId, admission_number, studentName, email,
                    className, department, feeType, paymentType,
                    amount, billAmount, amountPaid, balance,
                    paymentDate, receiptNumber, academicYear, term,
                    notes, status, school_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \`, [
                payment.student_id,
                payment.admission_number || '',
                studentName,
                payment.studentEmail || null,
                payment.className || '',
                payment.department || null,
                payment.fee_type || 'School Fees',
                payment.payment_method || 'Bank Transfer',
                effectiveBill,
                effectiveBill,
                amountValue,
                balance,
                formattedDate,
                receiptNumber,
                payment.academic_year,
                payment.term,
                paymentNotes,
                feeStatus,
                payment.school_id
            ]);
            feeId = feeResult.insertId;
        }

        // 5. Update parent_payments to approved and link fee_id
        await connection.execute(\`
            UPDATE parent_payments 
            SET status = 'approved', approved_by = ?, approved_at = NOW(), fee_id = ?
            WHERE id = ?
        \`, [req.session.userId || null, feeId, paymentId]);`;

if (content.includes('// Check if there is an existing bill or fee for this student, term, and academic year')) {
    content = content.replace(targetOld, targetNew);
    console.log('approve handler reconciled with class_bills and fees successfully!');
} else {
    console.log('Target string not found in adminRoutes.js');
}

// Also pass pendingApprovalCount to /fees-collection
if (!content.includes('pendingApprovalCount: pendingApprovalCount')) {
    const feesColTarget = `        res.render('fees-collection', { 
            fees: formattedFees,`;

    const feesColRepl = `        let pendingApprovalCount = 0;
        try {
            const [pRes] = await connection.execute(
                "SELECT COUNT(*) as count FROM parent_payments WHERE status = 'pending' AND (school_id = ? OR ? IS NULL OR school_id IS NULL)",
                [schoolId, schoolId]
            );
            pendingApprovalCount = pRes[0]?.count || 0;
        } catch (_) {}

        res.render('fees-collection', { 
            fees: formattedFees,
            pendingApprovalCount: pendingApprovalCount,`;

    content = content.replace(feesColTarget, feesColRepl);
    console.log('pendingApprovalCount added to fees-collection route');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('adminRoutes.js updated successfully!');
