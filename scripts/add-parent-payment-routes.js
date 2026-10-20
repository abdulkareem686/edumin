const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../routes/parentRoutes.js');
let content = fs.readFileSync(filePath, 'utf8');

// Ensure uploadPaymentProof is imported
if (!content.includes('uploadPaymentProof')) {
    content = content.replace(
        "const { uploadNoFile, uploadWithFile } = require('../middleware/upload');",
        "const { uploadNoFile, uploadWithFile, uploadPaymentProof } = require('../middleware/upload');"
    );
}

// Check if /parent/make-payment is already there
if (content.includes("router.get('/parent/make-payment'")) {
    console.log('Already present, removing old version first to update');
    const startIdx = content.indexOf('// ==================== PARENT MAKE FEE PAYMENT');
    const endIdx = content.indexOf('module.exports = router;');
    if (startIdx !== -1 && endIdx !== -1) {
        content = content.slice(0, startIdx) + content.slice(endIdx);
    }
}

const paymentRoutesCode = `// ==================== PARENT MAKE FEE PAYMENT & CLASS BILLS ROUTES ====================

// GET: Make Fee Payment View
router.get('/parent/make-payment', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Get linked students
        const [linkedStudents] = await connection.execute(\`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        \`, [parentId]);

        // Default or selected student
        let selectedStudentId = req.query.studentId || (linkedStudents.length > 0 ? linkedStudents[0].id : null);
        let selectedStudent = linkedStudents.find(s => s.id == selectedStudentId) || (linkedStudents.length > 0 ? linkedStudents[0] : null);
        if (selectedStudent) selectedStudentId = selectedStudent.id;

        // School account details
        const [schoolInfo] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        const school = schoolInfo.length > 0 ? schoolInfo[0] : { name: 'School' };

        const [accounts] = await connection.execute(
            'SELECT * FROM payment_accounts WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL) AND is_active = 1 LIMIT 1',
            [schoolId, schoolId]
        );
        const schoolAccount = accounts.length > 0 ? accounts[0] : {
            bank_name: school.bank_name || '',
            account_name: school.account_name || school.name || '',
            account_number: school.account_number || '',
            instructions: school.payment_instructions || ''
        };

        const currentTermInfo = await getCurrentTermAndWeek(connection, schoolId);

        // Academic years and terms lists
        const [academicYears] = await connection.execute(\`
            SELECT DISTINCT year_name FROM academic_years 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
            ORDER BY year_name DESC
        \`, [schoolId, schoolId]);

        const [terms] = await connection.execute(\`
            SELECT DISTINCT term_name FROM academic_terms 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
        \`, [schoolId, schoolId]);

        const activeYear = req.query.academicYear || currentTermInfo.academicYear || (academicYears.length > 0 ? academicYears[0].year_name : '2026/2027');
        const activeTerm = req.query.term || currentTermInfo.currentTerm || 'First Term';

        // Check payment count for this student in the term (Max 2 rule)
        let termPaymentCount = 0;
        let classBills = [];
        let totalClassBill = 0;
        let totalPaidSoFar = 0;
        let outstandingBalance = 0;

        if (selectedStudentId && selectedStudent) {
            // Check count of pending or approved payments for this student/term
            const [pCount] = await connection.execute(\`
                SELECT COUNT(*) as count 
                FROM parent_payments 
                WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
            \`, [selectedStudentId, activeYear, activeTerm]);
            termPaymentCount = pCount[0]?.count || 0;

            // Load Class Bills breakdown for this student's class
            if (selectedStudent.classId) {
                const [bills] = await connection.execute(\`
                    SELECT * FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                    ORDER BY fee_type
                \`, [selectedStudent.classId, activeYear, activeTerm]);
                classBills = bills;
                totalClassBill = classBills.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
            }

            // Load previous payments from fees table
            const [feeStats] = await connection.execute(\`
                SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ?
            \`, [selectedStudentId, activeYear, activeTerm]);
            totalPaidSoFar = parseFloat(feeStats[0]?.totalPaid) || 0;

            if (totalClassBill === 0 && feeStats[0]?.billAmount) {
                totalClassBill = parseFloat(feeStats[0].billAmount) || 0;
            }

            outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);
        }

        // Fetch parent payment history
        const [myPayments] = await connection.execute(\`
            SELECT pp.*, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE pp.parent_id = ?
            ORDER BY pp.created_at DESC
        \`, [parentId]);

        // Notifications count
        let unreadCount = 0;
        try {
            const [notifCount] = await connection.execute('SELECT COUNT(*) as count FROM parent_notifications WHERE parent_id = ? AND is_read = 0', [parentId]);
            unreadCount = notifCount[0]?.count || 0;
        } catch (_) {}

        res.render('parent-make-payment', {
            linkedStudents,
            student: selectedStudent,
            selectedStudentId,
            school,
            schoolAccount,
            currentTermInfo,
            activeYear,
            activeTerm,
            academicYears,
            terms,
            termPaymentCount,
            canPay: termPaymentCount < 2,
            remainingPayments: Math.max(0, 2 - termPaymentCount),
            classBills,
            totalClassBill,
            totalPaidSoFar,
            outstandingBalance,
            myPayments,
            username,
            parentName: req.session.parentName || username,
            unreadCount,
            success: req.query.success === '1' ? 'Your payment has been successfully submitted and is pending school verification!' : null,
            error: req.query.error ? decodeURIComponent(req.query.error) : null,
            moment
        });

    } catch (error) {
        console.error('Error loading make payment page:', error);
        res.status(500).render('error', { message: 'Failed to load payment portal', error });
    }
});

// POST: Submit Fee Payment
router.post('/parent/make-payment', authenticate, requireRole('parent'), uploadPaymentProof.single('proofDocument'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const {
            studentId,
            academicYear,
            term,
            amount,
            paymentMethod,
            bankName,
            transactionReference,
            paymentDate,
            notes
        } = req.body;

        if (!studentId || !academicYear || !term || !amount || !paymentDate) {
            return res.redirect(\`/parent/make-payment?studentId=\${studentId || ''}&error=\` + encodeURIComponent('Please complete all required fields.'));
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.redirect(\`/parent/make-payment?studentId=\${studentId}&error=\` + encodeURIComponent('Please enter a valid payment amount greater than zero.'));
        }

        // Verify parent is linked to student
        const [linkCheck] = await connection.execute(
            'SELECT * FROM parent_students WHERE parent_id = ? AND student_id = ?',
            [parentId, studentId]
        );
        if (linkCheck.length === 0) {
            return res.redirect('/parent/make-payment?error=' + encodeURIComponent('You are not authorized to make payments for this student.'));
        }

        // Check 2 payments per term limit (CRITICAL RULE)
        const [countRow] = await connection.execute(\`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        \`, [studentId, academicYear.trim(), term.trim()]);

        const currentCount = countRow[0]?.count || 0;
        if (currentCount >= 2) {
            if (req.file && req.file.path) {
                try { require('fs').unlinkSync(req.file.path); } catch (_) {}
            }
            return res.redirect(\`/parent/make-payment?studentId=\${studentId}&academicYear=\${encodeURIComponent(academicYear)}&term=\${encodeURIComponent(term)}&error=\` + encodeURIComponent(\`Payment limit reached: You are only allowed to make at most 2 payments for \${term} (\${academicYear}) for this student.\`));
        }

        const paymentNumber = currentCount + 1;
        const proofDocPath = req.file ? \`/uploads/payments/\${req.file.filename}\` : null;
        const formattedDate = moment(paymentDate).format('YYYY-MM-DD');

        // Insert payment submission with status 'pending'
        const [insertResult] = await connection.execute(\`
            INSERT INTO parent_payments (
                school_id, parent_id, student_id, academic_year, term,
                amount, payment_method, bank_name, transaction_reference,
                payment_date, proof_document, notes, status, payment_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        \`, [
            schoolId,
            parentId,
            studentId,
            academicYear.trim(),
            term.trim(),
            parsedAmount,
            paymentMethod || 'Bank Transfer',
            bankName || null,
            transactionReference ? transactionReference.trim() : null,
            formattedDate,
            proofDocPath,
            notes ? notes.trim() : null,
            paymentNumber
        ]);

        const newPaymentId = insertResult.insertId;

        // Get student info for admin notification
        const [sRows] = await connection.execute('SELECT firstName, lastName FROM students WHERE id = ?', [studentId]);
        const sName = sRows.length > 0 ? \`\${sRows[0].firstName} \${sRows[0].lastName}\` : 'Student';
        const pName = req.session.parentName || req.session.username || 'Parent';

        // Notify admin
        try {
            await connection.execute(\`
                INSERT INTO admin_notifications (
                    admin_id, school_id, title, message, type, reference_id, is_read, created_at
                ) VALUES (NULL, ?, 'New Fee Payment Submitted', ?, 'parent_payment', ?, 0, NOW())
            \`, [
                schoolId,
                \`\${pName} submitted a fee payment of ₦\${parsedAmount.toLocaleString()} for \${sName} (\${term}, \${academicYear}) awaiting review.\`,
                newPaymentId
            ]);
        } catch (notifErr) {
            console.warn('Failed to insert admin notification:', notifErr.message);
        }

        res.redirect(\`/parent/make-payment?studentId=\${studentId}&academicYear=\${encodeURIComponent(academicYear)}&term=\${encodeURIComponent(term)}&success=1\`);
    } catch (error) {
        console.error('Error submitting parent fee payment:', error);
        res.redirect('/parent/make-payment?error=' + encodeURIComponent('Failed to submit payment: ' + error.message));
    }
});

// GET: AJAX Payment Counter & Class Bill Check
router.get('/api/parent/payment-count', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const { studentId, academicYear, term } = req.query;

        if (!studentId || !academicYear || !term) {
            return res.json({ count: 0, remaining: 2, canPay: true, totalClassBill: 0, totalPaidSoFar: 0, outstandingBalance: 0, classBills: [] });
        }

        // Count existing payments in this term
        const [pCount] = await connection.execute(\`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        \`, [studentId, academicYear, term]);

        const count = pCount[0]?.count || 0;
        const remaining = Math.max(0, 2 - count);
        const canPay = count < 2;

        // Fetch student classId
        const [sRows] = await connection.execute('SELECT classId FROM students WHERE id = ?', [studentId]);
        const classId = sRows[0]?.classId;

        let classBills = [];
        let totalClassBill = 0;
        if (classId) {
            const [bills] = await connection.execute(\`
                SELECT fee_type, amount, description FROM class_bills 
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                ORDER BY fee_type
            \`, [classId, academicYear, term]);
            classBills = bills;
            totalClassBill = classBills.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
        }

        // Previous paid from fees
        const [feeStats] = await connection.execute(\`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ?
        \`, [studentId, academicYear, term]);
        const totalPaidSoFar = parseFloat(feeStats[0]?.totalPaid) || 0;

        if (totalClassBill === 0 && feeStats[0]?.billAmount) {
            totalClassBill = parseFloat(feeStats[0].billAmount) || 0;
        }

        const outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);

        res.json({
            count,
            remaining,
            canPay,
            totalClassBill,
            totalPaidSoFar,
            outstandingBalance,
            classBills
        });
    } catch (error) {
        console.error('Error checking payment count & class bill:', error);
        res.status(500).json({ error: error.message });
    }
});

`;

content = content.replace('module.exports = router;', paymentRoutesCode + 'module.exports = router;');
fs.writeFileSync(filePath, content, 'utf8');
console.log('parentRoutes.js successfully updated with class bills and payment routes!');
