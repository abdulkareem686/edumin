const express = require('express');
const router = express.Router();
const moment = require('moment');
const { getConnection, releaseConnection } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { getGrade, getGradeColor, getGradeClass, getGradeRemark, getPosition, getGradePoint } = require('../utils/grading');
const { studentDisplayName } = require('../utils/helpers');

// Helper to redirect /student-profile to current user's profile
router.get('/student-profile', authenticate, (req, res) => {
    if (req.session.role === 'student' && req.session.userId) {
        return res.redirect('/student-profile/' + req.session.userId);
    }
    res.redirect('/');
});

router.get('/student-dashboard', authenticate, async (req, res) => {
    if (req.session.role !== 'student') {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: { status: 403, message: 'You do not have permission to access this page.' }
        });
    }

    try {
        const connection = await getConnection();
        const studentId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Student';
        const welcomeMessage = req.session.welcomeMessage || null;
        delete req.session.welcomeMessage;

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        // Get term dates for attendance calculation
        const [termDetails] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_terms 
            WHERE term_name = ? AND academic_year_id = (
                SELECT id FROM academic_years WHERE year_name = ? AND school_id = ?
            )
        `, [
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            schoolId
        ]);

        // Get student data with class name
        const [students] = await connection.execute(
            `SELECT s.*, c.className 
             FROM students s 
             LEFT JOIN classes c ON s.classId = c.id 
             WHERE s.id = ? AND s.school_id = ?`,
            [studentId, schoolId]
        );

        if (students.length === 0) {
            return res.redirect('/login');
        }

        const studentData = students[0];

        // Extract className from studentData
        const className = studentData.className || 'Not Assigned';

        // Get unread notifications count, total count, and notifications list
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            // Check if student_notifications table exists
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'student_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count 
                    FROM student_notifications 
                    WHERE student_id = ? AND is_read = 0
                `, [studentId]);
                unreadCount = unreadResult[0]?.count || 0;

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM student_notifications 
                    WHERE student_id = ?
                `, [studentId]);
                totalCount = totalResult[0]?.total || 0;

                // Get notifications list for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date,
                           title
                    FROM student_notifications 
                    WHERE student_id = ?
                    ORDER BY created_at DESC 
                    LIMIT 10
                `, [studentId]);
                notifications = notificationList;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get student's recent results
        const [results] = await connection.execute(`
            SELECT ss.*, sub.name as subject_name 
            FROM student_scores ss 
            JOIN subjects sub ON ss.subject_id = sub.id 
            WHERE ss.student_id = ? AND ss.academic_year = ? AND ss.term = ?
            ORDER BY ss.created_at DESC LIMIT 5
        `, [
            studentId,
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
        ]);

        // Get attendance percentage
        let attendancePercentage = 0;
        let presentDays = 0;
        let totalDays = 0;

        if (termDetails.length > 0) {
            const [attendance] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? AND date BETWEEN ? AND ? AND school_id = ?
            `, [studentId, termDetails[0].start_date, termDetails[0].end_date, schoolId]);

            if (attendance.length > 0) {
                presentDays = attendance[0].present_days || 0;
                totalDays = attendance[0].total_days || 0;
                attendancePercentage = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
            }
        }

        // Calculate average score
        let averageScore = 0;
        if (results.length > 0) {
            const totalScore = results.reduce((sum, result) => {
                return sum + (parseFloat(result.test_score) || 0) + (parseFloat(result.exam_score) || 0);
            }, 0);
            averageScore = Math.round(totalScore / results.length);
        }

        // Get fee status
        let feeStatus = 'Pending';
        try {
            const [fees] = await connection.execute(`
                SELECT status FROM fees 
                WHERE studentId = ? AND academicYear = ? AND term = ?
                ORDER BY created_at DESC LIMIT 1
            `, [
                studentId,
                currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
                currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
            ]);
            feeStatus = fees.length > 0 ? fees[0].status : 'Pending';
            // Capitalize first letter
            feeStatus = feeStatus.charAt(0).toUpperCase() + feeStatus.slice(1);
        } catch (err) {
            feeStatus = 'Pending';
        }

        // Get upcoming events
        let upcomingEvents = [];
        try {
            const [events] = await connection.execute(`
                SELECT * FROM calendar_events 
                WHERE eventDate >= CURDATE() 
                ORDER BY eventDate ASC 
                LIMIT 5
            `);
            upcomingEvents = events;
        } catch (err) {
            upcomingEvents = [];
        }

        // Render the dashboard with all data
        res.render('student-dashboard', {
            // Student data
            studentData: studentData,
            className: className,
            admissionNumber: studentData.admission_number || 'N/A',

            // Academic data
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            recentResults: results,
            averageScore: averageScore,

            // Attendance data
            attendancePercentage: attendancePercentage,
            presentDays: presentDays,
            totalDays: totalDays,

            // Fee data
            feeStatus: feeStatus,

            // Events and notifications
            upcomingEvents: upcomingEvents,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            welcomeMessage: welcomeMessage,

            // Helper functions
            moment: require('moment'),
            calculateGrade: getGrade,
            getGradeColor: getGradeColor,
            studentDisplayName: studentDisplayName,

            // Page info
            title: 'Student Dashboard',
            currentPage: 'student-dashboard',
            role: req.session.role,
            username: username,
            userId: req.session.userId
        });

    } catch (error) {
        console.error('Error loading student dashboard:', error);

        // Render error page with default values
        res.render('student-dashboard', {
            error: 'Failed to load dashboard data. Please try again later.',
            studentData: {
                id: req.session.userId,
                firstName: 'Student',
                lastName: '',
                className: 'Not Available'
            },
            className: 'Not Available',
            admissionNumber: 'N/A',
            currentAcademicYear: '2023-2024',
            currentTerm: 'First Term',
            recentResults: [],
            averageScore: 0,
            attendancePercentage: 0,
            presentDays: 0,
            totalDays: 0,
            feeStatus: 'Pending',
            upcomingEvents: [],
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            calculateGrade: getGrade,
            getGradeColor: getGradeColor,
            studentDisplayName: studentDisplayName,
            title: 'Student Dashboard',
            currentPage: 'student-dashboard',
            role: req.session.role,
            username: req.session.username || 'Student',
            userId: req.session.userId
        });
    }
});

router.get('/student-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const studentId = req.params.id;
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';
        const userRole = req.session.role;

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        try {
            // Check if admin_notifications table exists
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                // Get unread count for badge
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                // Get total count for notification dropdown
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                notificationTotal = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date,
                           title
                    FROM admin_notifications 
                    WHERE admin_id = ?
                    ORDER BY created_at DESC 
                    LIMIT 10
                `, [adminId]);
                notifications = notificationList;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
            unreadCount = 0;
            notificationTotal = 0;
            notifications = [];
        }

        // 1. Get student info with class name and department
        const [students] = await connection.execute(`
            SELECT s.*, c.className, c.department AS classDepartment
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.id = ? AND s.school_id = ?`,
            [studentId, schoolId]
        );

        if (students.length === 0) {
            return res.status(404).render('error', {
                message: 'Student not found',
                error: { status: 404 }
            });
        }

        const student = students[0];

        // 2. Get enrolled subjects
        const [enrolledSubjects] = await connection.execute(`
            SELECT s.id, s.name AS subjectName, s.subject_code AS subjectCode
            FROM student_subjects ss
            JOIN subjects s ON ss.subject_id = s.id
            WHERE ss.student_id = ?
            ORDER BY s.name`,
            [studentId]
        );

        // 3. Get available subjects (not enrolled)
        const [availableSubjects] = await connection.execute(`
            SELECT s.id, s.name AS subjectName, s.subject_code AS subjectCode
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
            AND s.id NOT IN (
                SELECT subject_id
                FROM student_subjects 
                WHERE student_id = ?
            )
            ORDER BY s.name`,
            [student.classId, studentId]
        );

        // 4. Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        // 5. Get available academic years for report card selection
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        res.render('student-profile', {
            studentData: student,
            student: student,
            enrolledSubjects,
            availableSubjects,
            academicYears,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : '',
            terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            userRole: userRole,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading student profile:', error);
        res.status(500).render('error', {
            message: 'Error loading student profile',
            error: { status: 500, details: error.message },
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: []
        });
    }
});


module.exports = router;
