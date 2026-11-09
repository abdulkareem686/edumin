const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../routes/parentRoutes.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Ensure uploadPaymentProof import
if (!content.includes('uploadPaymentProof')) {
    content = content.replace(
        "const { uploadNoFile, uploadWithFile } = require('../middleware/upload');",
        "const { uploadNoFile, uploadWithFile, uploadPaymentProof } = require('../middleware/upload');"
    );
}

// 2. Enhance router.get('/parent/fees', ...)
const oldFeesStart = `router.get('/parent/fees', authenticate, requireRole('parent'), async (req, res) => {`;
if (!content.includes('schoolAccount: schoolAccount')) {
    // Let's replace the whole router.get('/parent/fees'...) handler
    const feesRegex = /router\.get\('\/parent\/fees', authenticate, requireRole\('parent'\), async \(req, res\) => \{[\s\S]*?\n\/\/ GET route - View fee receipt/m;

    const newFeesHandler = `router.get('/parent/fees', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Get query parameters
        const studentId = req.query.studentId || null;
        const status = req.query.status || null;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];
        try {
            const [notificationCount] = await connection.execute(\`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            \`, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            const [totalNotifications] = await connection.execute(\`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            \`, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;

            const [notificationList] = await connection.execute(\`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            \`, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(\`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        \`, [parentId]);

        const parentName = req.session.parentName || 'Parent';

        // Auto-select first child if not specified
        let activeStudentId = studentId;
        if (!activeStudentId && linkedStudents.length > 0) {
            activeStudentId = linkedStudents[0].id;
        }

        // School bank account details
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

        // Get available academic years for filter
        const [academicYears] = await connection.execute(\`
            SELECT DISTINCT academicYear as year_name
            FROM fees 
            WHERE academicYear IS NOT NULL
            ORDER BY academicYear DESC
        \`);

        let selectedStudent = null;
        let fees = [];
        let feeSummary = {
            total_due: 0,
            total_paid: 0,
            total_balance: 0,
            paid_percentage: 0,
            outstanding_count: 0,
            paid_count: 0,
            partial_count: 0
        };
        let paymentHistory = [];
        let submittedPayments = [];
        let termPaymentCount = 0;

        if (activeStudentId) {
            selectedStudent = linkedStudents.find(function (s) { return s.id == activeStudentId; });

            if (selectedStudent) {
                let statusFilter = '';
                let queryParams = [activeStudentId];
                if (status && status !== 'all') {
                    statusFilter = ' AND status = ?';
                    queryParams.push(status);
                }

                const [feeRecords] = await connection.execute(\`
                    SELECT 
                        f.*,
                        DATE_FORMAT(f.paymentDate, '%W, %M %d, %Y') as formatted_date,
                        CASE 
                            WHEN f.status = 'paid' THEN 'Paid'
                            WHEN f.status = 'partial' THEN 'Partial'
                            WHEN f.status = 'pending' THEN 'Pending'
                            WHEN f.status = 'overpaid' THEN 'Overpaid'
                            ELSE 'Unknown'
                        END as status_display,
                        CASE 
                            WHEN f.status = 'paid' THEN 'success'
                            WHEN f.status = 'partial' THEN 'warning'
                            WHEN f.status = 'pending' THEN 'danger'
                            WHEN f.status = 'overpaid' THEN 'info'
                            ELSE 'secondary'
                        END as status_class
                    FROM fees f
                    WHERE f.studentId = ? \${statusFilter}
                    ORDER BY f.created_at DESC
                \`, queryParams);

                fees = feeRecords;

                let totalDue = 0;
                let totalPaid = 0;
                let outstandingCount = 0;
                let paidCount = 0;
                let partialCount = 0;

                for (var i = 0; i < fees.length; i++) {
                    var fee = fees[i];
                    var amount = parseFloat(fee.amount) || 0;
                    var amountPaid = parseFloat(fee.amountPaid) || 0;

                    totalDue += amount;
                    totalPaid += amountPaid;

                    if (fee.status === 'pending') outstandingCount++;
                    else if (fee.status === 'paid') paidCount++;
                    else if (fee.status === 'partial') partialCount++;
                }

                var balance = totalDue - totalPaid;
                var paidPercentage = totalDue > 0 ? (totalPaid / totalDue * 100).toFixed(1) : 0;

                feeSummary = {
                    total_due: totalDue,
                    total_paid: totalPaid,
                    total_balance: balance,
                    paid_percentage: paidPercentage,
                    outstanding_count: outstandingCount,
                    paid_count: paidCount,
                    partial_count: partialCount
                };

                const [history] = await connection.execute(\`
                    SELECT 
                        DATE(paymentDate) as payment_date,
                        DATE_FORMAT(paymentDate, '%W, %M %d, %Y') as formatted_date,
                        COUNT(*) as transaction_count,
                        SUM(amountPaid) as total_amount,
                        GROUP_CONCAT(DISTINCT feeType) as fee_types
                    FROM fees 
                    WHERE studentId = ? AND amountPaid > 0
                    GROUP BY DATE(paymentDate)
                    ORDER BY payment_date DESC
                    LIMIT 10
                \`, [activeStudentId]);

                paymentHistory = history;

                // Fetch submitted payments by parent
                const [subs] = await connection.execute(\`
                    SELECT pp.*, f.receiptNumber as fee_receipt_number
                    FROM parent_payments pp
                    LEFT JOIN fees f ON pp.fee_id = f.id
                    WHERE pp.student_id = ? AND pp.parent_id = ?
                    ORDER BY pp.created_at DESC
                \`, [activeStudentId, parentId]);
                submittedPayments = subs;

                // Count payments in current term (max 2 rule)
                const [countRow] = await connection.execute(\`
                    SELECT COUNT(*) as count 
                    FROM parent_payments 
                    WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
                \`, [activeStudentId, currentTermInfo.academicYear, currentTermInfo.currentTerm]);
                termPaymentCount = countRow[0]?.count || 0;
            }
        }

        res.render('parent-fees', {
            linkedStudents: linkedStudents,
            student: selectedStudent,
            fees: fees,
            feeSummary: feeSummary,
            paymentHistory: paymentHistory,
            submittedPayments: submittedPayments,
            termPaymentCount: termPaymentCount,
            canPay: termPaymentCount < 2,
            remainingPayments: Math.max(0, 2 - termPaymentCount),
            schoolAccount: schoolAccount,
            school: school,
            currentTermInfo: currentTermInfo,
            academicYears: academicYears,
            selectedStatus: status || 'all',
            parentName: parentName,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            paymentSubmitted: req.query.payment_submitted === '1',
            error: null
        });

    } catch (error) {
        console.error('Error loading parent fees:', error);
        res.render('parent-fees', {
            linkedStudents: [],
            student: null,
            fees: [],
            feeSummary: {
                total_due: 0,
                total_paid: 0,
                total_balance: 0,
                paid_percentage: 0,
                outstanding_count: 0,
                paid_count: 0,
                partial_count: 0
            },
            paymentHistory: [],
            submittedPayments: [],
            termPaymentCount: 0,
            canPay: true,
            remainingPayments: 2,
            schoolAccount: { bank_name: '', account_name: '', account_number: '', instructions: '' },
            school: { name: 'School' },
            currentTermInfo: { academicYear: '2026/2027', currentTerm: 'First Term' },
            academicYears: [],
            selectedStatus: 'all',
            parentName: req.session.parentName || 'Parent',
            username: req.session.parentName || req.session.username || 'Parent',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            paymentSubmitted: false,
            error: 'Failed to load fees: ' + error.message
        });
    }
});

// GET route - View fee receipt`;

    content = content.replace(feesRegex, newFeesHandler);
    console.log('parent/fees route updated');
}

// 3. Add /parent/make-payment and related routes
if (!content.includes("router.get('/parent/make-payment'")) {
    const receiptHandlerEnd = `res.render('parent-fee-receipt', {
            receipt: receipt,
            school: school,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading fee receipt:', error);
        req.session.error = 'Failed to load receipt';
        res.redirect('/parent/fees');
    }
});`;

    const paymentRoutes = `
// ==================== PARENT MAKE FEE PAYMENT ROUTES ====================

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
            bank_name: school.bank_name || 'School Bank',
            account_name: school.account_name || school.name || 'School Account',
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
        if (selectedStudentId) {
            const [pCount] = await connection.execute(\`
                SELECT COUNT(*) as count 
                FROM parent_payments 
                WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
            \`, [selectedStudentId, activeYear, activeTerm]);
            termPaymentCount = pCount[0]?.count || 0;
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
            // Remove uploaded file if any
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

// GET: AJAX Payment Counter Check
router.get('/api/parent/payment-count', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const { studentId, academicYear, term } = req.query;

        if (!studentId || !academicYear || !term) {
            return res.json({ count: 0, remaining: 2, canPay: true });
        }

        const [pCount] = await connection.execute(\`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        \`, [studentId, academicYear, term]);

        const count = pCount[0]?.count || 0;
        const remaining = Math.max(0, 2 - count);
        const canPay = count < 2;

        res.json({ count, remaining, canPay });
    } catch (error) {
        console.error('Error checking payment count:', error);
        res.status(500).json({ error: error.message });
    }
});
`;

    if (content.includes('res.render(\'parent-fee-receipt\'')) {
        content = content.replace(receiptHandlerEnd, receiptHandlerEnd + paymentRoutes);
        console.log('parent/make-payment routes added after receipt handler');
    }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('parentRoutes.js successfully patched');
