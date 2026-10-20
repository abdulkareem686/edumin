const express = require('express');
const router = express.Router();
const moment = require('moment');
const { getConnection, releaseConnection } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadNoFile, uploadWithFile, uploadPaymentProof } = require('../middleware/upload');
const { getGrade, getGradeColor, getGradeClass, getGradeRemark } = require('../utils/grading');
const { studentDisplayName, getCurrentTermAndWeek } = require('../utils/helpers');

router.get('/parent/parent-dashboard', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const selectedStudentId = req.query.studentId || null;
        const welcomeMessage = req.session.welcomeMessage || null;
        delete req.session.welcomeMessage;

        // Get username from session
        const username = req.session.parentName || req.session.username || 'Parent';  // ADD THIS LINE

        // Get parent info
        const [parentInfo] = await connection.execute(`
            SELECT first_name, last_name, email, phone 
            FROM parents 
            WHERE id = ? AND school_id = ?
        `, [parentId, schoolId]);

        const parentName = parentInfo.length > 0 ? `${parentInfo[0].first_name} ${parentInfo[0].last_name}` : req.session.username || 'Parent';

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
        `, [parentId]);

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;
        try {
            const [notifications] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notifications[0]?.count || 0;

            // Get total count for notification badge
            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;
        } catch (err) {
            console.error('Error fetching notification count:', err);
            unreadCount = 0;
            totalCount = 0;
        }

        if (linkedStudents.length === 0) {
            return res.render('parent-dashboard', {
                students: [],
                selectedStudent: null,
                selectedStudentId: null,
                childResults: [],
                attendanceSummary: null,
                feeSummary: null,
                notifications: [],
                currentTerm: 'First Term',
                currentAcademicYear: '2026/2027',
                parentName: parentName,
                overallAverage: 0,
                unreadCount: unreadCount,
                totalCount: totalCount,
                username: username,
                schoolWeek: {
                    currentWeek: 1,
                    totalWeeks: 12,
                    weekLabel: 'Week 1 of 12',
                    shortWeekLabel: 'Week 1',
                    status: 'active',
                    statusBadge: 'In Session',
                    termProgress: 0,
                    daysRemaining: 0,
                    daysPassed: 0,
                    totalDays: 0,
                    weekStartDate: '',
                    weekEndDate: ''
                },
                currentWeek: 1,
                totalWeeks: 12,
                weekLabel: 'Week 1 of 12',
                shortWeekLabel: 'Week 1',
                termWeekStatusBadge: 'In Session',
                termWeekStatus: 'active',
                welcomeMessage: null,
                error: 'No students linked to your account',
                success: null,
                moment: require('moment')
            });
        }

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = 1 LIMIT 1
        `);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = 1 LIMIT 1
        `);

        let schoolWeek = {
            academicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2026/2027',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            termName: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            currentWeek: 1,
            totalWeeks: 12,
            weekLabel: 'Week 1 of 12',
            shortWeekLabel: 'Week 1',
            status: 'active',
            statusBadge: 'In Session',
            termProgress: 0,
            daysRemaining: 0,
            daysPassed: 0,
            totalDays: 0,
            weekStartDate: '',
            weekEndDate: ''
        };

        try {
            const calculatedTermWeek = await getCurrentTermAndWeek(connection, schoolId);
            if (calculatedTermWeek) {
                schoolWeek = { ...schoolWeek, ...calculatedTermWeek };
            }
        } catch (weekErr) {
            console.error('Error calculating school week for parent dashboard:', weekErr.message);
        }

        const academicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : schoolWeek.academicYear;
        const term = currentTerm.length > 0 ? currentTerm[0].term_name : schoolWeek.currentTerm;

        // Determine which student to show
        let selectedId = selectedStudentId;
        if (!selectedId && linkedStudents.length > 0) {
            selectedId = linkedStudents[0].id;
        }

        // Get selected student data
        let selectedStudent = null;
        let childResults = [];
        let overallAverage = 0;
        let attendanceSummary = null;
        let feeSummary = null;

        if (selectedId) {
            const [studentDetails] = await connection.execute(`
                SELECT s.*, c.className, c.level 
                FROM students s
                LEFT JOIN classes c ON s.classId = c.id
                WHERE s.id = ? AND s.school_id = ?
            `, [selectedId, schoolId]);

            selectedStudent = studentDetails.length > 0 ? studentDetails[0] : null;

            if (selectedStudent) {
                // Get student results for current term
                const [results] = await connection.execute(`
                    SELECT sc.*, sub.name as subject_name 
                    FROM student_scores sc
                    JOIN subjects sub ON sc.subject_id = sub.id
                    WHERE sc.student_id = ? AND sc.academic_year = ? AND sc.term = ?
                    ORDER BY sub.name
                `, [selectedId, academicYear, term]);

                childResults = results;

                // Calculate overall average
                if (results.length > 0) {
                    let totalScore = 0;
                    results.forEach(result => {
                        totalScore += (parseFloat(result.test_score) || 0) + (parseFloat(result.exam_score) || 0);
                    });
                    overallAverage = totalScore / results.length;
                }

                // Get attendance summary
                const [attendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                        COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                        COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                        COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                        COUNT(*) as total_days,
                        ROUND((COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / COUNT(*)), 2) as percentage
                    FROM attendance_records 
                    WHERE student_id = ? AND academic_year = ? AND term = ?
                `, [selectedId, academicYear, term]);

                attendanceSummary = attendance[0] || {
                    present_days: 0,
                    absent_days: 0,
                    late_days: 0,
                    excused_days: 0,
                    total_days: 0,
                    percentage: 0
                };

                // Get fee summary for selected student (if any)
                const [fees] = await connection.execute(`
                    SELECT 
                        SUM(CASE WHEN status IN ('paid', 'partial') THEN amountPaid ELSE 0 END) as total_paid,
                        SUM(billAmount) as total_due,
                        COUNT(*) as fee_count
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                `, [selectedId, academicYear, term]);

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
                const [cbRows] = await connection.execute(`
                    SELECT SUM(amount) as total 
                    FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                `, [child.classId, academicYear, term]);
                childBill = parseFloat(cbRows[0]?.total) || 0;
            }
            if (childBill === 0) {
                const [fRows] = await connection.execute(`
                    SELECT MAX(billAmount) as bill 
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                `, [child.id, academicYear, term]);
                childBill = parseFloat(fRows[0]?.bill) || 0;
            }
            totalDue += childBill;

            // 2. Approved Paid Amount ONLY (DECLINED payments strictly excluded)
            const [paidRows] = await connection.execute(`
                SELECT SUM(amountPaid) as total 
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            `, [child.id, academicYear, term]);
            totalPaid += parseFloat(paidRows[0]?.total) || 0;

            // 3. Child Attendance
            const [attRows] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? AND academic_year = ? AND term = ?
            `, [child.id, academicYear, term]);
            totalPresent += parseInt(attRows[0]?.present_days) || 0;
            totalAbsent += parseInt(attRows[0]?.absent_days) || 0;
            totalLate += parseInt(attRows[0]?.late_days) || 0;
            totalAttendanceDays += parseInt(attRows[0]?.total_days) || 0;

            // 4. Academic Scores
            const [scoreRows] = await connection.execute(`
                SELECT (test_score + exam_score) as total_score
                FROM student_scores
                WHERE student_id = ? AND academic_year = ? AND term = ?
            `, [child.id, academicYear, term]);
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
            const [recentApproved] = await connection.execute(`
                SELECT pp.*, s.firstName, s.lastName 
                FROM parent_payments pp
                JOIN students s ON pp.student_id = s.id
                WHERE pp.parent_id = ? AND pp.status = 'approved'
                ORDER BY pp.updated_at DESC 
                LIMIT 4
            `, [parentId]);

            for (const pmt of recentApproved) {
                activities.push({
                    icon: 'cash-check',
                    description: `Fee payment of ₦${parseFloat(pmt.amount).toLocaleString()} for ${pmt.firstName} approved`,
                    time: moment(pmt.updated_at || pmt.created_at).fromNow()
                });
            }
        } catch (_) {}

        // Get parent notifications
        const [notifications] = await connection.execute(`
            SELECT * FROM parent_notifications 
            WHERE parent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 20
        `, [parentId]);

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
        });

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading parent dashboard:', error);
        res.render('parent-dashboard', {
            students: [],
            selectedStudent: null,
            selectedStudentId: null,
            childResults: [],
            attendanceSummary: null,
            feeSummary: null,
            notifications: [],
            currentTerm: '',
            currentAcademicYear: '',
            parentName: 'Parent',
            overallAverage: 0,
            unreadCount: 0,
            totalCount: 0,
            username: req.session.parentName || req.session.username || 'Parent',
            schoolWeek: {
                currentWeek: 1,
                totalWeeks: 12,
                weekLabel: 'Week 1 of 12',
                shortWeekLabel: 'Week 1',
                status: 'active',
                statusBadge: 'In Session',
                termProgress: 0,
                daysRemaining: 0,
                daysPassed: 0,
                totalDays: 0,
                weekStartDate: '',
                weekEndDate: ''
            },
            currentWeek: 1,
            totalWeeks: 12,
            weekLabel: 'Week 1 of 12',
            shortWeekLabel: 'Week 1',
            termWeekStatusBadge: 'In Session',
            termWeekStatus: 'active',
            welcomeMessage: null,
            error: 'Failed to load dashboard data: ' + error.message,
            success: null,
            moment: require('moment')
        });
    }
});

// Parent Reports - View child's detailed results (protected by parent role)
// ==================== PARENT REPORTS ROUTES ====================

// Helper function to get grade based on score

// GET route - Parent Reports (View report cards)
// GET route - Parent Reports (View report cards)
router.get('/parent/reports', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';  // ADD THIS LINE

        // Get query parameters
        const studentId = req.query.studentId || null;
        const term = req.query.term || null;
        const academicYear = req.query.academicYear || null;
        const viewType = req.query.viewType || 'term'; // 'term' or 'session'

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];
        try {
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            // Get total count for notification badge
            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;  // ADD THIS LINE

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

        // Get parent name
        const parentName = req.session.parentName || 'Parent';

        if (linkedStudents.length === 0) {
            // No students linked - show empty state
            const [academicYears] = await connection.execute(`
                SELECT DISTINCT year_name, start_date, end_date
                FROM academic_years 
                ORDER BY start_date DESC
            `);

            const [schoolInfo] = schoolId
                ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
                : await connection.execute('SELECT * FROM school_info LIMIT 1');

            const school = schoolInfo.length > 0 ? schoolInfo[0] : {
                name: "Excel College",
                address: "12 Education Road, Lagos, Nigeria",
                email: "info@excelcollege.edu.ng",
                phone: "+234 812 345 6789",
                website: "www.excelcollege.edu.ng",
                motto: "Excellence in Education"
            };

            return res.render('parent-reports', {
                linkedStudents: [],
                student: null,
                scores: [],
                academicYears: academicYears,
                availableTerms: [],
                selectedYear: '',
                selectedTerm: '',
                viewType: viewType,
                overallAverage: 0,
                overallGrade: 'N/A',
                reportTitle: 'Academic Reports',
                school: school,
                parentName: parentName,
                username: username,  // ADD THIS LINE
                unreadCount: unreadCount,
                totalCount: totalCount,  // ADD THIS LINE
                notifications: notifications,
                moment: require('moment'),
                error: 'No students are linked to your account. Please contact the school administrator.'
            });
        }

        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name, start_date, end_date
            FROM academic_years 
            ORDER BY start_date DESC
        `);

        // Get current academic year if none selected
        let selectedYear = academicYear;
        if (!selectedYear && academicYears.length > 0) {
            selectedYear = academicYears[0].year_name;
        }

        // Get available terms for the selected academic year
        let availableTerms = [];
        if (selectedYear) {
            const [terms] = await connection.execute(`
                SELECT at.term_name, at.start_date, at.end_date, at.is_current
                FROM academic_terms at
                JOIN academic_years ay ON at.academic_year_id = ay.id
                WHERE ay.year_name = ?
                ORDER BY 
                    CASE at.term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                        ELSE 4
                    END
            `, [selectedYear]);
            availableTerms = terms;
        }

        // Get current term if none selected
        let selectedTerm = term;
        if (!selectedTerm && availableTerms.length > 0) {
            const currentTerm = availableTerms.find(function (t) { return t.is_current === 1; });
            if (currentTerm) {
                selectedTerm = currentTerm.term_name;
            } else {
                selectedTerm = availableTerms[0].term_name;
            }
        }

        // Get school information
        const [schoolInfo] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');

        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng",
            motto: "Excellence in Education"
        };

        // If student is selected, get their scores
        let selectedStudent = null;
        let scores = [];
        let overallAverage = 0;
        let overallGrade = 'N/A';
        let reportTitle = 'Academic Reports';

        if (studentId) {
            // Find the selected student from linked students
            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });

            if (selectedStudent) {
                if (viewType === 'session') {
                    // Get session summary (all terms)
                    reportTitle = 'Session Report Card - ' + selectedYear;

                    const [sessionScores] = await connection.execute(`
                        SELECT 
                            s.id as subject_id,
                            s.name as subject_name,
                            s.subject_code,
                            COALESCE((
                                SELECT (test_score + exam_score) 
                                FROM student_scores 
                                WHERE student_id = ? AND subject_id = s.id 
                                AND term = 'First Term' AND academic_year = ?
                            ), 0) as first_term_score,
                            COALESCE((
                                SELECT (test_score + exam_score) 
                                FROM student_scores 
                                WHERE student_id = ? AND subject_id = s.id 
                                AND term = 'Second Term' AND academic_year = ?
                            ), 0) as second_term_score,
                            COALESCE((
                                SELECT (test_score + exam_score) 
                                FROM student_scores 
                                WHERE student_id = ? AND subject_id = s.id 
                                AND term = 'Third Term' AND academic_year = ?
                            ), 0) as third_term_score
                        FROM subjects s
                        WHERE s.id IN (
                            SELECT DISTINCT subject_id 
                            FROM student_scores 
                            WHERE student_id = ? AND academic_year = ?
                        )
                        ORDER BY s.name
                    `, [studentId, selectedYear, studentId, selectedYear, studentId, selectedYear, studentId, selectedYear]);

                    // Process session scores
                    let totalAverage = 0;
                    let subjectCount = 0;

                    scores = sessionScores.map(function (subject) {
                        var firstTerm = parseFloat(subject.first_term_score) || 0;
                        var secondTerm = parseFloat(subject.second_term_score) || 0;
                        var thirdTerm = parseFloat(subject.third_term_score) || 0;

                        var termsWithScores = 0;
                        if (firstTerm > 0) termsWithScores++;
                        if (secondTerm > 0) termsWithScores++;
                        if (thirdTerm > 0) termsWithScores++;

                        var average = 0;
                        if (termsWithScores > 0) {
                            average = (firstTerm + secondTerm + thirdTerm) / termsWithScores;
                            totalAverage += average;
                            subjectCount++;
                        }

                        var grade = getGrade(average);

                        return {
                            subject_name: subject.subject_name,
                            subject_code: subject.subject_code,
                            first_term: firstTerm > 0 ? firstTerm.toFixed(1) : '-',
                            second_term: secondTerm > 0 ? secondTerm.toFixed(1) : '-',
                            third_term: thirdTerm > 0 ? thirdTerm.toFixed(1) : '-',
                            average: average.toFixed(1),
                            grade: grade
                        };
                    });

                    overallAverage = subjectCount > 0 ? (totalAverage / subjectCount).toFixed(1) : 0;
                    overallGrade = getGrade(overallAverage);

                } else if (selectedTerm && selectedTerm !== 'session') {
                    // Get term scores
                    reportTitle = selectedTerm + ' Report Card - ' + selectedYear;

                    const [termScores] = await connection.execute(`
                        SELECT 
                            s.id as subject_id,
                            s.name as subject_name,
                            s.subject_code,
                            sc.test_score,
                            sc.exam_score,
                            COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                            sc.term
                        FROM student_scores sc
                        JOIN subjects s ON sc.subject_id = s.id
                        WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
                        ORDER BY s.name
                    `, [studentId, selectedTerm, selectedYear]);

                    var totalScore = 0;

                    scores = termScores.map(function (score) {
                        var total = parseFloat(score.total_score) || 0;
                        totalScore += total;
                        var grade = getGrade(total);

                        return {
                            subject_name: score.subject_name,
                            subject_code: score.subject_code,
                            test_score: score.test_score || 0,
                            exam_score: score.exam_score || 0,
                            total_score: total.toFixed(1),
                            grade: grade
                        };
                    });

                    overallAverage = scores.length > 0 ? (totalScore / scores.length).toFixed(1) : 0;
                    overallGrade = getGrade(overallAverage);
                } else {
                    // Default to first available term if none selected
                    if (availableTerms.length > 0) {
                        selectedTerm = availableTerms[0].term_name;
                        return res.redirect('/parent/reports?studentId=' + studentId + '&term=' + selectedTerm + '&academicYear=' + selectedYear + '&viewType=term');
                    }
                }
            } else {
                // Student not found in linked students - security issue
                console.error('Parent ' + parentId + ' attempted to access unauthorized student ' + studentId);
                return res.render('parent-reports', {
                    linkedStudents: linkedStudents,
                    student: null,
                    scores: [],
                    academicYears: academicYears,
                    availableTerms: availableTerms,
                    selectedYear: selectedYear,
                    selectedTerm: selectedTerm,
                    viewType: viewType,
                    overallAverage: 0,
                    overallGrade: 'N/A',
                    reportTitle: 'Academic Reports',
                    school: school,
                    parentName: parentName,
                    username: username,  // ADD THIS LINE
                    unreadCount: unreadCount,
                    totalCount: totalCount,  // ADD THIS LINE
                    notifications: notifications,
                    moment: require('moment'),
                    error: 'You do not have permission to view this student\'s records.'
                });
            }
        }

        res.render('parent-reports', {
            linkedStudents: linkedStudents,
            student: selectedStudent,
            scores: scores,
            academicYears: academicYears,
            availableTerms: availableTerms,
            selectedYear: selectedYear,
            selectedTerm: selectedTerm,
            viewType: viewType,
            overallAverage: overallAverage,
            overallGrade: overallGrade,
            reportTitle: reportTitle,
            school: school,
            parentName: parentName,
            username: username,  // ADD THIS LINE
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading parent reports:', error);

        // Get minimal data for error page
        let emptySchool = {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789"
        };

        res.render('parent-reports', {
            linkedStudents: [],
            student: null,
            scores: [],
            academicYears: [],
            availableTerms: [],
            selectedYear: '',
            selectedTerm: '',
            viewType: 'term',
            overallAverage: 0,
            overallGrade: 'N/A',
            reportTitle: 'Academic Reports',
            school: emptySchool,
            parentName: req.session.parentName || 'Parent',
            username: req.session.parentName || req.session.username || 'Parent',  // ADD THIS LINE
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load reports: ' + error.message
        });
    }
});

