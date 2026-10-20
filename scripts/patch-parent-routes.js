const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../routes/parentRoutes.js');
let content = fs.readFileSync(filePath, 'utf8');

// =========================================================================
// 1. PATCH /parent/parent-dashboard
// =========================================================================
const oldDashboardRegex = /\/\/ Get fee summary[\s\S]*?res\.render\('parent-dashboard', \{[\s\S]*?success: req\.session\.success \|\| null,[\s\S]*?error: req\.session\.error \|\| null[\s\S]*?\}\);/;

const newDashboardCode = `// Get fee summary for selected student (if any)
                const [fees] = await connection.execute(\`
                    SELECT 
                        SUM(CASE WHEN status IN ('paid', 'partial') THEN amountPaid ELSE 0 END) as total_paid,
                        SUM(billAmount) as total_due,
                        COUNT(*) as fee_count
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                \`, [selectedId, academicYear, term]);

                feeSummary = fees[0] || { total_paid: 0, total_due: 0, fee_count: 0 };
            }
        }

        // =========================================================================
        // DASHBOARD TOTALS ACROSS ALL LINKED CHILDREN (Declined Payments Strictly Excluded)
        // =========================================================================
        let totalPaid = 0;
        let totalDue = 0;
        let totalPresent = 0;
        let totalAbsent = 0;
        let totalLate = 0;
        let totalAttendanceDays = 0;
        let totalScoreSum = 0;
        let totalScoreCount = 0;

        for (const child of linkedStudents) {
            // 1. Fixed Class Bill for child
            let childBill = 0;
            if (child.classId) {
                const [cbRows] = await connection.execute(\`
                    SELECT SUM(amount) as total 
                    FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                \`, [child.classId, academicYear, term]);
                childBill = parseFloat(cbRows[0]?.total) || 0;
            }
            if (childBill === 0) {
                const [fRows] = await connection.execute(\`
                    SELECT MAX(billAmount) as bill 
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                \`, [child.id, academicYear, term]);
                childBill = parseFloat(fRows[0]?.bill) || 0;
            }
            totalDue += childBill;

            // 2. Approved Paid Amount ONLY (DECLINED payments strictly excluded)
            const [paidRows] = await connection.execute(\`
                SELECT SUM(amountPaid) as total 
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            \`, [child.id, academicYear, term]);
            totalPaid += parseFloat(paidRows[0]?.total) || 0;

            // 3. Child Attendance
            const [attRows] = await connection.execute(\`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? AND academic_year = ? AND term = ?
            \`, [child.id, academicYear, term]);
            totalPresent += parseInt(attRows[0]?.present_days) || 0;
            totalAbsent += parseInt(attRows[0]?.absent_days) || 0;
            totalLate += parseInt(attRows[0]?.late_days) || 0;
            totalAttendanceDays += parseInt(attRows[0]?.total_days) || 0;

            // 4. Academic Scores
            const [scoreRows] = await connection.execute(\`
                SELECT (test_score + exam_score) as total_score
                FROM student_scores
                WHERE student_id = ? AND academic_year = ? AND term = ?
            \`, [child.id, academicYear, term]);
            for (const sRow of scoreRows) {
                totalScoreSum += parseFloat(sRow.total_score) || 0;
                totalScoreCount++;
            }
        }

        const pendingFees = Math.max(0, totalDue - totalPaid);
        const attendanceRate = totalAttendanceDays > 0 ? Math.round((totalPresent / totalAttendanceDays) * 100) : 100;
        const householdAverage = totalScoreCount > 0 ? (totalScoreSum / totalScoreCount) : (overallAverage || 0);

        // Fetch recent activities (only APPROVED payments and notifications; DECLINED payments never added)
        let activities = [];
        try {
            const [recentApproved] = await connection.execute(\`
                SELECT pp.*, s.firstName, s.lastName 
                FROM parent_payments pp
                JOIN students s ON pp.student_id = s.id
                WHERE pp.parent_id = ? AND pp.status = 'approved'
                ORDER BY pp.updated_at DESC 
                LIMIT 4
            \`, [parentId]);

            for (const pmt of recentApproved) {
                activities.push({
                    icon: 'cash-check',
                    description: \`Fee payment of ₦\${parseFloat(pmt.amount).toLocaleString()} for \${pmt.firstName} approved\`,
                    time: moment(pmt.updated_at || pmt.created_at).fromNow()
                });
            }
        } catch (_) {}

        // Get parent notifications
        const [notifications] = await connection.execute(\`
            SELECT * FROM parent_notifications 
            WHERE parent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 20
        \`, [parentId]);

        res.render('parent-dashboard', {
            students: linkedStudents,
            selectedStudent: selectedStudent,
            selectedStudentId: selectedId,
            childResults: childResults,
            overallAverage: householdAverage,
            attendanceSummary: attendanceSummary,
            feeSummary: feeSummary,
            pendingFees: pendingFees,
            totalPaid: totalPaid,
            totalDue: totalDue,
            todayAttendance: totalPresent,
            totalPresent: totalPresent,
            totalAbsent: totalAbsent,
            totalLate: totalLate,
            attendanceRate: attendanceRate,
            activities: activities,
            notifications: notifications,
            currentTerm: term,
            currentAcademicYear: academicYear,
            parentName: parentName,
            unreadCount: unreadCount,
            totalCount: totalCount,
            username: username,
            schoolWeek: schoolWeek,
            currentWeek: schoolWeek.currentWeek,
            totalWeeks: schoolWeek.totalWeeks,
            weekLabel: schoolWeek.weekLabel,
            shortWeekLabel: schoolWeek.shortWeekLabel,
            termWeekStatusBadge: schoolWeek.statusBadge,
            termWeekStatus: schoolWeek.status,
            weekStartDate: schoolWeek.weekStartDate,
            weekEndDate: schoolWeek.weekEndDate,
            termStartDate: schoolWeek.termStartDate,
            termEndDate: schoolWeek.termEndDate,
            termProgress: schoolWeek.termProgress,
            daysRemaining: schoolWeek.daysRemaining,
            daysPassed: schoolWeek.daysPassed,
            totalDays: schoolWeek.totalDays,
            welcomeMessage: null,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null
        });`;

if (oldDashboardRegex.test(content)) {
    content = content.replace(oldDashboardRegex, newDashboardCode);
    console.log('✓ Successfully patched /parent/parent-dashboard route!');
} else {
    console.warn('⚠️ Warning: oldDashboardRegex did not match.');
}

// =========================================================================
// 2. PATCH /parent/children (Ensure fees come from class_bills & term count)
// =========================================================================
const oldChildrenQueryRegex = /router\.get\('\/parent\/children'[\s\S]*?res\.render\('parent-children'[\s\S]*?\}\);/;

const newChildrenCode = `router.get('/parent/children', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Get current academic year and term
        const [currentAcademicYearRows] = await connection.execute(\`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        \`);
        const [currentTermRows] = await connection.execute(\`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        \`);
        const currentAcademicYear = currentAcademicYearRows.length > 0 ? currentAcademicYearRows[0].year_name : '2026/2027';
        const currentTerm = currentTermRows.length > 0 ? currentTermRows[0].term_name : 'First Term';

        // Get all linked students with detailed information
        const [children] = await connection.execute(\`
            SELECT 
                s.*,
                c.className,
                c.level,
                c.department as classDepartment,
                c.professorName as classTeacher,
                COALESCE((
                    SELECT AVG(test_score + exam_score) 
                    FROM student_scores 
                    WHERE student_id = s.id AND term = ? AND academic_year = ?
                ), 0) as current_average,
                COALESCE((
                    SELECT COUNT(*) FROM attendance_records 
                    WHERE student_id = s.id 
                    AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                    AND (morning_status = 'present' OR afternoon_status = 'present')
                ), 0) as attendance_present,
                COALESCE((
                    SELECT COUNT(*) FROM attendance_records 
                    WHERE student_id = s.id 
                    AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                ), 1) as attendance_total
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY c.className, s.firstName, s.lastName
        \`, [currentTerm, currentAcademicYear, parentId]);

        // Unread notifications count
        let unreadCount = 0;
        let totalCount = 0;
        try {
            const [notifications] = await connection.execute(\`
                SELECT COUNT(*) as count FROM parent_notifications WHERE parent_id = ? AND is_read = 0
            \`, [parentId]);
            unreadCount = notifications[0]?.count || 0;

            const [totalNotifications] = await connection.execute(\`
                SELECT COUNT(*) as total FROM parent_notifications WHERE parent_id = ?
            \`, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;
        } catch (err) {
            console.error('Error fetching notification count:', err);
        }

        // Process children data with class bills & payments (strictly excluding declined payments)
        const processedChildren = [];
        for (const child of children) {
            // 1. Fixed class bill from class_bills
            let billAmount = 0;
            if (child.classId) {
                const [cbRows] = await connection.execute(\`
                    SELECT SUM(amount) as total 
                    FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                \`, [child.classId, currentAcademicYear, currentTerm]);
                billAmount = parseFloat(cbRows[0]?.total) || 0;
            }
            if (billAmount === 0) {
                const [feeRows] = await connection.execute(\`
                    SELECT MAX(billAmount) as bill 
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                \`, [child.id, currentAcademicYear, currentTerm]);
                billAmount = parseFloat(feeRows[0]?.bill) || 0;
            }

            // 2. Approved payments ONLY (Declined/rejected payments strictly excluded)
            const [paidRows] = await connection.execute(\`
                SELECT SUM(amountPaid) as total 
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            \`, [child.id, currentAcademicYear, currentTerm]);
            const feesPaid = parseFloat(paidRows[0]?.total) || 0;

            // 3. Term payment submissions count (pending or approved; max 2 limit)
            const [pmtCountRow] = await connection.execute(\`
                SELECT COUNT(*) as count 
                FROM parent_payments 
                WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
            \`, [child.id, currentAcademicYear, currentTerm]);
            const termPaymentCount = pmtCountRow[0]?.count || 0;

            const feesBalance = Math.max(0, billAmount - feesPaid);
            const feePercentage = billAmount > 0 ? Math.min(100, (feesPaid / billAmount) * 100) : (feesPaid > 0 ? 100 : 0);

            // Fee Status
            let feeStatus = 'Unpaid';
            let feeStatusClass = 'danger';
            if (billAmount > 0 && feesPaid >= billAmount) {
                feeStatus = 'Fully Paid';
                feeStatusClass = 'success';
            } else if (feesPaid > 0 && feesPaid < billAmount) {
                feeStatus = 'Half Paid (1/2)';
                feeStatusClass = 'warning';
            }

            // Attendance Percentage
            const attendancePercentage = child.attendance_total > 0
                ? Math.round((child.attendance_present / child.attendance_total) * 100)
                : 0;

            // Performance Grade
            const avgScore = parseFloat(child.current_average) || 0;
            let grade = 'F';
            let gradeClass = 'danger';
            if (avgScore >= 80) { grade = 'A'; gradeClass = 'success'; }
            else if (avgScore >= 70) { grade = 'B'; gradeClass = 'info'; }
            else if (avgScore >= 60) { grade = 'C'; gradeClass = 'primary'; }
            else if (avgScore >= 50) { grade = 'D'; gradeClass = 'warning'; }
            else if (avgScore >= 40) { grade = 'E'; gradeClass = 'secondary'; }

            // Total subjects
            const [subjectCount] = await connection.execute(\`
                SELECT COUNT(*) as count 
                FROM student_scores 
                WHERE student_id = ? AND academic_year = ? AND term = ?
            \`, [child.id, currentAcademicYear, currentTerm]);

            processedChildren.push({
                ...child,
                fullName: studentDisplayName(child),
                attendancePercentage,
                fees_total: billAmount,
                fees_paid: feesPaid,
                fees_balance: feesBalance,
                feePercentage: feePercentage.toFixed(1),
                feeStatus,
                feeStatusClass,
                termPaymentCount,
                currentAverage: avgScore.toFixed(1),
                grade,
                gradeClass,
                totalSubjects: subjectCount[0]?.count || 0
            });
        }

        const stats = {
            totalChildren: processedChildren.length,
            totalPresent: processedChildren.reduce((sum, c) => sum + (c.attendance_present || 0), 0),
            totalFeesPaid: processedChildren.reduce((sum, c) => sum + (c.fees_paid || 0), 0),
            totalFeesDue: processedChildren.reduce((sum, c) => sum + (c.fees_total || 0), 0),
            averageAttendance: processedChildren.length > 0
                ? Math.round(processedChildren.reduce((sum, c) => sum + c.attendancePercentage, 0) / processedChildren.length)
                : 0,
            averageScore: processedChildren.length > 0
                ? (processedChildren.reduce((sum, c) => sum + parseFloat(c.current_average || 0), 0) / processedChildren.length).toFixed(1)
                : 0
        };

        // Recent notifications
        const [notifications] = await connection.execute(\`
            SELECT * FROM parent_notifications 
            WHERE parent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        \`, [parentId]);

        res.render('parent-children', {
            children: processedChildren,
            stats: stats,
            currentAcademicYear: currentAcademicYear,
            currentTerm: currentTerm,
            parentName: req.session.parentName || 'Parent',
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            selectNotice: req.query.select ? true : false,
            selectType: req.query.select || null
        });
    } catch (error) {
        console.error('Error fetching children:', error);
        res.status(500).render('error', { message: 'Failed to fetch children data', error });
    }
});`;