// Helper function for grade

// API endpoint - Mark notification as read
router.post('/api/parent-notifications/mark-read/:id', authenticate, requireRole('parent'), async (req, res) => {
    const notificationId = req.params.id;
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND parent_id = ?',
            [notificationId, parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint - Mark all notifications as read
router.post('/api/parent-notifications/mark-all-read', authenticate, requireRole('parent'), async (req, res) => {
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE parent_id = ? AND is_read = 0',
            [parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint - Get student scores for AJAX
router.get('/api/parent/student-scores', authenticate, requireRole('parent'), async (req, res) => {
    const { studentId, term, academicYear, viewType } = req.query;
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        // Verify parent has access to this student
        const [linkCheck] = await connection.execute(
            'SELECT * FROM parent_students WHERE parent_id = ? AND student_id = ? AND can_receive_notifications = 1',
            [parentId, studentId]
        );
        
        if (linkCheck.length === 0) {
            return res.status(403).json({
                success: false,
                error: 'You do not have permission to view this student\'s scores'
            });
        }
        
        if (viewType === 'session') {
            // Get session scores
            const [scores] = await connection.execute(`
                SELECT 
                    s.name as subject_name,
                    s.subject_code,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'First Term' AND academic_year = ?
                    ), 0) as first_term,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'Second Term' AND academic_year = ?
                    ), 0) as second_term,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = ? AND subject_id = s.id 
                        AND term = 'Third Term' AND academic_year = ?
                    ), 0) as third_term
                FROM subjects s
                WHERE s.id IN (
                    SELECT DISTINCT subject_id 
                    FROM student_scores 
                    WHERE student_id = ? AND academic_year = ?
                )
                ORDER BY s.name
            `, [studentId, academicYear, studentId, academicYear, studentId, academicYear, studentId, academicYear]);
            
            res.json({ success: true, scores: scores, viewType: 'session' });
        } else {
            // Get term scores
            const [scores] = await connection.execute(`
                SELECT 
                    s.name as subject_name,
                    s.subject_code,
                    sc.test_score,
                    sc.exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
                FROM student_scores sc
                JOIN subjects s ON sc.subject_id = s.id
                WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
                ORDER BY s.name
            `, [studentId, term, academicYear]);
            
            res.json({ success: true, scores: scores, viewType: 'term' });
        }
        
    } catch (error) {
        console.error('Error fetching student scores:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch scores: ' + error.message
        });
    }
});

// ==================== PARENT GRADES ROUTE ====================

// GET route - Parent Grades View
// GET route - Parent Grades View
router.get('/parent/grades', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';  // ADD THIS LINE

        // Get query parameters
        const studentId = req.query.studentId || null;
        const term = req.query.term || null;
        const academicYear = req.query.academicYear || null;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];
        try {
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            // Get total count for notification badge
            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;  // ADD THIS LINE

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

        // Get parent name
        const parentName = req.session.parentName || 'Parent';

        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name, start_date, end_date
            FROM academic_years 
            ORDER BY start_date DESC
        `);

        // Get current academic year if none selected
        let selectedYear = academicYear;
        if (!selectedYear && academicYears.length > 0) {
            selectedYear = academicYears[0].year_name;
        }

        // Get available terms for the selected academic year
        let availableTerms = [];
        if (selectedYear) {
            const [terms] = await connection.execute(`
                SELECT at.term_name, at.start_date, at.end_date, at.is_current
                FROM academic_terms at
                JOIN academic_years ay ON at.academic_year_id = ay.id
                WHERE ay.year_name = ?
                ORDER BY 
                    CASE at.term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                        ELSE 4
                    END
            `, [selectedYear]);
            availableTerms = terms;
        }

        // Get current term if none selected
        let selectedTerm = term;
        if (!selectedTerm && availableTerms.length > 0) {
            const currentTerm = availableTerms.find(function (t) { return t.is_current === 1; });
            if (currentTerm) {
                selectedTerm = currentTerm.term_name;
            } else {
                selectedTerm = availableTerms[0].term_name;
            }
        }

        // Get selected student details and scores
        let selectedStudent = null;
        let grades = [];
        let overallAverage = 0;
        let overallGrade = 'N/A';
        let totalCredits = 0;
        let gpa = 0;

        if (studentId) {
            // Find the selected student from linked students
            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });

            if (selectedStudent && selectedTerm && selectedYear) {
                // Get grades for the selected student
                const [gradeResults] = await connection.execute(`
                    SELECT 
                        s.id as subject_id,
                        s.name as subject_name,
                        s.subject_code,
                        sc.test_score,
                        sc.exam_score,
                        COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                        sc.term,
                        sc.academic_year
                    FROM student_scores sc
                    JOIN subjects s ON sc.subject_id = s.id
                    WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
                    ORDER BY s.name
                `, [studentId, selectedTerm, selectedYear]);

                let totalScore = 0;
                let subjectCount = gradeResults.length;

                grades = gradeResults.map(function (grade) {
                    var total = parseFloat(grade.total_score) || 0;
                    totalScore += total;
                    var letterGrade = getGrade(total);
                    var gradePoint = getGradePoint(letterGrade);
                    var remark = getGradeRemark(letterGrade, total);

                    return {
                        subject_name: grade.subject_name,
                        subject_code: grade.subject_code,
                        test_score: grade.test_score || 0,
                        exam_score: grade.exam_score || 0,
                        total_score: total.toFixed(1),
                        letter_grade: letterGrade,
                        grade_point: gradePoint,
                        remark: remark
                    };
                });

                overallAverage = subjectCount > 0 ? (totalScore / subjectCount).toFixed(1) : 0;
                overallGrade = getGrade(overallAverage);

                // Calculate GPA (assuming 5.0 scale)
                var totalGradePoints = grades.reduce(function (sum, g) { return sum + g.grade_point; }, 0);
                gpa = subjectCount > 0 ? (totalGradePoints / subjectCount).toFixed(2) : 0;
                totalCredits = subjectCount;
            }
        }

        res.render('parent-grades', {
            linkedStudents: linkedStudents,
            student: selectedStudent,
            grades: grades,
            academicYears: academicYears,
            availableTerms: availableTerms,
            selectedYear: selectedYear,
            selectedTerm: selectedTerm,
            overallAverage: overallAverage,
            overallGrade: overallGrade,
            gpa: gpa,
            totalCredits: totalCredits,
            parentName: parentName,
            username: username,  // ADD THIS LINE
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading parent grades:', error);
        res.render('parent-grades', {
            linkedStudents: [],
            student: null,
            grades: [],
            academicYears: [],
            availableTerms: [],
            selectedYear: '',
            selectedTerm: '',
            overallAverage: 0,
            overallGrade: 'N/A',
            gpa: 0,
            totalCredits: 0,
            parentName: req.session.parentName || 'Parent',
            username: req.session.parentName || req.session.username || 'Parent',  // ADD THIS LINE
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load grades: ' + error.message
        });
    }
});

// ==================== PARENT ATTENDANCE ROUTE ====================

// GET route - Parent Attendance View
// GET route - Parent Attendance View
router.get('/parent/attendance', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';  // ADD THIS LINE

        // Get query parameters
        const studentId = req.query.studentId || null;
        const term = req.query.term || null;
        const academicYear = req.query.academicYear || null;
        const month = req.query.month || null;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];
        try {
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            // Get total count for notification badge
            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;  // ADD THIS LINE

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

        // Get parent name
        const parentName = req.session.parentName || 'Parent';

        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name, start_date, end_date
            FROM academic_years 
            ORDER BY start_date DESC
        `);

        // Get current academic year if none selected
        let selectedYear = academicYear;
        if (!selectedYear && academicYears.length > 0) {
            selectedYear = academicYears[0].year_name;
        }

        // Get available terms for the selected academic year
        let availableTerms = [];
        if (selectedYear) {
            const [terms] = await connection.execute(`
                SELECT at.term_name, at.start_date, at.end_date, at.is_current
                FROM academic_terms at
                JOIN academic_years ay ON at.academic_year_id = ay.id
                WHERE ay.year_name = ?
                ORDER BY 
                    CASE at.term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                        ELSE 4
                    END
            `, [selectedYear]);
            availableTerms = terms;
        }

        // Get current term if none selected
        let selectedTerm = term;
        if (!selectedTerm && availableTerms.length > 0) {
            const currentTerm = availableTerms.find(function (t) { return t.is_current === 1; });
            if (currentTerm) {
                selectedTerm = currentTerm.term_name;
            } else {
                selectedTerm = availableTerms[0].term_name;
            }
        }

        // Get months for filter
        const months = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];
        let selectedMonth = month || null;

        // Get selected student details and attendance
        let selectedStudent = null;
        let attendanceRecords = [];
        let attendanceSummary = {
            present: 0,
            absent: 0,
            late: 0,
            excused: 0,
            total: 0,
            percentage: 0
        };
        let monthlyAttendance = {};
        let weeklyAttendance = [];

        if (studentId) {
            // Find the selected student from linked students
            selectedStudent = linkedStudents.find(function (s) { return s.id == studentId; });

            if (selectedStudent && selectedTerm && selectedYear) {
                // Get term dates
                const [termDates] = await connection.execute(`
                    SELECT at.start_date, at.end_date
                    FROM academic_terms at
                    JOIN academic_years ay ON at.academic_year_id = ay.id
                    WHERE ay.year_name = ? AND at.term_name = ?
                `, [selectedYear, selectedTerm]);

                let startDate = null;
                let endDate = null;

                if (termDates.length > 0) {
                    startDate = termDates[0].start_date;
                    endDate = termDates[0].end_date;
                }

                // Build date filter
                let dateFilter = '';
                let queryParams = [studentId];

                if (startDate && endDate) {
                    dateFilter = ' AND date BETWEEN ? AND ?';
                    queryParams.push(startDate, endDate);
                }

                if (selectedMonth) {
                    const monthNumber = months.indexOf(selectedMonth) + 1;
                    const monthStr = monthNumber.toString().padStart(2, '0');
                    dateFilter += ' AND DATE_FORMAT(date, "%Y-%m") = ?';
                    queryParams.push(selectedYear + '-' + monthStr);
                }

                // Get attendance records
                const [attendance] = await connection.execute(`
                    SELECT 
                        ar.*,
                        DATE_FORMAT(ar.date, '%W, %M %d, %Y') as formatted_date,
                        DAYNAME(ar.date) as day_name,
                        MONTH(ar.date) as month_num,
                        WEEK(ar.date) as week_num
                    FROM attendance_records ar
                    WHERE ar.student_id = ? ${dateFilter}
                    ORDER BY ar.date DESC
                `, queryParams);

                attendanceRecords = attendance;

                // Calculate summary statistics
                let present = 0;
                let absent = 0;
                let late = 0;
                let excused = 0;
                let total = attendanceRecords.length;

                for (var i = 0; i < attendanceRecords.length; i++) {
                    var record = attendanceRecords[i];
                    var isPresent = (record.morning_status === 'present' || record.afternoon_status === 'present');
                    var isAbsent = (record.morning_status === 'absent' && record.afternoon_status === 'absent');
                    var isLate = (record.morning_status === 'late' || record.afternoon_status === 'late');
                    var isExcused = (record.morning_status === 'excused' || record.afternoon_status === 'excused');

                    if (isPresent) present++;
                    else if (isAbsent) absent++;
                    else if (isLate) late++;
                    else if (isExcused) excused++;
                }

                attendanceSummary = {
                    present: present,
                    absent: absent,
                    late: late,
                    excused: excused,
                    total: total,
                    percentage: total > 0 ? ((present / total) * 100).toFixed(1) : 0
                };

                // Calculate monthly attendance
                var monthlyData = {};
                for (var i = 0; i < attendanceRecords.length; i++) {
                    var record = attendanceRecords[i];
                    var monthName = months[record.month_num - 1];
                    if (!monthlyData[monthName]) {
                        monthlyData[monthName] = { present: 0, total: 0 };
                    }
                    monthlyData[monthName].total++;
                    if (record.morning_status === 'present' || record.afternoon_status === 'present') {
                        monthlyData[monthName].present++;
                    }
                }

                monthlyAttendance = monthlyData;

                // Calculate weekly attendance (last 4 weeks)
                var weeklyData = {};
                for (var i = 0; i < attendanceRecords.length && i < 28; i++) {
                    var record = attendanceRecords[i];
                    var weekKey = 'Week ' + (record.week_num % 4 || 4);
                    if (!weeklyData[weekKey]) {
                        weeklyData[weekKey] = { present: 0, total: 0 };
                    }
                    weeklyData[weekKey].total++;
                    if (record.morning_status === 'present' || record.afternoon_status === 'present') {
                        weeklyData[weekKey].present++;
                    }
                }

                weeklyAttendance = Object.keys(weeklyData).map(function (key) {
                    return {
                        week: key,
                        present: weeklyData[key].present,
                        total: weeklyData[key].total,
                        percentage: (weeklyData[key].present / weeklyData[key].total * 100).toFixed(1)
                    };
                }).slice(0, 4);
            }
        }

        res.render('parent-attendance', {
            linkedStudents: linkedStudents,
            student: selectedStudent,
            attendanceRecords: attendanceRecords,
            attendanceSummary: attendanceSummary,
            monthlyAttendance: monthlyAttendance,
            weeklyAttendance: weeklyAttendance,
            academicYears: academicYears,
            availableTerms: availableTerms,
            selectedYear: selectedYear,
            selectedTerm: selectedTerm,
            selectedMonth: selectedMonth,
            months: months,
            parentName: parentName,
            username: username,  // ADD THIS LINE
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading parent attendance:', error);
        res.render('parent-attendance', {
            linkedStudents: [],
            student: null,
            attendanceRecords: [],
            attendanceSummary: { present: 0, absent: 0, late: 0, excused: 0, total: 0, percentage: 0 },
            monthlyAttendance: {},
            weeklyAttendance: [],
            academicYears: [],
            availableTerms: [],
            selectedYear: '',
            selectedTerm: '',
            selectedMonth: null,
            months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
            parentName: req.session.parentName || 'Parent',
            username: req.session.parentName || req.session.username || 'Parent',  // ADD THIS LINE
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load attendance: ' + error.message
        });
    }
});

// ==================== PARENT FEES ROUTE ====================

// GET route - Parent Fees View
// GET route - Parent Fees View
router.get('/parent/fees', authenticate, requireRole('parent'), async (req, res) => {
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
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all linked students for the parent
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

        const parentName = req.session.parentName || 'Parent';

        // If no child specified: if 1 child, auto-select; if multiple, redirect to All Children
        let activeStudentId = studentId;
        if (!activeStudentId) {
            if (linkedStudents.length === 1) {
                activeStudentId = linkedStudents[0].id;
            } else if (linkedStudents.length > 1) {
                return res.redirect('/parent/children?select=fees');
            }
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
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT academicYear as year_name
            FROM fees 
            WHERE academicYear IS NOT NULL
            ORDER BY academicYear DESC
        `);

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

                const [feeRecords] = await connection.execute(`
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
                    WHERE f.studentId = ? ${statusFilter}
                    ORDER BY f.created_at DESC
                `, queryParams);

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

                const [history] = await connection.execute(`
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
                `, [activeStudentId]);

                paymentHistory = history;

                // Fetch submitted payments by parent
                const [subs] = await connection.execute(`
                    SELECT pp.*, f.receiptNumber as fee_receipt_number
                    FROM parent_payments pp
                    LEFT JOIN fees f ON pp.fee_id = f.id
                    WHERE pp.student_id = ? AND pp.parent_id = ?
                    ORDER BY pp.created_at DESC
                `, [activeStudentId, parentId]);
                submittedPayments = subs;

                // Count payments in current term (max 2 rule)
                const [countRow] = await connection.execute(`
                    SELECT COUNT(*) as count 
                    FROM parent_payments 
                    WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
                `, [activeStudentId, currentTermInfo.academicYear, currentTermInfo.currentTerm]);
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

// GET route - View fee receipt
router.get('/parent/fee-receipt/:id', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const feeId = req.params.id;
        
        // Get fee record
        const [feeRecords] = await connection.execute(`
            SELECT f.*, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM fees f
            JOIN students s ON f.studentId = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE f.id = ?
        `, [feeId]);
        
        if (feeRecords.length === 0) {
            req.session.error = 'Receipt not found';
            return res.redirect('/parent/fees');
        }
        
        const receipt = feeRecords[0];
        
        // Verify parent has access to this student
        const [linkCheck] = await connection.execute(`
            SELECT * FROM parent_students 
            WHERE parent_id = ? AND student_id = ? AND can_receive_notifications = 1
        `, [parentId, receipt.studentId]);
        
        if (linkCheck.length === 0) {
            req.session.error = 'You do not have permission to view this receipt';
            return res.redirect('/parent/fees');
        }
        
        // Get school information
        const schoolId = req.session.schoolId || null;
        const [schoolInfo] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };
        
        res.render('parent-fee-receipt', {
            receipt: receipt,
            school: school,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading fee receipt:', error);
        req.session.error = 'Failed to load receipt';
        res.redirect('/parent/fees');
    }
});

// ==================== PARENT NOTIFICATIONS ROUTES ====================

// GET route - Parent Notifications View
// GET route - Parent Notifications View
router.get('/parent/notifications', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;

        // Get parent name for display
        const parentName = req.session.parentName || req.session.username || 'Parent';

        // Get query parameters for filtering
        const filter = req.query.filter || 'all'; // all, unread, read
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        // Get unread notifications count for badge
        let unreadCount = 0;
        try {
            const [unreadResult] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = unreadResult[0]?.count || 0;
        } catch (err) {
            console.error('Error fetching unread count:', err);
            unreadCount = 0;
        }

        // Build query based on filter
        let whereClause = 'WHERE parent_id = ?';
        let queryParams = [parentId];

        if (filter === 'unread') {
            whereClause += ' AND is_read = 0';
        } else if (filter === 'read') {
            whereClause += ' AND is_read = 1';
        }

        // Get total count for pagination
        const [countResult] = await connection.execute(`
            SELECT COUNT(*) as total 
            FROM parent_notifications 
            ${whereClause}
        `, queryParams);

        const totalCount = countResult[0]?.total || 0;
        const totalPages = Math.ceil(totalCount / limit);

        // Get notifications with pagination
        const [notifications] = await connection.execute(`
            SELECT 
                n.*,
                DATE_FORMAT(n.created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
            FROM parent_notifications n
            ${whereClause}
            ORDER BY n.created_at DESC
            LIMIT ? OFFSET ?
        `, [...queryParams, limit, offset]);

        // Get recent notifications for sidebar (last 5)
        const [recentNotifications] = await connection.execute(`
            SELECT * FROM parent_notifications 
            WHERE parent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [parentId]);

        // Get success/error messages from session
        const success = req.session.success || null;
        const error = req.session.error || null;

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

        res.render('parent-notifications', {
            notifications: notifications,
            recentNotifications: recentNotifications,
            unreadCount: unreadCount,
            currentFilter: filter,
            currentPage: page,
            totalPages: totalPages,
            totalCount: totalCount,
            limit: limit,
            parentName: parentName,
            username: parentName,  // <-- ADD THIS LINE - use parentName as username
            moment: require('moment'),
            error: error,
            success: success
        });

    } catch (error) {
        console.error('Error loading parent notifications:', error);
        const parentName = req.session.parentName || req.session.username || 'Parent';

        res.render('parent-notifications', {
            notifications: [],
            recentNotifications: [],
            unreadCount: 0,
            currentFilter: 'all',
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            limit: 20,
            parentName: parentName,
            username: parentName,  // <-- ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load notifications: ' + error.message,
            success: null
        });
    }
});

// POST route - Mark single notification as read
router.post('/parent/notifications/mark-read/:id', authenticate, requireRole('parent'), async (req, res) => {
    const notificationId = req.params.id;
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        // Check if notification belongs to this parent
        const [check] = await connection.execute(
            'SELECT id FROM parent_notifications WHERE id = ? AND parent_id = ?',
            [notificationId, parentId]
        );
        
        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE id = ?',
            [notificationId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Mark all notifications as read
router.post('/parent/notifications/mark-all-read', authenticate, requireRole('parent'), async (req, res) => {
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE parent_id = ? AND is_read = 0',
            [parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete notification
router.post('/parent/notifications/delete/:id', authenticate, requireRole('parent'), async (req, res) => {
    const notificationId = req.params.id;
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        // Check if notification belongs to this parent
        const [check] = await connection.execute(
            'SELECT id FROM parent_notifications WHERE id = ? AND parent_id = ?',
            [notificationId, parentId]
        );
        
        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }
        
        await connection.execute(
            'DELETE FROM parent_notifications WHERE id = ?',
            [notificationId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete all read notifications
router.post('/parent/notifications/delete-all-read', authenticate, requireRole('parent'), async (req, res) => {
    const parentId = req.session.parentId;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'DELETE FROM parent_notifications WHERE parent_id = ? AND is_read = 1',
            [parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting read notifications:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint - Get unread notification count (for AJAX polling)
router.get('/api/parent/notifications/unread-count', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        
        const [result] = await connection.execute(
            'SELECT COUNT(*) as count FROM parent_notifications WHERE parent_id = ? AND is_read = 0',
            [parentId]
        );
        
        res.json({ success: true, count: result[0]?.count || 0 });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.json({ success: false, count: 0 });
    }
});

// ==================== PARENT CONTACT ROUTES ====================

// GET route - Parent Contact Page
router.get('/parent/contact', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;

        // Get unread notifications count
        let unreadCount = 0;
        let totalCount = 0;  // <-- ADD THIS LINE
        let notifications = [];

        try {
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            // Get total count for notification badge
            const [totalResult] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalResult[0]?.total || 0;  // <-- ADD THIS LINE

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 5
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;  // <-- ADD THIS LINE
            notifications = [];
        }

        // Get parent information
        const [parents] = await connection.execute(`
            SELECT first_name, last_name, email, phone 
            FROM parents 
            WHERE id = ? AND school_id = ?
        `, [parentId, schoolId]);

        const parentName = parents.length > 0 ? `${parents[0].first_name} ${parents[0].last_name}` : req.session.parentName || 'Parent';
        const parentEmail = parents.length > 0 ? parents[0].email : req.session.parentEmail || '';
        const parentPhone = parents.length > 0 ? parents[0].phone : '';

        // Get school information
        const [schoolInfo] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');

        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            website: "www.excelcollege.edu.ng"
        };

        // Get success/error messages from session
        const success = req.session.success || null;
        const error = req.session.error || null;

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

        // Get username for display
        const username = req.session.parentName || req.session.username || 'Parent';

        res.render('parent-contact', {
            parentName: parentName,
            parentEmail: parentEmail,
            parentPhone: parentPhone,
            school: school,
            unreadCount: unreadCount,
            totalCount: totalCount,  // <-- ADD THIS LINE
            notifications: notifications,
            username: username,  // <-- ADD THIS LINE (if your template uses it)
            moment: require('moment'),
            success: success,
            error: error
        });

    } catch (error) {
        console.error('Error loading parent contact page:', error);

        // Get username for error rendering
        const username = req.session.parentName || req.session.username || 'Parent';

        res.render('parent-contact', {
            parentName: req.session.parentName || 'Parent',
            parentEmail: '',
            parentPhone: '',
            school: {
                name: "Excel College",
                address: "12 Education Road, Lagos, Nigeria",
                email: "info@excelcollege.edu.ng",
                phone: "+234 812 345 6789",
                website: "www.excelcollege.edu.ng"
            },
            unreadCount: 0,
            totalCount: 0,  // <-- ADD THIS LINE
            notifications: [],
            username: username,  // <-- ADD THIS LINE
            moment: require('moment'),
            success: null,
            error: 'Failed to load contact page: ' + error.message
        });
    }
});

// POST route - Send contact message
router.post('/parent/contact/send', authenticate, requireRole('parent'), uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        
        const { subject, message, category } = req.body;
        
        // Validate required fields
        if (!subject || !message) {
            req.session.error = 'Please provide both a subject and a message.';
            return res.redirect('/parent/contact');
        }
        
        // Get parent information
        const [parents] = await connection.execute(`
            SELECT first_name, last_name, email, phone 
            FROM parents 
            WHERE id = ? AND school_id = ?
        `, [parentId, schoolId]);
        
        const parent = parents[0];
        const parentName = `${parent.first_name} ${parent.last_name}`;
        
        // Insert contact message into database
        await connection.execute(`
            INSERT INTO parent_contacts 
            (parent_id, parent_name, parent_email, parent_phone, subject, message, category, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
        `, [parentId, parentName, parent.email, parent.phone || null, subject, message, category || 'general']);
        
        // Also create a notification for admin (if you have admin notifications table)
        try {
            // Get school admin users
            const [admins] = await connection.execute(`
                SELECT id FROM users WHERE role = 'admin' AND school_id = ?
            `, [schoolId]);
            
            for (const admin of admins) {
                await connection.execute(`
                    INSERT INTO admin_notifications 
                    (admin_id, title, message, type, reference_id, created_at)
                    VALUES (?, ?, ?, 'contact', ?, NOW())
                `, [admin.id, 'New Contact Message', `New message from parent ${parentName}: ${subject}`, null]);
            }
        } catch (err) {
            console.error('Error creating admin notification:', err);
            // Don't fail the request if notification fails
        }
        
        req.session.success = 'Your message has been sent successfully. The school will respond to you shortly.';
        res.redirect('/parent/contact');
        
    } catch (error) {
        console.error('Error sending contact message:', error);
        req.session.error = 'Failed to send message. Please try again later.';
        res.redirect('/parent/contact');
    }
});

// GET route - Parent Profile (redirects to profile with ID)
router.get('/parent-profile', authenticate, async (req, res) => {
    // For parent users, redirect to their profile with ID
    if (req.session.role === 'parent' && req.session.parentId) {
        return res.redirect(`/parent-profile/${req.session.parentId}`);
    }
    // For admin, redirect to all parents list or show error
    if (req.session.role === 'admin') {
        return res.redirect('/all-parents');
    }
    // Default redirect
    res.redirect('/login');
});

// GET route - View Parent Profile (for both admin and parent)
// GET route - View Parent Profile (for both admin and parent)
router.get('/parent-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.params.id;
        const schoolId = req.session.schoolId || null;
        const userRole = req.session.role;
        const loggedInParentId = req.session.parentId;

        // Check if user has permission (admin or the parent themselves)
        if (userRole !== 'admin' && loggedInParentId != parentId) {
            req.session.error = 'You do not have permission to view this profile';
            if (userRole === 'parent') {
                return res.redirect('/parent/parent-dashboard');
            }
            return res.redirect('/');
        }

        // Get parent information
        const [parents] = await connection.execute(`
            SELECT p.*, 
                   COUNT(DISTINCT ps.student_id) as children_count
            FROM parents p
            LEFT JOIN parent_students ps ON p.id = ps.parent_id AND ps.can_receive_notifications = 1
            WHERE p.id = ? AND p.school_id = ?
            GROUP BY p.id
        `, [parentId, schoolId]);

        if (parents.length === 0) {
            req.session.error = 'Parent not found';
            if (userRole === 'admin') {
                return res.redirect('/all-parents');
            }
            return res.redirect('/parent/parent-dashboard');
        }

        const parent = parents[0];

        // Calculate active students and pending fees
        let activeStudents = 0;
        let pendingFees = 0;

        // Get linked children with class information
        const [children] = await connection.execute(`
            SELECT s.*, 
                   c.className, 
                   c.level, 
                   c.department,
                   ps.relationship, 
                   ps.is_primary,
                   ps.created_at as linked_date
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

        // Count active students (students with status 'active' or 'enrolled')
        activeStudents = children.filter(function (c) {
            return c.status === 'active' || c.status === 'enrolled';
        }).length;

        // Get pending fees summary for all children
        if (children.length > 0) {
            const childIds = children.map(function (c) { return c.id; });
            const placeholders = childIds.map(function () { return '?'; }).join(',');

            const [feesResult] = await connection.execute(`
                SELECT COALESCE(SUM(f.amount - f.amountPaid), 0) as pending
                FROM fees f
                WHERE f.studentId IN (${placeholders}) AND f.status != 'paid'
            `, childIds);

            pendingFees = feesResult[0]?.pending || 0;
        }

        // Get notifications (for parent view only)
        let unreadCount = 0;
        let totalCount = 0;  // <-- ADD THIS LINE
        let notifications = [];

        if (userRole === 'parent') {
            try {
                // Check if notifications table exists
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'parent_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [notifCount] = await connection.execute(`
                        SELECT COUNT(*) as count FROM parent_notifications 
                        WHERE parent_id = ? AND is_read = 0
                    `, [parentId]);
                    unreadCount = notifCount[0]?.count || 0;

                    // Get total count for notification badge
                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total FROM parent_notifications 
                        WHERE parent_id = ?
                    `, [parentId]);
                    totalCount = totalResult[0]?.total || 0;  // <-- ADD THIS LINE

                    const [notifList] = await connection.execute(`
                        SELECT id, message, is_read, created_at, title 
                        FROM parent_notifications 
                        WHERE parent_id = ? 
                        ORDER BY created_at DESC 
                        LIMIT 10
                    `, [parentId]);
                    notifications = notifList;
                }
            } catch (err) {
                console.error('Error fetching notifications:', err.message);
                unreadCount = 0;
                totalCount = 0;  // <-- ADD THIS LINE
                notifications = [];
            }
        }

        // Get user display name
        let displayName = 'Parent';
        let username = req.session.username || 'Parent';

        if (userRole === 'admin') {
            displayName = req.session.username || 'Administrator';
            username = req.session.username || 'Admin';
        } else {
            displayName = `${parent.first_name} ${parent.last_name}`;
            username = displayName;
        }

        res.render('parent-profile', {
            parent: parent,
            children: children,
            childrenCount: children.length,
            activeStudents: activeStudents,
            pendingFees: pendingFees,
            unreadCount: unreadCount,
            totalCount: totalCount,  // <-- ADD THIS LINE
            notifications: notifications,
            userRole: userRole,
            displayName: displayName,
            username: username,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Parent Profile',
            currentPage: 'parent-profile'
        });

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading parent profile:', error);

        // Send error response with basic data
        const userRole = req.session.role || 'parent';
        const username = req.session.username || 'Parent';

        res.status(500).render('parent-profile', {
            parent: {
                first_name: 'Parent',
                last_name: '',
                email: '',
                phone: '',
                status: 'active',
                created_at: new Date()
            },
            children: [],
            childrenCount: 0,
            activeStudents: 0,
            pendingFees: 0,
            unreadCount: 0,
            totalCount: 0,  // <-- ADD THIS LINE
            notifications: [],
            userRole: userRole,
            displayName: req.session.username || 'User',
            username: username,
            moment: require('moment'),
            success: null,
            error: 'Failed to load parent profile: ' + error.message,
            title: 'Parent Profile',
            currentPage: 'parent-profile'
        });
    }
});

// Mark notification as read (AJAX)
router.post('/parent/mark-notification-read', authenticate, requireRole('parent'), async (req, res) => {
    const { notificationId } = req.body;
    const parentId = req.session.parentId;

    try {
        const connection = await getConnection();
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND parent_id = ?',
            [notificationId, parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== PARENT CHILDREN ROUTES ====================

// GET route - View all children linked to parent
// GET route - View all children linked to parent
router.get('/parent/children', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Get current academic year and term
        const [currentAcademicYearRows] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        const [currentTermRows] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);
        const currentAcademicYear = currentAcademicYearRows.length > 0 ? currentAcademicYearRows[0].year_name : '2026/2027';
        const currentTerm = currentTermRows.length > 0 ? currentTermRows[0].term_name : 'First Term';

        // Get all linked students with detailed information
        const [children] = await connection.execute(`
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
        `, [currentTerm, currentAcademicYear, parentId]);

        // Unread notifications count
        let unreadCount = 0;
        let totalCount = 0;
        try {
            const [notifications] = await connection.execute(`
                SELECT COUNT(*) as count FROM parent_notifications WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notifications[0]?.count || 0;

            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total FROM parent_notifications WHERE parent_id = ?
            `, [parentId]);
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
                const [cbRows] = await connection.execute(`
                    SELECT SUM(amount) as total 
                    FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                `, [child.classId, currentAcademicYear, currentTerm]);
                billAmount = parseFloat(cbRows[0]?.total) || 0;
            }
            if (billAmount === 0) {
                const [feeRows] = await connection.execute(`
                    SELECT MAX(billAmount) as bill 
                    FROM fees 
                    WHERE studentId = ? AND academicYear = ? AND term = ?
                `, [child.id, currentAcademicYear, currentTerm]);
                billAmount = parseFloat(feeRows[0]?.bill) || 0;
            }

            // 2. Approved payments ONLY (Declined/rejected payments strictly excluded)
            const [paidRows] = await connection.execute(`
                SELECT SUM(amountPaid) as total 
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            `, [child.id, currentAcademicYear, currentTerm]);
            const feesPaid = parseFloat(paidRows[0]?.total) || 0;

            // 3. Term payment submissions count (pending or approved; max 2 limit)
            const [pmtCountRow] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_payments 
                WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
            `, [child.id, currentAcademicYear, currentTerm]);
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
            const [subjectCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM student_scores 
                WHERE student_id = ? AND academic_year = ? AND term = ?
            `, [child.id, currentAcademicYear, currentTerm]);

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
        const [notifications] = await connection.execute(`
            SELECT * FROM parent_notifications 
            WHERE parent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
        `, [parentId]);

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
});

// GET route - View specific child details
router.get('/parent/children/:id', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const childId = req.params.id;

        // Verify this child is linked to the parent
        const [linkCheck] = await connection.execute(`
            SELECT * FROM parent_students 
            WHERE parent_id = ? AND student_id = ? AND can_receive_notifications = 1
        `, [parentId, childId]);

        if (linkCheck.length === 0) {
            req.session.error = 'You do not have permission to view this child\'s details';
            return res.redirect('/parent/children');
        }

        // Get detailed child information
        const [children] = await connection.execute(`
            SELECT 
                s.*,
                c.className,
                c.level,
                c.department as classDepartment,
                c.professorName as classTeacher,
                COALESCE((
                    SELECT AVG(test_score + exam_score) 
                    FROM student_scores 
                    WHERE student_id = s.id AND term = (
                        SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
                    ) AND academic_year = (
                        SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
                    )
                ), 0) as current_average
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.id = ?
        `, [childId]);

        if (children.length === 0) {
            req.session.error = 'Child not found';
            return res.redirect('/parent/children');
        }

        const child = children[0];
        
        // Get recent results
        const [recentResults] = await connection.execute(`
            SELECT sc.*, sub.name as subject_name
            FROM student_scores sc
            JOIN subjects sub ON sc.subject_id = sub.id
            WHERE sc.student_id = ? 
            ORDER BY sc.created_at DESC 
            LIMIT 5
        `, [childId]);
        
        // Get attendance summary for current term
        const [attendanceSummary] = await connection.execute(`
            SELECT 
                COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                COUNT(*) as total_days,
                ROUND((COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / COUNT(*)), 2) as percentage
            FROM attendance_records 
            WHERE student_id = ?
        `, [childId]);
        
        // Get fee summary
        const [feeSummary] = await connection.execute(`
            SELECT 
                COALESCE(SUM(amount), 0) as total_due,
                COALESCE(SUM(amountPaid), 0) as total_paid,
                COUNT(*) as fee_count
            FROM fees 
            WHERE studentId = ?
        `, [childId]);
        
        // Get upcoming events for child's class
        const [upcomingEvents] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate >= CURDATE() 
            AND (title LIKE ? OR description LIKE ?)
            ORDER BY eventDate ASC 
            LIMIT 5
        `, [`%${child.className}%`, `%${child.className}%`]);

        res.render('parent-child-detail', {
            child: {
                ...child,
                fullName: studentDisplayName(child)
            },
            recentResults: recentResults,
            attendanceSummary: attendanceSummary[0] || { present_days: 0, total_days: 0, percentage: 0 },
            feeSummary: feeSummary[0] || { total_due: 0, total_paid: 0, fee_count: 0 },
            upcomingEvents: upcomingEvents,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null
        });
        
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading child details:', error);
        req.session.error = 'Failed to load child details: ' + error.message;
        res.redirect('/parent/children');
    }
});

// GET route - Get child's report card (PDF view)
router.get('/parent/child-report/:id', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const childId = req.params.id;
        const { term, academicYear } = req.query;

        // Verify access
        const [linkCheck] = await connection.execute(`
            SELECT * FROM parent_students 
            WHERE parent_id = ? AND student_id = ? AND can_receive_notifications = 1
        `, [parentId, childId]);

        if (linkCheck.length === 0) {
            return res.status(403).send('Access denied');
        }

        // Redirect to reports page with parameters
        res.redirect(`/parent/reports?studentId=${childId}&term=${term || ''}&academicYear=${academicYear || ''}`);
        
    } catch (error) {
        console.error('Error redirecting to report:', error);
        res.status(500).send('Error loading report');
    }
});

// Mark all notifications as read
router.post('/parent/mark-all-notifications-read', authenticate, requireRole('parent'), async (req, res) => {
    const parentId = req.session.parentId;

    try {
        const connection = await getConnection();
        
        await connection.execute(
            'UPDATE parent_notifications SET is_read = 1, read_at = NOW() WHERE parent_id = ? AND is_read = 0',
            [parentId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get unread notification count (AJAX)
router.get('/api/parent-notifications/unread-count', authenticate, async (req, res) => {
    try {
        if (req.session.role !== 'parent' && !req.session.parentId) {
            return res.json({ count: 0 });
        }
        
        const connection = await getConnection();
        const [result] = await connection.execute(
            'SELECT COUNT(*) as count FROM parent_notifications WHERE parent_id = ? AND is_read = 0',
            [req.session.parentId]
        );
        res.json({ count: result[0].count });
    } catch (error) {
        res.json({ count: 0 });
    }
});
// ==================== END PARENT DASHBOARD ROUTES ====================

router.get('/parent/student-profile/:id', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const studentId = req.params.id;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Verify this student is linked to the parent
        const [linkCheck] = await connection.execute(`
            SELECT * FROM parent_students 
            WHERE parent_id = ? AND student_id = ? AND can_receive_notifications = 1
        `, [parentId, studentId]);

        if (linkCheck.length === 0) {
            req.session.error = 'You do not have permission to view this student\'s profile';
            return res.redirect('/parent/children');
        }

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [notificationCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_notifications 
                WHERE parent_id = ? AND is_read = 0
            `, [parentId]);
            unreadCount = notificationCount[0]?.count || 0;

            const [totalNotifications] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM parent_notifications 
                WHERE parent_id = ?
            `, [parentId]);
            totalCount = totalNotifications[0]?.total || 0;

            const [notificationList] = await connection.execute(`
                SELECT * FROM parent_notifications 
                WHERE parent_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [parentId]);
            notifications = notificationList;
        } catch (err) {
            console.error('Error fetching notifications:', err);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get parent name
        const parentName = req.session.parentName || 'Parent';

        // Get student data with class information
        const [students] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department as classDepartment,
                   c.professorName as classTeacher
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.id = ? AND s.school_id = ?
        `, [studentId, schoolId]);

        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/parent/children');
        }

        const student = students[0];

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const academicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '';
        const term = currentTerm.length > 0 ? currentTerm[0].term_name : '';

        // Get student's results for current term
        const [results] = await connection.execute(`
            SELECT sc.*, sub.name as subject_name
            FROM student_scores sc
            JOIN subjects sub ON sc.subject_id = sub.id
            WHERE sc.student_id = ? AND sc.academic_year = ? AND sc.term = ?
            ORDER BY sub.name
        `, [studentId, academicYear, term]);

        // Calculate overall average
        let overallAverage = 0;
        if (results.length > 0) {
            let totalScore = 0;
            results.forEach(result => {
                totalScore += (parseFloat(result.test_score) || 0) + (parseFloat(result.exam_score) || 0);
            });
            overallAverage = totalScore / results.length;
        }

        // Get attendance summary for current term
        const [attendanceSummary] = await connection.execute(`
            SELECT 
                COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                COUNT(*) as total_days,
                ROUND((COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / COUNT(*)), 2) as percentage
            FROM attendance_records 
            WHERE student_id = ? AND academic_year = ? AND term = ?
        `, [studentId, academicYear, term]);

        const attendance = attendanceSummary[0] || {
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            excused_days: 0,
            total_days: 0,
            percentage: 0
        };

        // Get fee summary
        const [feeSummary] = await connection.execute(`
            SELECT 
                SUM(CASE WHEN status IN ('paid', 'partial') THEN amountPaid ELSE 0 END) as total_paid,
                SUM(billAmount) as total_due,
                COUNT(*) as fee_count
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ?
        `, [studentId, academicYear, term]);

        const fees = feeSummary[0] || { total_paid: 0, total_due: 0, fee_count: 0 };

        // Get upcoming events for student's class
        const [upcomingEvents] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate >= CURDATE() 
            AND (title LIKE ? OR description LIKE ?)
            ORDER BY eventDate ASC 
            LIMIT 5
        `, [`%${student.className || ''}%`, `%${student.className || ''}%`]);

        // Render the view with ALL required variables
        res.render('parent-student-profile', {
            // Student data
            student: student,
            studentData: student,
            className: student.className || 'Not Assigned',
            admissionNumber: student.admission_number || 'N/A',
            
            // Results
            results: results,
            overallAverage: overallAverage || 0,
            
            // Attendance
            attendance: attendance,
            
            // Fees
            fees: fees,
            
            // Events
            upcomingEvents: upcomingEvents,
            
            // Academic info
            currentAcademicYear: academicYear,
            currentTerm: term,
            
            // Parent info
            parentName: parentName,
            parentId: parentId,  // <-- IMPORTANT: Pass parentId explicitly
            
            // Notifications
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            
            // User
            username: username,
            
            // Helper functions
            calculateGrade: getGrade,
            getGradeColor: getGradeColor,
            moment: require('moment'),
            
            // Status messages
            error: null,
            success: null,
            
            // Page info
            title: 'Student Profile',
            currentPage: 'parent-student-profile'
        });

    } catch (error) {
        console.error('Error loading parent student profile:', error);
        req.session.error = 'Failed to load student profile: ' + error.message;
        res.redirect('/parent/children');
    }
});