if (oldChildrenQueryRegex.test(content)) {
    content = content.replace(oldChildrenQueryRegex, newChildrenCode);
    console.log('✓ Successfully patched /parent/children route!');
} else {
    console.warn('⚠️ Warning: oldChildrenQueryRegex did not match.');
}

// =========================================================================
// 3. PATCH /parent/fees, /parent/grades, /parent/attendance, /parent/reports (Redirect if no child specified)
// =========================================================================
// For /parent/fees
content = content.replace(
    `        // Auto-select first child if not specified\n        let activeStudentId = studentId;\n        if (!activeStudentId && linkedStudents.length > 0) {\n            activeStudentId = linkedStudents[0].id;\n        }`,
    `        // If no child specified: if 1 child, auto-select; if multiple, redirect to All Children\n        let activeStudentId = studentId;\n        if (!activeStudentId) {\n            if (linkedStudents.length === 1) {\n                activeStudentId = linkedStudents[0].id;\n            } else if (linkedStudents.length > 1) {\n                return res.redirect('/parent/children?select=fees');\n            }\n        }`
);

// For /parent/grades
content = content.replace(
    `        if (studentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });`,
    `        let activeStudentId = studentId;\n        if (!activeStudentId) {\n            if (linkedStudents.length === 1) {\n                activeStudentId = linkedStudents[0].id;\n            } else if (linkedStudents.length > 1) {\n                return res.redirect('/parent/children?select=grades');\n            }\n        }\n\n        if (activeStudentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == activeStudentId; });`
);

// For /parent/attendance
content = content.replace(
    `        if (studentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });`,
    `        let activeStudentId = studentId;\n        if (!activeStudentId) {\n            if (linkedStudents.length === 1) {\n                activeStudentId = linkedStudents[0].id;\n            } else if (linkedStudents.length > 1) {\n                return res.redirect('/parent/children?select=attendance');\n            }\n        }\n\n        if (activeStudentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == activeStudentId; });`
);

// For /parent/reports
content = content.replace(
    `        if (studentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });`,
    `        let activeStudentId = studentId;\n        if (!activeStudentId) {\n            if (linkedStudents.length === 1) {\n                activeStudentId = linkedStudents[0].id;\n            } else if (linkedStudents.length > 1) {\n                return res.redirect('/parent/children?select=reports');\n            }\n        }\n\n        if (activeStudentId) {\n            // Find the selected student from linked students\n            selectedStudent = linkedStudents.find(function (s) { return s.id == activeStudentId; });`
);

// =========================================================================
// 4. PATCH /parent/make-payment & /api/parent/payment-count
// =========================================================================
const oldPaymentRoutesStart = content.indexOf('// ==================== PARENT MAKE FEE PAYMENT & CLASS BILLS ROUTES ====================');
if (oldPaymentRoutesStart !== -1) {
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

        // If no student specified in query:
        // If 1 child, auto-select. If multiple children, redirect to All Children so parent selects under student!
        let selectedStudentId = req.query.studentId || null;
        if (!selectedStudentId) {
            if (linkedStudents.length === 1) {
                selectedStudentId = linkedStudents[0].id;
            } else if (linkedStudents.length > 1) {
                return res.redirect('/parent/children?select=payment');
            } else {
                return res.redirect('/parent/children');
            }
        }

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
            // Count of pending or approved payments for this student/term (Declined/rejected payments excluded)
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

            // Load previous approved payments from fees table
            const [feeStats] = await connection.execute(\`
                SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            \`, [selectedStudentId, activeYear, activeTerm]);
            totalPaidSoFar = parseFloat(feeStats[0]?.totalPaid) || 0;

            if (totalClassBill === 0 && feeStats[0]?.billAmount) {
                totalClassBill = parseFloat(feeStats[0].billAmount) || 0;
            }

            outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);
        }

        // Installment amounts: Full once, or Half twice (50% each)
        const fullAmount = totalClassBill;
        const halfAmount = Math.round((totalClassBill / 2) * 100) / 100;
        const secondHalfAmount = outstandingBalance;

        // Fetch parent payment history for this student
        const [myPayments] = await connection.execute(\`
            SELECT pp.*, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE pp.parent_id = ? AND pp.student_id = ?
            ORDER BY pp.created_at DESC
        \`, [parentId, selectedStudentId]);

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
            canPay: termPaymentCount < 2 && outstandingBalance > 0,
            remainingPayments: Math.max(0, 2 - termPaymentCount),
            classBills,
            totalClassBill,
            totalPaidSoFar,
            outstandingBalance,
            fullAmount,
            halfAmount,
            secondHalfAmount,
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

// POST: Submit Fee Payment (Enforcing Fixed Class Bill: Full Once or Half Twice)
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
            installmentOption,
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
            'SELECT s.id, s.classId, s.firstName, s.lastName FROM parent_students ps JOIN students s ON ps.student_id = s.id WHERE ps.parent_id = ? AND ps.student_id = ?',
            [parentId, studentId]
        );
        if (linkCheck.length === 0) {
            return res.redirect('/parent/make-payment?error=' + encodeURIComponent('You are not authorized to make payments for this student.'));
        }
        const studentInfo = linkCheck[0];

        // 1. Fetch Fixed Total Bill for Student's Class
        let totalClassBill = 0;
        if (studentInfo.classId) {
            const [bills] = await connection.execute(\`
                SELECT SUM(amount) as total 
                FROM class_bills 
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
            \`, [studentInfo.classId, academicYear.trim(), term.trim()]);
            totalClassBill = parseFloat(bills[0]?.total) || 0;
        }

        if (totalClassBill === 0) {
            const [feeStats] = await connection.execute(\`
                SELECT MAX(billAmount) as billAmount
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ?
            \`, [studentId, academicYear.trim(), term.trim()]);
            totalClassBill = parseFloat(feeStats[0]?.billAmount) || 0;
        }

        if (totalClassBill <= 0) {
            return res.redirect(\`/parent/make-payment?studentId=\${studentId}&error=\` + encodeURIComponent('The official class bill for this term has not been published by the school yet. Payments cannot be accepted until published.'));
        }

        // 2. Fetch approved paid so far
        const [paidRows] = await connection.execute(\`
            SELECT SUM(amountPaid) as totalPaid
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
        \`, [studentId, academicYear.trim(), term.trim()]);
        const totalPaidSoFar = parseFloat(paidRows[0]?.totalPaid) || 0;
        const outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);

        if (outstandingBalance <= 0) {
            return res.redirect(\`/parent/make-payment?studentId=\${studentId}&error=\` + encodeURIComponent(\`The class bill of ₦\${totalClassBill.toLocaleString()} for \${term} (\${academicYear}) has already been fully paid.\`));
        }

        // 3. Check 2 payments per term limit (CRITICAL RULE: only pending or approved count; declined payments do not count)
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
            return res.redirect(\`/parent/make-payment?studentId=\${studentId}&academicYear=\${encodeURIComponent(academicYear)}&term=\${encodeURIComponent(term)}&error=\` + encodeURIComponent(\`Payment limit reached: You have already submitted the maximum allowed 2 payments for \${term} (\${academicYear}) for this student.\`));
        }

        // 4. Validate Amount Against Fixed Class Bill Installment Rules:
        // Parent can pay twice or once in a term: full once or half twice.
        const halfAmount = Math.round((totalClassBill / 2) * 100) / 100;
        if (currentCount === 0) {
            // First payment of term: can pay either FULL (100%) OR HALF (50%)
            const isFull = Math.abs(parsedAmount - totalClassBill) <= 1.0;
            const isHalf = Math.abs(parsedAmount - halfAmount) <= 1.0;
            if (!isFull && !isHalf) {
                return res.redirect(\`/parent/make-payment?studentId=\${studentId}&academicYear=\${encodeURIComponent(academicYear)}&term=\${encodeURIComponent(term)}&error=\` + encodeURIComponent(\`Invalid payment amount: Under school policy, you may either pay full once (₦\${totalClassBill.toLocaleString()}) or half installment (₦\${halfAmount.toLocaleString()}).\`));
            }
        } else if (currentCount === 1) {
            // Second payment of term: must pay the remaining balance (the second half)
            const isRemainingHalf = Math.abs(parsedAmount - outstandingBalance) <= 1.0;
            if (!isRemainingHalf) {
                return res.redirect(\`/parent/make-payment?studentId=\${studentId}&academicYear=\${encodeURIComponent(academicYear)}&term=\${encodeURIComponent(term)}&error=\` + encodeURIComponent(\`Invalid payment amount: Your second and final installment must be the remaining balance of ₦\${outstandingBalance.toLocaleString()}.\`));
            }
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
        const sName = \`\${studentInfo.firstName} \${studentInfo.lastName}\`;
        const pName = req.session.parentName || req.session.username || 'Parent';

        // Notify admin
        try {
            await connection.execute(\`
                INSERT INTO admin_notifications (
                    admin_id, school_id, title, message, type, reference_id, is_read, created_at
                ) VALUES (NULL, ?, 'New Fee Payment Submitted', ?, 'parent_payment', ?, 0, NOW())
            \`, [
                schoolId,
                \`\${pName} submitted a fee payment of ₦\${parsedAmount.toLocaleString()} (\${currentCount === 0 && parsedAmount === totalClassBill ? 'Full' : 'Half'} payment) for \${sName} (\${term}, \${academicYear}) awaiting review.\`,
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
            return res.json({ count: 0, remaining: 2, canPay: true, totalClassBill: 0, totalPaidSoFar: 0, outstandingBalance: 0, fullAmount: 0, halfAmount: 0, classBills: [] });
        }

        // Count existing payments in this term (declined payments excluded)
        const [pCount] = await connection.execute(\`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        \`, [studentId, academicYear, term]);

        const count = pCount[0]?.count || 0;
        const remaining = Math.max(0, 2 - count);

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

        // Previous paid from fees (only approved)
        const [feeStats] = await connection.execute(\`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
        \`, [studentId, academicYear, term]);
        const totalPaidSoFar = parseFloat(feeStats[0]?.totalPaid) || 0;

        if (totalClassBill === 0 && feeStats[0]?.billAmount) {
            totalClassBill = parseFloat(feeStats[0].billAmount) || 0;
        }

        const outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);
        const fullAmount = totalClassBill;
        const halfAmount = Math.round((totalClassBill / 2) * 100) / 100;
        const secondHalfAmount = outstandingBalance;
        const canPay = count < 2 && outstandingBalance > 0;

        res.json({
            count,
            remaining,
            canPay,
            totalClassBill,
            totalPaidSoFar,
            outstandingBalance,
            fullAmount,
            halfAmount,
            secondHalfAmount,
            classBills
        });
    } catch (error) {
        console.error('Error checking payment count & class bill:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
`;

    content = content.slice(0, oldPaymentRoutesStart) + paymentRoutesCode;
    console.log('✓ Successfully replaced /parent/make-payment and payment count routes!');
} else {
    console.warn('⚠️ Warning: paymentRoutesStart not found');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('🎉 Successfully saved all changes to routes/parentRoutes.js!');