// ==================== PARENT MAKE FEE PAYMENT & CLASS BILLS ROUTES ====================

// GET: Make Fee Payment View
router.get('/parent/make-payment', authenticate, requireRole('parent'), async (req, res) => {
    try {
        const connection = await getConnection();
        const parentId = req.session.parentId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.parentName || req.session.username || 'Parent';

        // Get linked students
        const [linkedStudents] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department 
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE ps.parent_id = ? AND ps.can_receive_notifications = 1
            ORDER BY s.firstName, s.lastName
        `, [parentId]);

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
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
            ORDER BY year_name DESC
        `, [schoolId, schoolId]);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
        `, [schoolId, schoolId]);

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
            const [pCount] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM parent_payments 
                WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
            `, [selectedStudentId, activeYear, activeTerm]);
            termPaymentCount = pCount[0]?.count || 0;

            // Load Class Bills breakdown for this student's class
            if (selectedStudent.classId) {
                const [bills] = await connection.execute(`
                    SELECT * FROM class_bills 
                    WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                    ORDER BY fee_type
                `, [selectedStudent.classId, activeYear, activeTerm]);
                classBills = bills;
                totalClassBill = classBills.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
            }

            // Load previous approved payments from fees table
            const [feeStats] = await connection.execute(`
                SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
            `, [selectedStudentId, activeYear, activeTerm]);
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
        const [myPayments] = await connection.execute(`
            SELECT pp.*, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE pp.parent_id = ? AND pp.student_id = ?
            ORDER BY pp.created_at DESC
        `, [parentId, selectedStudentId]);

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
            return res.redirect(`/parent/make-payment?studentId=${studentId || ''}&error=` + encodeURIComponent('Please complete all required fields.'));
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.redirect(`/parent/make-payment?studentId=${studentId}&error=` + encodeURIComponent('Please enter a valid payment amount greater than zero.'));
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
            const [bills] = await connection.execute(`
                SELECT SUM(amount) as total 
                FROM class_bills 
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
            `, [studentInfo.classId, academicYear.trim(), term.trim()]);
            totalClassBill = parseFloat(bills[0]?.total) || 0;
        }

        if (totalClassBill === 0) {
            const [feeStats] = await connection.execute(`
                SELECT MAX(billAmount) as billAmount
                FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ?
            `, [studentId, academicYear.trim(), term.trim()]);
            totalClassBill = parseFloat(feeStats[0]?.billAmount) || 0;
        }

        if (totalClassBill <= 0) {
            return res.redirect(`/parent/make-payment?studentId=${studentId}&error=` + encodeURIComponent('The official class bill for this term has not been published by the school yet. Payments cannot be accepted until published.'));
        }

        // 2. Fetch approved paid so far
        const [paidRows] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
        `, [studentId, academicYear.trim(), term.trim()]);
        const totalPaidSoFar = parseFloat(paidRows[0]?.totalPaid) || 0;
        const outstandingBalance = Math.max(0, totalClassBill - totalPaidSoFar);

        if (outstandingBalance <= 0) {
            return res.redirect(`/parent/make-payment?studentId=${studentId}&error=` + encodeURIComponent(`The class bill of ₦${totalClassBill.toLocaleString()} for ${term} (${academicYear}) has already been fully paid.`));
        }

        // 3. Check 2 payments per term limit (CRITICAL RULE: only pending or approved count; declined payments do not count)
        const [countRow] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        `, [studentId, academicYear.trim(), term.trim()]);

        const currentCount = countRow[0]?.count || 0;
        if (currentCount >= 2) {
            if (req.file && req.file.path) {
                try { require('fs').unlinkSync(req.file.path); } catch (_) {}
            }
            return res.redirect(`/parent/make-payment?studentId=${studentId}&academicYear=${encodeURIComponent(academicYear)}&term=${encodeURIComponent(term)}&error=` + encodeURIComponent(`Payment limit reached: You have already submitted the maximum allowed 2 payments for ${term} (${academicYear}) for this student.`));
        }

        // 4. Validate Amount Against Fixed Class Bill Installment Rules:
        // Parent can pay twice or once in a term: full once or half twice.
        const halfAmount = Math.round((totalClassBill / 2) * 100) / 100;
        if (currentCount === 0) {
            // First payment of term: can pay either FULL (100%) OR HALF (50%)
            const isFull = Math.abs(parsedAmount - totalClassBill) <= 1.0;
            const isHalf = Math.abs(parsedAmount - halfAmount) <= 1.0;
            if (!isFull && !isHalf) {
                return res.redirect(`/parent/make-payment?studentId=${studentId}&academicYear=${encodeURIComponent(academicYear)}&term=${encodeURIComponent(term)}&error=` + encodeURIComponent(`Invalid payment amount: Under school policy, you may either pay full once (₦${totalClassBill.toLocaleString()}) or half installment (₦${halfAmount.toLocaleString()}).`));
            }
        } else if (currentCount === 1) {
            // Second payment of term: must pay the remaining balance (the second half)
            const isRemainingHalf = Math.abs(parsedAmount - outstandingBalance) <= 1.0;
            if (!isRemainingHalf) {
                return res.redirect(`/parent/make-payment?studentId=${studentId}&academicYear=${encodeURIComponent(academicYear)}&term=${encodeURIComponent(term)}&error=` + encodeURIComponent(`Invalid payment amount: Your second and final installment must be the remaining balance of ₦${outstandingBalance.toLocaleString()}.`));
            }
        }

        const paymentNumber = currentCount + 1;
        const proofDocPath = req.file ? `/uploads/payments/${req.file.filename}` : null;
        const formattedDate = moment(paymentDate).format('YYYY-MM-DD');

        // Insert payment submission with status 'pending'
        const [insertResult] = await connection.execute(`
            INSERT INTO parent_payments (
                school_id, parent_id, student_id, academic_year, term,
                amount, payment_method, bank_name, transaction_reference,
                payment_date, proof_document, notes, status, payment_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `, [
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
        const sName = `${studentInfo.firstName} ${studentInfo.lastName}`;
        const pName = req.session.parentName || req.session.username || 'Parent';

        // Notify all admins for this school so they can review and approve the payment
        try {
            const [admins] = await connection.execute(`
                SELECT id FROM users
                WHERE role = 'admin' AND (school_id = ? OR ? IS NULL OR school_id IS NULL)
            `, [schoolId, schoolId]);

            const adminMessage = `${pName} submitted a fee payment of ₦${parsedAmount.toLocaleString()} (${currentCount === 0 && parsedAmount === totalClassBill ? 'Full' : 'Half'} payment) for ${sName} (${term}, ${academicYear}) awaiting review.`;

            if (admins.length > 0) {
                for (const admin of admins) {
                    await connection.execute(`
                        INSERT INTO admin_notifications (
                            admin_id, school_id, title, message, type, reference_id, is_read, created_at
                        ) VALUES (?, ?, 'New Fee Payment Submitted', ?, 'parent_payment', ?, 0, NOW())
                    `, [admin.id, schoolId, adminMessage, newPaymentId]);
                }
            } else {
                console.warn('No admin users found for this school; payment notification skipped.');
            }
        } catch (notifErr) {
            console.warn('Failed to insert admin notification:', notifErr.message);
        }

        res.redirect(`/parent/make-payment?studentId=${studentId}&academicYear=${encodeURIComponent(academicYear)}&term=${encodeURIComponent(term)}&success=1`);
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
        const [pCount] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM parent_payments 
            WHERE student_id = ? AND academic_year = ? AND term = ? AND status IN ('pending', 'approved')
        `, [studentId, academicYear, term]);

        const count = pCount[0]?.count || 0;
        const remaining = Math.max(0, 2 - count);

        // Fetch student classId
        const [sRows] = await connection.execute('SELECT classId FROM students WHERE id = ?', [studentId]);
        const classId = sRows[0]?.classId;

        let classBills = [];
        let totalClassBill = 0;
        if (classId) {
            const [bills] = await connection.execute(`
                SELECT fee_type, amount, description FROM class_bills 
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
                ORDER BY fee_type
            `, [classId, academicYear, term]);
            classBills = bills;
            totalClassBill = classBills.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
        }

        // Previous paid from fees (only approved)
        const [feeStats] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as billAmount
            FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ? AND status IN ('paid', 'partial')
        `, [studentId, academicYear, term]);
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
