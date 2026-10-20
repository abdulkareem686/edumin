const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const argon2 = require('argon2');
const striptags = require('striptags');
const { getConnection, releaseConnection, withConnection, dbPool, tableHasColumn, tableExists } = require('../config/db');
const { authenticate, requireRole, requireAdmin } = require('../middleware/auth');
const { uploadWithFile, uploadNoFile, uploadLessonNote } = require('../middleware/upload');
const { studentDisplayName, SQL_STUDENT_FULLNAME, showAlertAndBack, nigerianStates, getCurrentTermAndWeek, calculateSchoolWeek } = require('../utils/helpers');
const { getGrade, getGradeColor, getGradeClass, getGradeRemark, getPosition, getGradePoint, getPerformanceRemark } = require('../utils/grading');
const { parsePage, searchLike, getCachedSchoolInfo, getCachedCurrentYearTerm } = require('../utils/scale');

// Password comparison helper
async function comparePassword(inputPassword, storedPassword) {
    return await argon2.verify(storedPassword, inputPassword);
}

// Helpers
function getDayName(dayIndex) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayIndex] || 'Unknown';
}

async function loadClassesForLevel(connection, schoolId, level) {
    const [rows] = await connection.execute(
        'SELECT id, className, department FROM classes WHERE school_id = ? AND level = ? ORDER BY className',
        [schoolId, level]
    );
    return rows;
}

function stripHtml(html) {
    if (!html) return '';
    return striptags(html).trim();
}

async function ensureStudentCommentsTable(connection) {
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS student_comments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id INT NOT NULL,
            class_id INT NULL,
            term VARCHAR(50) NOT NULL,
            academic_year VARCHAR(50) NOT NULL,
            comment TEXT NOT NULL,
            comment_by VARCHAR(255) NULL,
            comment_by_user_id INT NULL,
            comment_type VARCHAR(50) NOT NULL DEFAULT 'teacher',
            comment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_student_term_year_type (student_id, term, academic_year, comment_type),
            INDEX idx_student_class (student_id, class_id)
        )
    `);

    if (!(await tableHasColumn(connection, 'student_comments', 'class_id'))) {
        try {
            await connection.execute('ALTER TABLE student_comments ADD COLUMN class_id INT NULL AFTER student_id');
        } catch (_) { /* column may already exist under race */ }
    }
    if (!(await tableHasColumn(connection, 'student_comments', 'comment_type'))) {
        try {
            await connection.execute(`ALTER TABLE student_comments ADD COLUMN comment_type VARCHAR(50) NOT NULL DEFAULT 'teacher' AFTER comment_by_user_id`);
        } catch (_) { /* ignore */ }
    }
    if (!(await tableHasColumn(connection, 'student_comments', 'updated_at'))) {
        try {
            await connection.execute(`ALTER TABLE student_comments ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
        } catch (_) { /* ignore */ }
    }
}

async function upsertStudentComment(connection, {
    studentId,
    classId,
    term,
    academicYear,
    comment,
    commentBy,
    commentByUserId,
    commentType
}) {
    const commentsHaveClassId = await tableHasColumn(connection, 'student_comments', 'class_id');
    const trimmed = (comment || '').trim();

    let existing;
    if (commentsHaveClassId && classId) {
        [existing] = await connection.execute(`
            SELECT id FROM student_comments
            WHERE student_id = ? AND term = ? AND academic_year = ? AND comment_type = ?
              AND (class_id = ? OR class_id IS NULL)
            ORDER BY CASE WHEN class_id = ? THEN 0 ELSE 1 END, comment_date DESC
            LIMIT 1
        `, [studentId, term, academicYear, commentType, classId, classId]);
    } else {
        [existing] = await connection.execute(`
            SELECT id FROM student_comments
            WHERE student_id = ? AND term = ? AND academic_year = ? AND comment_type = ?
            ORDER BY comment_date DESC
            LIMIT 1
        `, [studentId, term, academicYear, commentType]);
    }

    if (!trimmed) {
        if (existing.length > 0) {
            await connection.execute('DELETE FROM student_comments WHERE id = ?', [existing[0].id]);
        }
        return { cleared: true };
    }

    if (existing.length > 0) {
        if (commentsHaveClassId && classId) {
            await connection.execute(`
                UPDATE student_comments
                SET comment = ?, comment_by = ?, comment_by_user_id = ?, class_id = COALESCE(class_id, ?),
                    comment_date = NOW(), updated_at = NOW()
                WHERE id = ?
            `, [trimmed, commentBy, commentByUserId, classId, existing[0].id]);
        } else {
            await connection.execute(`
                UPDATE student_comments
                SET comment = ?, comment_by = ?, comment_by_user_id = ?,
                    comment_date = NOW(), updated_at = NOW()
                WHERE id = ?
            `, [trimmed, commentBy, commentByUserId, existing[0].id]);
        }
        return { updated: true };
    }

    if (commentsHaveClassId) {
        await connection.execute(`
            INSERT INTO student_comments
            (student_id, class_id, term, academic_year, comment, comment_by, comment_by_user_id, comment_type, comment_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [studentId, classId || null, term, academicYear, trimmed, commentBy, commentByUserId, commentType]);
    } else {
        await connection.execute(`
            INSERT INTO student_comments
            (student_id, term, academic_year, comment, comment_by, comment_by_user_id, comment_type, comment_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [studentId, term, academicYear, trimmed, commentBy, commentByUserId, commentType]);
    }
    return { inserted: true };
}

async function getReportCardComment(connection, studentId, term, academicYear, commentType, classId = null) {
    const commentsHaveClassId = await tableHasColumn(connection, 'student_comments', 'class_id');
    let rows;

    if (commentsHaveClassId && classId) {
        [rows] = await connection.execute(`
            SELECT comment, comment_by, comment_date
            FROM student_comments
            WHERE student_id = ? AND term = ? AND academic_year = ? AND comment_type = ?
              AND (class_id = ? OR class_id IS NULL)
            ORDER BY CASE WHEN class_id = ? THEN 0 ELSE 1 END, comment_date DESC
            LIMIT 1
        `, [studentId, term, academicYear, commentType, classId, classId]);
    } else {
        [rows] = await connection.execute(`
            SELECT comment, comment_by, comment_date
            FROM student_comments
            WHERE student_id = ? AND term = ? AND academic_year = ? AND comment_type = ?
            ORDER BY comment_date DESC
            LIMIT 1
        `, [studentId, term, academicYear, commentType]);
    }

    return rows.length > 0 ? rows[0] : null;
}

// GET route - Admin Dashboard
router.get('/', authenticate, async (req, res) => {
    try {
        // Redirect based on role
        if (req.session.role === 'student') {
            return res.redirect('/student-dashboard');
        } else if (req.session.role === 'teacher') {
            return res.redirect('/teacher-dashboard');
        } else if (req.session.role === 'parent') {
            return res.redirect('/parent/parent-dashboard');
        } else if (req.session.role !== 'admin') {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: { status: 403, message: 'You do not have permission to access this page.' }
            });
        }

        // Admin dashboard (existing code)
        const connection = await getConnection();

        // Get current academic year and term (scoped per school when supported)
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        const [currentAcademicYear] = academicYearsHaveSchoolId
            ? await connection.execute(
                `SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1`,
                [schoolId]
            )
            : await connection.execute(`SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1`);

        const [currentTerm] = academicTermsHaveSchoolId
            ? await connection.execute(
                `SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1`,
                [schoolId]
            )
            : await connection.execute(`SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1`);

        // Get counts from database (graduated students excluded from active student count)
        const [studentRows] = await connection.execute(
            "SELECT COUNT(*) as count FROM students WHERE school_id = ? AND (status IS NULL OR status != 'graduated')", 
            [schoolId]
        );
        const [graduatedRows] = await connection.execute(
            "SELECT COUNT(*) as count FROM students WHERE school_id = ? AND status = 'graduated'", 
            [schoolId]
        );
        const [teacherRows] = await connection.execute('SELECT COUNT(*) as count FROM teachers WHERE school_id = ?', [schoolId]);
        const [classRows] = await connection.execute('SELECT COUNT(*) as count FROM classes WHERE school_id = ?', [schoolId]);

        // Get fee collection data for current term (only approved payments; declined payments strictly excluded)
        const [feeRows] = await connection.execute(`
            SELECT COALESCE(SUM(amountPaid), 0) as total 
            FROM fees 
            WHERE academicYear = ? AND term = ? AND school_id = ? AND status IN ('paid', 'partial')
        `, [
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            schoolId
        ]);

        // Get recent activities
        const [activities] = await connection.execute(`
            SELECT * FROM activities 
            WHERE school_id = ?
            ORDER BY created_at DESC 
            LIMIT 5
        `, [schoolId]);

        // Get upcoming events
        const [events] = await connection.execute(`
            SELECT * FROM calendar_events 
            WHERE eventDate >= CURDATE() AND school_id = ?
            ORDER BY eventDate ASC 
            LIMIT 5
        `, [schoolId]);

        // Calculate term progress based on actual dates
        let termProgress = 0;
        let daysRemaining = 0;

        if (currentTerm.length > 0) {
            const [termDetails] = academicTermsHaveSchoolId && academicYearsHaveSchoolId
                ? await connection.execute(
                    `SELECT start_date, end_date
                     FROM academic_terms
                     WHERE term_name = ?
                       AND school_id = ?
                       AND academic_year_id = (
                           SELECT id FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
                       )`,
                    [currentTerm[0].term_name, schoolId, schoolId]
                )
                : await connection.execute(
                    `SELECT start_date, end_date 
                     FROM academic_terms 
                     WHERE term_name = ? AND academic_year_id = (
                         SELECT id FROM academic_years WHERE is_current = TRUE LIMIT 1
                     )`,
                    [currentTerm[0].term_name]
                );

            if (termDetails.length > 0) {
                const startDate = new Date(termDetails[0].start_date);
                const endDate = new Date(termDetails[0].end_date);
                const today = new Date();

                const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
                const daysPassed = Math.ceil((today - startDate) / (1000 * 60 * 60 * 24));

                termProgress = Math.min(100, Math.max(0, Math.round((daysPassed / totalDays) * 100)));
                daysRemaining = Math.max(0, totalDays - daysPassed);
            }
        }

        // Get exam statistics
        const studentScoresHaveSchoolId = await tableHasColumn(connection, 'student_scores', 'school_id');
        const [examStats] = studentScoresHaveSchoolId
            ? await connection.execute(
                `SELECT COUNT(DISTINCT subject_id) as exams_conducted
                 FROM student_scores 
                 WHERE academic_year = ? AND term = ? AND school_id = ?`,
                [
                    currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
                    currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
                    schoolId
                ]
            )
            : await connection.execute(
                `SELECT COUNT(DISTINCT subject_id) as exams_conducted
                 FROM student_scores 
                 WHERE academic_year = ? AND term = ?`,
                [
                    currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024',
                    currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term'
                ]
            );

        // Get assignment statistics
        const assignmentsSubmitted = 156; // Placeholder

        // Get class schedule statistics
        const calendarEventsHaveSchoolId = await tableHasColumn(connection, 'calendar_events', 'school_id');
        const [classStats] = calendarEventsHaveSchoolId
            ? await connection.execute(
                `SELECT COUNT(*) as classes_scheduled
                 FROM calendar_events 
                 WHERE eventDate >= CURDATE() 
                   AND eventDate <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
                   AND school_id = ?
                   AND (title LIKE '%class%' OR description LIKE '%class%')`,
                [schoolId]
            )
            : await connection.execute(
                `SELECT COUNT(*) as classes_scheduled
                 FROM calendar_events 
                 WHERE eventDate >= CURDATE() 
                   AND eventDate <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
                   AND (title LIKE '%class%' OR description LIKE '%class%')`
            );

        // Get assignments due
        const assignmentsDue = 8; // Placeholder

        // Get attendance statistics
        const [attendanceStats] = await connection.execute(`
            SELECT 
                (COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) * 100.0 / 
                 COUNT(*)) as avg_attendance
            FROM attendance_records
            WHERE date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND school_id = ?
        `, [schoolId]);

        // Get admin notifications for topbar
        let unreadCount = 0;
        let totalCount = 0;
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
                totalCount = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown (last 10)
                const [notificationList] = await connection.execute(`
                    SELECT id, title, message, is_read, type, created_at,
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
            totalCount = 0;
            notifications = [];
        }

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
            termProgress: termProgress || 0,
            daysRemaining: daysRemaining || 0,
            daysPassed: 0,
            totalDays: 0,
            weekStartDate: '',
            weekEndDate: ''
        };

        try {
            const calculatedTermWeek = await getCurrentTermAndWeek(connection, schoolId);
            if (calculatedTermWeek) {
                schoolWeek = { ...schoolWeek, ...calculatedTermWeek };
                if (calculatedTermWeek.termProgress != null) termProgress = calculatedTermWeek.termProgress;
                if (calculatedTermWeek.daysRemaining != null) daysRemaining = calculatedTermWeek.daysRemaining;
            }
        } catch (weekErr) {
            console.error('Error calculating school week for admin dashboard:', weekErr.message);
        }

        const dashboardData = {
            username: req.session.username,
            role: req.session.role,
            studentCount: studentRows[0].count,
            graduatedStudentCount: graduatedRows[0]?.count || 0,
            teacherCount: teacherRows[0].count,
            classCount: classRows[0].count,
            revenue: feeRows[0].total || 0,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : schoolWeek.academicYear,
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : schoolWeek.currentTerm,
            recentActivities: activities,
            upcomingEvents: events,
            termProgress: termProgress,
            daysRemaining: daysRemaining,
            schoolWeek: schoolWeek,
            currentWeek: schoolWeek.currentWeek,
            totalWeeks: schoolWeek.totalWeeks,
            weekLabel: schoolWeek.weekLabel,
            shortWeekLabel: schoolWeek.shortWeekLabel,
            termWeekStatus: schoolWeek.status,
            termWeekStatusBadge: schoolWeek.statusBadge,
            weekStartDate: schoolWeek.weekStartDate,
            weekEndDate: schoolWeek.weekEndDate,
            termStartDate: schoolWeek.termStartDate,
            termEndDate: schoolWeek.termEndDate,
            daysPassed: schoolWeek.daysPassed,
            totalDays: schoolWeek.totalDays,
            examsConducted: examStats[0]?.exams_conducted || 0,
            assignmentsSubmitted: assignmentsSubmitted,
            classesScheduled: classStats[0]?.classes_scheduled || 0,
            assignmentsDue: assignmentsDue,
            averageAttendance: attendanceStats[0]?.avg_attendance || 92,
            feesCollected: feeRows[0].total || 0,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            welcomeMessage: null,
            moment: require('moment')
        };

        res.render('index', dashboardData);

    } catch (error) {
        console.error('Error loading dashboard:', error);

        // Get fallback notifications data
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        res.render('index', {
            username: req.session.username,
            role: req.session.role,
            studentCount: 0,
            teacherCount: 0,
            classCount: 0,
            revenue: 0,
            currentAcademicYear: '2026/2027',
            currentTerm: 'First Term',
            recentActivities: [],
            upcomingEvents: [],
            termProgress: 0,
            daysRemaining: 0,
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
            termWeekStatus: 'active',
            termWeekStatusBadge: 'In Session',
            weekStartDate: '',
            weekEndDate: '',
            termStartDate: null,
            termEndDate: null,
            daysPassed: 0,
            totalDays: 0,
            examsConducted: 0,
            assignmentsSubmitted: 0,
            classesScheduled: 0,
            assignmentsDue: 0,
            averageAttendance: 0,
            feesCollected: 0,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            welcomeMessage: null,
            moment: require('moment'),
            error: 'Failed to load dashboard data.'
        });
    }
});
// ==================== PARENT MANAGEMENT ROUTES (Admin Only) ====================
// GET route - List all parents
router.get('/all-parents', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        const { page, limit, offset, q } = parsePage(req);
        let parentWhere = 'WHERE p.school_id = ?';
        const parentParams = [schoolId];
        if (q) {
            parentWhere += ' AND (p.first_name LIKE ? OR p.last_name LIKE ? OR p.email LIKE ? OR p.phone LIKE ?)';
            const like = searchLike(q);
            parentParams.push(like, like, like, like);
        }
        const [parentCountRows] = await connection.execute(
            `SELECT COUNT(*) as total FROM parents p ${parentWhere}`,
            parentParams
        );
        const listTotal = parentCountRows[0]?.total || 0;
        const totalPages = Math.max(1, Math.ceil(listTotal / limit));

        const [parents] = await connection.query(`
            SELECT p.*, 
                   GROUP_CONCAT(${SQL_STUDENT_FULLNAME} SEPARATOR ', ') as children_names,
                   COUNT(ps.student_id) as children_count
            FROM parents p
            LEFT JOIN parent_students ps ON p.id = ps.parent_id
            LEFT JOIN students s ON ps.student_id = s.id
            ${parentWhere}
            GROUP BY p.id
            ORDER BY p.first_name, p.last_name
            LIMIT ${limit} OFFSET ${offset}
        `, parentParams);

        res.render('all-parents', {
            parents: parents,
            error: null,
            success: req.session.success || null,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            pagerPage: page,
            totalPages,
            totalRecords: listTotal,
            extraQuery: q ? `&q=${encodeURIComponent(q)}` : '',
            searchQ: q
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error fetching parents:', error);
        res.render('all-parents', {
            parents: [],
            error: 'Failed to load parents list',
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            pagerPage: 1,
            totalPages: 1,
            totalRecords: 0,
            extraQuery: '',
            searchQ: ''
        });
    }
});
// GET route - Add parent form
router.get('/add-parent', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        res.render('add-parent', {
            students: [],
            formData: {},
            error: null,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading add parent form:', error);

        res.render('add-parent', {
            students: [],
            formData: {},
            error: 'Failed to load form data: ' + error.message,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// POST route - Add new parent
router.post('/add-parent', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const {
        firstName,
        lastName,
        email,
        phone,
        address,
        relationship,
        occupation,
        emergencyContact,
        studentIds,
        password
    } = req.body;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        // Get notifications for error rendering
        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                notificationTotal = totalResult[0]?.total || 0;

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

        // Validate required fields
        if (!firstName || !lastName || !email || !phone || !password) {
            return res.render('add-parent', {
                students: [],
                formData: req.body,
                error: 'First Name, Last Name, Email, Phone, and Password are required',
                username: username,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment')
            });
        }

        // Check if email already exists
        const [existingParents] = await connection.execute(
            'SELECT id FROM parents WHERE email = ?',
            [email]
        );

        if (existingParents.length > 0) {
            return res.render('add-parent', {
                students: [],
                formData: req.body,
                error: 'Email already exists',
                username: username,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment')
            });
        }

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Start transaction
        await connection.beginTransaction();

        try {
            // Insert parent
            const [parentResult] = await connection.execute(
                `INSERT INTO parents 
                (first_name, last_name, email, phone, address, relationship, occupation, emergency_contact, password, school_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    firstName,
                    lastName,
                    email,
                    phone,
                    address || null,
                    relationship || 'Parent',
                    occupation || null,
                    emergencyContact || null,
                    hashedPassword,
                    schoolId
                ]
            );

            const parentId = parentResult.insertId;

            // Link parent to students if any selected
            if (studentIds) {
                const studentIdsArray = Array.isArray(studentIds) ? studentIds : [studentIds];

                for (const studentId of studentIdsArray) {
                    await connection.execute(
                        `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary) 
                         VALUES (?, ?, ?, ?)`,
                        [parentId, studentId, relationship || 'Parent', 0]
                    );
                }
            }

            await connection.commit();

            req.session.success = `Parent ${firstName} ${lastName} added successfully`;
            res.redirect('/all-parents');

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error adding parent:', error);

        res.render('add-parent', {
            students: [],
            formData: req.body,
            error: 'Failed to add parent: ' + error.message,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// GET route - Edit parent
router.get('/edit-parent/:id', authenticate, requireRole('admin'), async (req, res) => {
    const parentId = req.params.id;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;

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

        // Get parent details
        const [parents] = await connection.execute(
            'SELECT * FROM parents WHERE id = ? AND school_id = ?',
            [parentId, schoolId]
        );

        if (parents.length === 0) {
            req.session.error = 'Parent not found';
            return res.redirect('/all-parents');
        }

        const parent = parents[0];
        
        // Get linked students
        const [linkedStudents] = await connection.execute(`
            SELECT ps.student_id, ps.relationship, ps.is_primary,
                   s.firstName, s.middleName, s.lastName, s.admission_number, s.classId
            FROM parent_students ps
            JOIN students s ON ps.student_id = s.id
            WHERE ps.parent_id = ?
        `, [parentId]);
        
        // Get all students for linking
        const [allStudents] = await connection.execute(`
            SELECT id, firstName, middleName, lastName, admission_number, classId
            FROM students 
            WHERE school_id = ?
            ORDER BY firstName, lastName
        `, [schoolId]);

        // Pass all required variables to the view
        res.render('edit-parent', { 
            parent: parent,
            linkedStudents: linkedStudents,
            allStudents: allStudents,
            error: null,
            success: req.session.success || null,
            username: req.session.username || 'Admin',
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
        
        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error fetching parent:', error);
        req.session.error = 'Error loading parent details';
        res.redirect('/all-parents');
    }
});

// POST route - Update parent
router.post('/edit-parent/:id', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const parentId = req.params.id;
    const {
        firstName,
        lastName,
        email,
        phone,
        address,
        relationship,
        occupation,
        emergencyContact,
        studentIds,
        status
    } = req.body;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        // Validate required fields
        if (!firstName || !lastName || !email || !phone) {
            const [parents] = await connection.execute(
                'SELECT * FROM parents WHERE id = ?',
                [parentId]
            );
            const [allStudents] = await connection.execute(`
                SELECT id, firstName, middleName, lastName, admission_number 
                FROM students WHERE school_id = ?
            `, [schoolId]);
            const [linkedStudents] = await connection.execute(`
                SELECT ps.student_id, s.firstName, s.middleName, s.lastName
                FROM parent_students ps
                JOIN students s ON ps.student_id = s.id
                WHERE ps.parent_id = ?
            `, [parentId]);
            
            return res.render('edit-parent', {
                parent: parents[0],
                linkedStudents: linkedStudents,
                allStudents: allStudents,
                error: 'First Name, Last Name, Email, and Phone are required'
            });
        }

        // Check if email already exists (excluding current parent)
        const [existingParents] = await connection.execute(
            'SELECT id FROM parents WHERE email = ? AND id != ?',
            [email, parentId]
        );

        if (existingParents.length > 0) {
            const [parents] = await connection.execute(
                'SELECT * FROM parents WHERE id = ?',
                [parentId]
            );
            const [allStudents] = await connection.execute(`
                SELECT id, firstName, middleName, lastName, admission_number 
                FROM students WHERE school_id = ?
            `, [schoolId]);
            const [linkedStudents] = await connection.execute(`
                SELECT ps.student_id, s.firstName, s.middleName, s.lastName
                FROM parent_students ps
                JOIN students s ON ps.student_id = s.id
                WHERE ps.parent_id = ?
            `, [parentId]);
            
            return res.render('edit-parent', {
                parent: parents[0],
                linkedStudents: linkedStudents,
                allStudents: allStudents,
                error: 'Email already exists'
            });
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            // Update parent
            await connection.execute(
                `UPDATE parents SET 
                    first_name = ?, last_name = ?, email = ?, phone = ?, 
                    address = ?, relationship = ?, occupation = ?, 
                    emergency_contact = ?, status = ?
                 WHERE id = ? AND school_id = ?`,
                [
                    firstName,
                    lastName,
                    email,
                    phone,
                    address || null,
                    relationship || 'Parent',
                    occupation || null,
                    emergencyContact || null,
                    status || 'active',
                    parentId,
                    schoolId
                ]
            );

            // Update student links - remove all existing links
            await connection.execute(
                'DELETE FROM parent_students WHERE parent_id = ?',
                [parentId]
            );

            // Add new links
            if (studentIds) {
                const studentIdsArray = Array.isArray(studentIds) ? studentIds : [studentIds];
                
                for (const studentId of studentIdsArray) {
                    await connection.execute(
                        `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary) 
                         VALUES (?, ?, ?, ?)`,
                        [parentId, studentId, relationship || 'Parent', 0]
                    );
                }
            }

            await connection.commit();

            req.session.success = `Parent ${firstName} ${lastName} updated successfully`;
            res.redirect('/all-parents');

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error updating parent:', error);
        req.session.error = 'Failed to update parent: ' + error.message;
        res.redirect('/all-parents');
    }
});

// GET route - Delete parent
router.get('/delete-parent/:id', authenticate, requireRole('admin'), async (req, res) => {
    const parentId = req.params.id;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // Check if parent exists
        const [parents] = await connection.execute(
            'SELECT first_name, last_name FROM parents WHERE id = ? AND school_id = ?',
            [parentId, schoolId]
        );
        
        if (parents.length === 0) {
            req.session.error = 'Parent not found';
            return res.redirect('/all-parents');
        }

        const parentName = `${parents[0].first_name} ${parents[0].last_name}`;

        // Delete parent (cascade will delete relationships)
        await connection.execute(
            'DELETE FROM parents WHERE id = ? AND school_id = ?',
            [parentId, schoolId]
        );

        req.session.success = `Parent ${parentName} deleted successfully`;
        res.redirect('/all-parents');

    } catch (error) {
        console.error('Error deleting parent:', error);
        req.session.error = 'Failed to delete parent: ' + error.message;
        res.redirect('/all-parents');
    }
});

// ==================== LINK STUDENT TO PARENT ROUTES ====================
// GET route - Link Student to Parent page
router.get('/link-student-parent', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        // Get all parents
        const [parents] = await connection.execute(`
            SELECT id, first_name, last_name, email, phone 
            FROM parents 
            WHERE school_id = ? AND status = 'active'
            ORDER BY first_name, last_name
        `, [schoolId]);

        // Get all students
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.school_id = ?
            ORDER BY s.firstName, s.lastName
        `, [schoolId]);

        // Get existing links with created_at
        const [existingLinks] = await connection.execute(`
            SELECT ps.parent_id, ps.student_id, ps.relationship, ps.is_primary, ps.created_at,
                   p.first_name as parent_first, p.last_name as parent_last,
                   s.firstName as student_first, s.middleName as student_middle, s.lastName as student_last,
                   s.admission_number
            FROM parent_students ps
            JOIN parents p ON ps.parent_id = p.id
            JOIN students s ON ps.student_id = s.id
            WHERE p.school_id = ?
            ORDER BY p.first_name, s.firstName
        `, [schoolId]);

        res.render('link-student-parent', {
            parents: parents,
            students: students,
            existingLinks: existingLinks,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            success: req.session.success || null,
            error: req.session.error || null,
            moment: require('moment')
        });

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading link student-parent page:', error);

        // Get fallback data for error rendering
        let parents = [];
        let students = [];
        let existingLinks = [];

        try {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            [parents] = await connection.execute(`
                SELECT id, first_name, last_name, email, phone 
                FROM parents 
                WHERE school_id = ? AND status = 'active'
                ORDER BY first_name, last_name
            `, [schoolId]);
            [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
                FROM students s
                LEFT JOIN classes c ON s.classId = c.id
                WHERE s.school_id = ?
                ORDER BY s.firstName, s.lastName
            `, [schoolId]);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('link-student-parent', {
            parents: parents,
            students: students,
            existingLinks: existingLinks,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            error: 'Failed to load data: ' + error.message,
            moment: require('moment')
        });
    }
});

// POST route - Link student to parent
router.post('/link-student-parent', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { parentId, studentId, relationship, isPrimary } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!parentId || !studentId) {
            req.session.error = 'Please select both a parent and a student';
            return res.redirect('/link-student-parent');
        }
        
        // Check if link already exists
        const [existingLink] = await connection.execute(
            'SELECT id FROM parent_students WHERE parent_id = ? AND student_id = ?',
            [parentId, studentId]
        );
        
        if (existingLink.length > 0) {
            req.session.error = 'This student is already linked to this parent';
            return res.redirect('/link-student-parent');
        }
        
        // If isPrimary is set to 1, remove primary status from other parents for this student
        if (isPrimary === '1') {
            await connection.execute(
                'UPDATE parent_students SET is_primary = 0 WHERE student_id = ?',
                [studentId]
            );
        }
        
        // Create the link
        await connection.execute(
            `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary) 
             VALUES (?, ?, ?, ?)`,
            [parentId, studentId, relationship || 'Parent', isPrimary === '1' ? 1 : 0]
        );
        
        // Get parent and student names for success message
        const [parent] = await connection.execute(
            'SELECT first_name, last_name FROM parents WHERE id = ?',
            [parentId]
        );
        const [student] = await connection.execute(
            'SELECT firstName, middleName, lastName FROM students WHERE id = ?',
            [studentId]
        );
        
        req.session.success = `${parent[0].first_name} ${parent[0].last_name} has been linked to ${studentDisplayName(student[0])} successfully!`;
        res.redirect('/link-student-parent');
        
    } catch (error) {
        console.error('Error linking student to parent:', error);
        req.session.error = 'Failed to link student to parent: ' + error.message;
        res.redirect('/link-student-parent');
    }
});

// POST route - Unlink student from parent (AJAX)
router.post('/unlink-student-parent', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { parentId, studentId } = req.body;
    
    try {
        const connection = await getConnection();
        
        await connection.execute(
            'DELETE FROM parent_students WHERE parent_id = ? AND student_id = ?',
            [parentId, studentId]
        );
        
        res.json({ success: true, message: 'Student unlinked successfully' });
        
    } catch (error) {
        console.error('Error unlinking student:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Get students not linked to a parent (for AJAX)
router.get('/api/unlinked-students/:parentId', authenticate, requireRole('admin'), async (req, res) => {
    const { parentId } = req.params;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number, c.className
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.school_id = ? 
            AND s.id NOT IN (
                SELECT student_id FROM parent_students WHERE parent_id = ?
            )
            ORDER BY s.firstName, s.lastName
        `, [schoolId, parentId]);
        
        res.json({ success: true, students: students });
        
    } catch (error) {
        console.error('Error fetching unlinked students:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Reset parent password
router.get('/reset-parent-password/:id', authenticate, requireRole('admin'), async (req, res) => {
    const parentId = req.params.id;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // Generate a random temporary password
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await argon2.hash(tempPassword);
        
        await connection.execute(
            'UPDATE parents SET password = ? WHERE id = ? AND school_id = ?',
            [hashedPassword, parentId, schoolId]
        );
        
        // Get parent email
        const [parents] = await connection.execute(
            'SELECT email, first_name, last_name FROM parents WHERE id = ?',
            [parentId]
        );
        
        req.session.success = `Password reset successfully. Temporary password: ${tempPassword} (Sent to ${parents[0].email})`;
        res.redirect('/all-parents');

    } catch (error) {
        console.error('Error resetting parent password:', error);
        req.session.error = 'Failed to reset password';
        res.redirect('/all-parents');
    }
});

// API endpoint to search parents by name, email, or phone
router.get('/api/search-parents', authenticate, async (req, res) => {
    const { search } = req.query;
    
    try {
        if (!search || search.length < 2) {
            return res.json({ success: true, results: [] });
        }
        
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        const [parents] = await connection.execute(`
            SELECT id, first_name, last_name, email, phone 
            FROM parents 
            WHERE school_id = ? 
            AND (
                first_name LIKE ? OR 
                last_name LIKE ? OR 
                email LIKE ? OR 
                phone LIKE ?
            )
            AND status = 'active'
            LIMIT 20
        `, [
            schoolId,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`
        ]);
        
        res.json({ success: true, results: parents });
        
    } catch (error) {
        console.error('Error searching parents:', error);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

// API endpoint to search students by name or admission number
router.get('/api/search-students', authenticate, async (req, res) => {
    const { search } = req.query;
    
    try {
        if (!search || search.length < 2) {
            return res.json({ success: true, results: [] });
        }
        
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number, c.className 
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.school_id = ? 
            AND (
                s.firstName LIKE ? OR 
                s.middleName LIKE ? OR 
                s.lastName LIKE ? OR 
                s.admission_number LIKE ?
            )
            LIMIT 20
        `, [
            schoolId,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`
        ]);
        
        res.json({ success: true, results: students });
        
    } catch (error) {
        console.error('Error searching students:', error);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});


// ==================== SEND NOTIFICATION ROUTES ====================

// GET route - Send Notification Form
router.get('/send-notification', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const { type, id } = req.query;

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

        let recipientName = '';
        let recipientEmail = '';

        // Get recipient details if ID is provided
        if (type && id) {
            if (type === 'teacher') {
                const [teachers] = await connection.execute(`
                    SELECT firstName, lastName, email FROM teachers WHERE id = ? AND school_id = ?
                `, [id, schoolId]);
                if (teachers.length > 0) {
                    recipientName = `${teachers[0].firstName} ${teachers[0].lastName}`;
                    recipientEmail = teachers[0].email;
                }
            } else if (type === 'parent') {
                const [parents] = await connection.execute(`
                    SELECT first_name, last_name, email FROM parents WHERE id = ? AND school_id = ?
                `, [id, schoolId]);
                if (parents.length > 0) {
                    recipientName = `${parents[0].first_name} ${parents[0].last_name}`;
                    recipientEmail = parents[0].email;
                }
            }
        }

        // Get all teachers for dropdown
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email FROM teachers WHERE school_id = ? ORDER BY firstName, lastName
        `, [schoolId]);

        // Get all parents for dropdown
        const [parents] = await connection.execute(`
            SELECT id, first_name, last_name, email FROM parents WHERE school_id = ? AND status = 'active' ORDER BY first_name, last_name
        `, [schoolId]);

        // Get all students for dropdown (to notify their parents)
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.lastName, s.admission_number, c.className
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.school_id = ?
            ORDER BY s.firstName, s.lastName
        `, [schoolId]);

        res.render('send-notification', {
            teachers: teachers,
            parents: parents,
            students: students,
            recipientType: type,
            recipientId: id,
            recipientName: recipientName,
            recipientEmail: recipientEmail,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Send Notification',
            currentPage: 'send-notification'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading send notification page:', error);
        res.render('send-notification', {
            teachers: [],
            parents: [],
            students: [],
            recipientType: null,
            recipientId: null,
            recipientName: '',
            recipientEmail: '',
            username: 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            success: null,
            error: 'Failed to load page: ' + error.message,
            title: 'Send Notification',
            currentPage: 'send-notification'
        });
    }
});

// POST route - Send Notification (Simplified - without school_id)
router.post('/send-notification', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();

        const { subject, message, notificationType, teacherIds, parentIds } = req.body;

        console.log('Received notification request:', { subject, message, notificationType, teacherIds, parentIds });

        // Validate inputs
        if (!subject || !message) {
            return res.json({ success: false, error: 'Please provide both subject and message' });
        }

        // Collect all recipient IDs
        let teacherRecipients = [];
        let parentRecipients = [];

        // Process teacher IDs
        if (teacherIds) {
            if (Array.isArray(teacherIds)) {
                teacherRecipients = teacherIds;
            } else {
                teacherRecipients = [teacherIds];
            }
        }

        // Process parent IDs
        if (parentIds) {
            if (Array.isArray(parentIds)) {
                parentRecipients = parentIds;
            } else {
                parentRecipients = [parentIds];
            }
        }

        if (teacherRecipients.length === 0 && parentRecipients.length === 0) {
            return res.json({ success: false, error: 'Please select at least one recipient' });
        }

        let sentCount = 0;
        let errorCount = 0;

        // Send notifications to teachers
        for (const teacherId of teacherRecipients) {
            try {
                await connection.execute(`
                    INSERT INTO teacher_notifications 
                    (teacher_id, title, message, type, created_at, is_read)
                    VALUES (?, ?, ?, ?, NOW(), 0)
                `, [teacherId, subject, message, notificationType || 'info']);
                sentCount++;
                console.log(`Notification sent to teacher ${teacherId}`);
            } catch (err) {
                console.error(`Error sending to teacher ${teacherId}:`, err.message);
                errorCount++;
            }
        }

        // Send notifications to parents
        for (const parentId of parentRecipients) {
            try {
                await connection.execute(`
                    INSERT INTO parent_notifications 
                    (parent_id, title, message, type, created_at, is_read)
                    VALUES (?, ?, ?, ?, NOW(), 0)
                `, [parentId, subject, message, notificationType || 'info']);
                sentCount++;
                console.log(`Notification sent to parent ${parentId}`);
            } catch (err) {
                console.error(`Error sending to parent ${parentId}:`, err.message);
                errorCount++;
            }
        }

        if (sentCount > 0) {
            const successMessage = `Notification sent to ${sentCount} recipient(s) successfully!`;
            if (errorCount > 0) {
                return res.json({ success: true, message: successMessage + ` (${errorCount} failed)` });
            }
            return res.json({ success: true, message: successMessage });
        } else {
            return res.json({ success: false, error: 'Failed to send notifications. Please check database connection.' });
        }

    } catch (error) {
        console.error('Error sending notification:', error);
        return res.json({ success: false, error: 'Failed to send notification: ' + error.message });
    }
});

// API route - Get teachers for quick selection
router.get('/api/teachers/list', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation 
            FROM teachers 
            WHERE school_id = ? 
            ORDER BY firstName, lastName
        `, [schoolId]);

        res.json({ success: true, teachers: teachers });

    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API route - Get parents for quick selection
router.get('/api/parents/list', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        const [parents] = await connection.execute(`
            SELECT id, first_name, lastName, email 
            FROM parents 
            WHERE school_id = ? AND status = 'active'
            ORDER BY first_name, last_name
        `, [schoolId]);

        res.json({ success: true, parents: parents });

    } catch (error) {
        console.error('Error fetching parents:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});



// Academic Year Routes
router.get('/academic-years', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
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
                totalCount = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
            totalCount = 0;
            notifications = [];
        }

        // Get all academic years with their terms
        const [academicYears] = academicYearsHaveSchoolId
            ? await connection.execute(
                `SELECT 
                    ay.*,
                    (SELECT COUNT(*)
                     FROM academic_terms at
                     WHERE at.academic_year_id = ay.id${academicTermsHaveSchoolId ? ' AND at.school_id = ?' : ''}) as term_count
                 FROM academic_years ay
                 WHERE ay.school_id = ?
                 ORDER BY ay.start_date DESC`,
                academicTermsHaveSchoolId ? [schoolId, schoolId] : [schoolId]
            )
            : await connection.execute(
                `SELECT 
                    ay.*,
                    (SELECT COUNT(*) FROM academic_terms at WHERE at.academic_year_id = ay.id) as term_count
                 FROM academic_years ay
                 ORDER BY ay.start_date DESC`
            );

        // Get all terms for display
        let termsSql = `
            SELECT at.*, ay.year_name 
            FROM academic_terms at
            JOIN academic_years ay ON at.academic_year_id = ay.id
        `;
        const termsParams = [];
        if (academicYearsHaveSchoolId) {
            termsSql += ` WHERE ay.school_id = ?`;
            termsParams.push(schoolId);
            if (academicTermsHaveSchoolId) {
                termsSql += ` AND at.school_id = ?`;
                termsParams.push(schoolId);
            }
        } else if (academicTermsHaveSchoolId) {
            termsSql += ` WHERE at.school_id = ?`;
            termsParams.push(schoolId);
        }
        termsSql += ` ORDER BY at.start_date DESC`;
        const [terms] = await connection.execute(termsSql, termsParams);

        res.render('academic-years', {
            academicYears: academicYears,
            terms: terms,
            error: req.session.error || null,
            success: req.session.success || null,
            username: username,                    // ADD THIS LINE
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment')
        });

        // Clear session messages
        delete req.session.error;
        delete req.session.success;

    } catch (error) {
        console.error('Error fetching academic years:', error);
        res.render('academic-years', {
            academicYears: [],
            terms: [],
            error: 'Failed to load academic years',
            success: null,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,
            totalCount: 0,
            notifications: []
        });
    }
});

// GET route to display add academic year form
router.get('/add-academic-year', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
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
                totalCount = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
            totalCount = 0;
            notifications = [];
        }

        res.render('add-academic-year', {
            formData: {
                year_name: '',
                start_date: '',
                end_date: '',
                first_term_start: '',
                first_term_end: '',
                second_term_start: '',
                second_term_end: '',
                third_term_start: '',
                third_term_end: ''
            },
            isEdit: false,
            academicYearId: null,
            error: null,
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading add academic year page:', error);
        res.render('add-academic-year', {
            formData: {
                year_name: '',
                start_date: '',
                end_date: '',
                first_term_start: '',
                first_term_end: '',
                second_term_start: '',
                second_term_end: '',
                third_term_start: '',
                third_term_end: ''
            },
            isEdit: false,
            academicYearId: null,
            error: 'Failed to load page: ' + error.message,
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// POST route to add a new academic year with terms
router.post('/add-academic-year', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { 
        year_name, 
        start_date, 
        end_date, 
        is_current,
        first_term_start,
        first_term_end,
        second_term_start,
        second_term_end,
        third_term_start,
        third_term_end
    } = req.body;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');
        
        // Validate required fields
        if (!year_name || !start_date || !end_date) {
            return res.render('add-academic-year', {
                formData: req.body,
                error: 'Year name, start date, and end date are required'
            });
        }
        
        // Validate term dates
        if (!first_term_start || !first_term_end || 
            !second_term_start || !second_term_end || 
            !third_term_start || !third_term_end) {
            return res.render('add-academic-year', {
                formData: req.body,
                error: 'All term dates are required'
            });
        }
        
        // Format dates
        const formattedStartDate = moment(start_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const formattedEndDate = moment(end_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        
        // If this is set as current year, unset any other current year
        if (is_current === 'on') {
            if (academicYearsHaveSchoolId) {
                await connection.execute(
                    'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND school_id = ?',
                    [schoolId]
                );
            } else {
                await connection.execute(
                    'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
                );
            }
        }
        
        // Insert new academic year
        const [result] = academicYearsHaveSchoolId
            ? await connection.execute(
                'INSERT INTO academic_years (year_name, start_date, end_date, is_current, school_id) VALUES (?, ?, ?, ?, ?)',
                [year_name, formattedStartDate, formattedEndDate, is_current === 'on', schoolId]
            )
            : await connection.execute(
                'INSERT INTO academic_years (year_name, start_date, end_date, is_current) VALUES (?, ?, ?, ?)',
                [year_name, formattedStartDate, formattedEndDate, is_current === 'on']
            );
        
        const academicYearId = result.insertId;
        
        // Insert terms
        const terms = [
            { name: 'First Term', start: first_term_start, end: first_term_end },
            { name: 'Second Term', start: second_term_start, end: second_term_end },
            { name: 'Third Term', start: third_term_start, end: third_term_end }
        ];
        
        for (const term of terms) {
            const termStartDate = moment(term.start, 'YYYY-MM-DD').format('YYYY-MM-DD');
            const termEndDate = moment(term.end, 'YYYY-MM-DD').format('YYYY-MM-DD');
            
            if (academicTermsHaveSchoolId) {
                await connection.execute(
                    'INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date, school_id) VALUES (?, ?, ?, ?, ?)',
                    [academicYearId, term.name, termStartDate, termEndDate, schoolId]
                );
            } else {
                await connection.execute(
                    'INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date) VALUES (?, ?, ?, ?)',
                    [academicYearId, term.name, termStartDate, termEndDate]
                );
            }
        }
        
        req.session.success = 'Academic year added successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error adding academic year:', error);
        
        let errorMessage = 'Failed to add academic year';
        if (error.code === 'ER_DUP_ENTRY') {
            errorMessage = 'An academic year with this name already exists';
        }
        
        res.render('add-academic-year', {
            formData: req.body,
            error: errorMessage
        });
    }
});

// ==================== EDIT ACADEMIC YEAR ROUTES ====================

// GET route - Edit Academic Year (Admin Only)
router.get('/edit-academic-year/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicYearId = req.params.id;
        const adminId = req.session.userId;

        // Check if tables have school_id column (for backward compatibility)
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                totalCount = totalResult[0]?.total || 0;

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
            totalCount = 0;
            notifications = [];
        }

        // Get academic year details
        let academicYears;
        if (academicYearsHaveSchoolId) {
            [academicYears] = await connection.execute(`
                SELECT * FROM academic_years WHERE id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)
            `, [academicYearId, schoolId, schoolId]);
        } else {
            [academicYears] = await connection.execute(`
                SELECT * FROM academic_years WHERE id = ?
            `, [academicYearId]);
        }

        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }

        const academicYear = academicYears[0];

        // Get terms for this academic year
        let terms;
        if (academicTermsHaveSchoolId) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [academicYearId, schoolId, schoolId]);
        } else {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ?
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [academicYearId]);
        }

        // Organize term dates
        const termMap = {};
        terms.forEach(term => {
            termMap[term.term_name] = term;
        });

        // Format dates for form input
        const formatDate = (date) => {
            if (!date) return '';
            if (typeof date === 'string') return date.split('T')[0] || date;
            return moment(date).format('YYYY-MM-DD');
        };

        const formData = {
            year_name: academicYear.year_name,
            start_date: formatDate(academicYear.start_date),
            end_date: formatDate(academicYear.end_date),
            is_current: academicYear.is_current ? true : false,
            first_term_start: termMap['First Term'] ? formatDate(termMap['First Term'].start_date) : '',
            first_term_end: termMap['First Term'] ? formatDate(termMap['First Term'].end_date) : '',
            second_term_start: termMap['Second Term'] ? formatDate(termMap['Second Term'].start_date) : '',
            second_term_end: termMap['Second Term'] ? formatDate(termMap['Second Term'].end_date) : '',
            third_term_start: termMap['Third Term'] ? formatDate(termMap['Third Term'].start_date) : '',
            third_term_end: termMap['Third Term'] ? formatDate(termMap['Third Term'].end_date) : ''
        };

        res.render('add-academic-year', {
            formData: formData,
            academicYearId: academicYearId,
            isEdit: true,
            error: null,
            success: req.session.success || null,
            username: req.session.username || 'Admin',
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading academic year for edit:', error);
        res.render('add-academic-year', {
            formData: {
                year_name: '',
                start_date: '',
                end_date: '',
                first_term_start: '',
                first_term_end: '',
                second_term_start: '',
                second_term_end: '',
                third_term_start: '',
                third_term_end: ''
            },
            isEdit: false,
            academicYearId: null,
            error: 'Failed to load academic year: ' + error.message,
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// POST route - Update Academic Year (Admin Only)
router.post('/edit-academic-year/:id', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const academicYearId = req.params.id;
    const { 
        year_name, 
        start_date, 
        end_date, 
        is_current,
        first_term_start,
        first_term_end,
        second_term_start,
        second_term_end,
        third_term_start,
        third_term_end
    } = req.body;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        // Check if tables have school_id column
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        // Validate required fields
        if (!year_name || !start_date || !end_date) {
            return res.render('add-academic-year', {
                formData: req.body,
                isEdit: true,
                academicYearId: academicYearId,
                error: 'Year name, start date, and end date are required',
                username: req.session.username,
                unreadCount: 0,
                totalCount: 0,
                notifications: [],
                moment: require('moment')
            });
        }

        // Validate term dates
        if (!first_term_start || !first_term_end || 
            !second_term_start || !second_term_end || 
            !third_term_start || !third_term_end) {
            return res.render('add-academic-year', {
                formData: req.body,
                isEdit: true,
                academicYearId: academicYearId,
                error: 'All term dates are required',
                username: req.session.username,
                unreadCount: 0,
                totalCount: 0,
                notifications: [],
                moment: require('moment')
            });
        }

        // Validate date ranges
        const startDateObj = moment(start_date, 'YYYY-MM-DD');
        const endDateObj = moment(end_date, 'YYYY-MM-DD');
        
        if (!startDateObj.isValid() || !endDateObj.isValid()) {
            return res.render('add-academic-year', {
                formData: req.body,
                isEdit: true,
                academicYearId: academicYearId,
                error: 'Invalid date format. Please use YYYY-MM-DD',
                username: req.session.username,
                unreadCount: 0,
                totalCount: 0,
                notifications: [],
                moment: require('moment')
            });
        }

        if (startDateObj.isAfter(endDateObj)) {
            return res.render('add-academic-year', {
                formData: req.body,
                isEdit: true,
                academicYearId: academicYearId,
                error: 'Start date must be before end date',
                username: req.session.username,
                unreadCount: 0,
                totalCount: 0,
                notifications: [],
                moment: require('moment')
            });
        }

        // Validate term dates within academic year
        const termStartDates = [
            moment(first_term_start, 'YYYY-MM-DD'),
            moment(second_term_start, 'YYYY-MM-DD'),
            moment(third_term_start, 'YYYY-MM-DD')
        ];
        const termEndDates = [
            moment(first_term_end, 'YYYY-MM-DD'),
            moment(second_term_end, 'YYYY-MM-DD'),
            moment(third_term_end, 'YYYY-MM-DD')
        ];

        for (let i = 0; i < 3; i++) {
            if (!termStartDates[i].isValid() || !termEndDates[i].isValid()) {
                return res.render('add-academic-year', {
                    formData: req.body,
                    isEdit: true,
                    academicYearId: academicYearId,
                    error: `Invalid date format for ${['First', 'Second', 'Third'][i]} Term`,
                    username: req.session.username,
                    unreadCount: 0,
                    totalCount: 0,
                    notifications: [],
                    moment: require('moment')
                });
            }

            if (termStartDates[i].isBefore(startDateObj) || termEndDates[i].isAfter(endDateObj)) {
                return res.render('add-academic-year', {
                    formData: req.body,
                    isEdit: true,
                    academicYearId: academicYearId,
                    error: `Term dates must be within the academic year range (${start_date} to ${end_date})`,
                    username: req.session.username,
                    unreadCount: 0,
                    totalCount: 0,
                    notifications: [],
                    moment: require('moment')
                });
            }

            if (termStartDates[i].isAfter(termEndDates[i])) {
                return res.render('add-academic-year', {
                    formData: req.body,
                    isEdit: true,
                    academicYearId: academicYearId,
                    error: `${['First', 'Second', 'Third'][i]} Term start date must be before end date`,
                    username: req.session.username,
                    unreadCount: 0,
                    totalCount: 0,
                    notifications: [],
                    moment: require('moment')
                });
            }
        }

        // Check if year_name already exists (excluding current)
        const [existingYears] = academicYearsHaveSchoolId
            ? await connection.execute(`
                SELECT id FROM academic_years 
                WHERE year_name = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL) AND id != ?
            `, [year_name, schoolId, schoolId, academicYearId])
            : await connection.execute(`
                SELECT id FROM academic_years 
                WHERE year_name = ? AND id != ?
            `, [year_name, academicYearId]);

        if (existingYears.length > 0) {
            return res.render('add-academic-year', {
                formData: req.body,
                isEdit: true,
                academicYearId: academicYearId,
                error: `An academic year with the name "${year_name}" already exists`,
                username: req.session.username,
                unreadCount: 0,
                totalCount: 0,
                notifications: [],
                moment: require('moment')
            });
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            // If this is set as current year, unset any other current year
            if (is_current === 'on') {
                if (academicYearsHaveSchoolId && schoolId) {
                    await connection.execute(
                        'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL) AND id != ?',
                        [schoolId, academicYearId]
                    );
                } else {
                    await connection.execute(
                        'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND id != ?',
                        [academicYearId]
                    );
                }
            }

            // Format dates
            const formattedStartDate = moment(start_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
            const formattedEndDate = moment(end_date, 'YYYY-MM-DD').format('YYYY-MM-DD');

            // Update academic year
            if (academicYearsHaveSchoolId) {
                await connection.execute(`
                    UPDATE academic_years 
                    SET year_name = ?, start_date = ?, end_date = ?, is_current = ?, updated_at = NOW()
                    WHERE id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)
                `, [year_name, formattedStartDate, formattedEndDate, is_current === 'on' ? 1 : 0, academicYearId, schoolId, schoolId]);
            } else {
                await connection.execute(`
                    UPDATE academic_years 
                    SET year_name = ?, start_date = ?, end_date = ?, is_current = ?, updated_at = NOW()
                    WHERE id = ?
                `, [year_name, formattedStartDate, formattedEndDate, is_current === 'on' ? 1 : 0, academicYearId]);
            }

            // Update terms (upsert so missing terms are created, existing terms updated)
            const terms = [
                { name: 'First Term', start: first_term_start, end: first_term_end },
                { name: 'Second Term', start: second_term_start, end: second_term_end },
                { name: 'Third Term', start: third_term_start, end: third_term_end }
            ];

            for (const term of terms) {
                const termStartDate = moment(term.start, 'YYYY-MM-DD').format('YYYY-MM-DD');
                const termEndDate = moment(term.end, 'YYYY-MM-DD').format('YYYY-MM-DD');

                const [existingTerm] = await connection.execute(
                    'SELECT id FROM academic_terms WHERE academic_year_id = ? AND term_name = ? LIMIT 1',
                    [academicYearId, term.name]
                );

                if (existingTerm.length > 0) {
                    if (academicTermsHaveSchoolId && schoolId) {
                        await connection.execute(`
                            UPDATE academic_terms 
                            SET start_date = ?, end_date = ?, school_id = COALESCE(school_id, ?), updated_at = NOW()
                            WHERE id = ?
                        `, [termStartDate, termEndDate, schoolId, existingTerm[0].id]);
                    } else {
                        await connection.execute(`
                            UPDATE academic_terms 
                            SET start_date = ?, end_date = ?, updated_at = NOW()
                            WHERE id = ?
                        `, [termStartDate, termEndDate, existingTerm[0].id]);
                    }
                } else {
                    if (academicTermsHaveSchoolId) {
                        await connection.execute(`
                            INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date, school_id, is_current, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())
                        `, [academicYearId, term.name, termStartDate, termEndDate, schoolId]);
                    } else {
                        await connection.execute(`
                            INSERT INTO academic_terms (academic_year_id, term_name, start_date, end_date, is_current, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 0, NOW(), NOW())
                        `, [academicYearId, term.name, termStartDate, termEndDate]);
                    }
                }
            }

            await connection.commit();

            req.session.success = `Academic year "${year_name}" updated successfully`;
            res.redirect('/academic-years');

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error updating academic year:', error);

        let errorMessage = 'Failed to update academic year';
        if (error.code === 'ER_DUP_ENTRY') {
            errorMessage = 'An academic year with this name already exists';
        } else if (error.code === 'ER_DATA_TOO_LONG') {
            errorMessage = 'One or more fields contain data that is too long. Please check your inputs.';
        }

        res.render('add-academic-year', {
            formData: req.body,
            isEdit: true,
            academicYearId: req.params.id,
            error: errorMessage,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// GET route to set academic year as current
router.get('/set-current-academic-year/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        
        // Unset any current academic year
        if (academicYearsHaveSchoolId && schoolId) {
            await connection.execute(
                'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL)',
                [schoolId]
            );
        } else {
            await connection.execute(
                'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
            );
        }
        
        // Set the selected academic year as current
        await connection.execute(
            'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
            [req.params.id]
        );
        
        req.session.success = 'Current academic year set successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error setting current academic year:', error);
        req.session.error = 'Failed to set current academic year';
        res.redirect('/academic-years');
    }
});

// GET route to set term as current
router.get('/set-current-term/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');
        
        // Get the term to set as current
        const [terms] = academicTermsHaveSchoolId
            ? await connection.execute(
                'SELECT * FROM academic_terms WHERE id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)',
                [req.params.id, schoolId, schoolId]
            )
            : await connection.execute(
                'SELECT * FROM academic_terms WHERE id = ?',
                [req.params.id]
            );
        
        if (terms.length === 0) {
            req.session.error = 'Term not found';
            return res.redirect('/academic-years');
        }
        
        const term = terms[0];

        await connection.beginTransaction();

        try {
            // Unset any current term
            if (academicTermsHaveSchoolId && schoolId) {
                await connection.execute(
                    'UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL)',
                    [schoolId]
                );
            } else {
                await connection.execute(
                    'UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE'
                );
            }
            
            // Set the selected term as current
            await connection.execute(
                'UPDATE academic_terms SET is_current = TRUE WHERE id = ?',
                [req.params.id]
            );
            
            // Also set the academic year as current (unsetting others)
            if (academicYearsHaveSchoolId && schoolId) {
                await connection.execute(
                    'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL)',
                    [schoolId]
                );
                await connection.execute(
                    'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
                    [term.academic_year_id]
                );
            } else {
                await connection.execute(
                    'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE'
                );
                await connection.execute(
                    'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
                    [term.academic_year_id]
                );
            }

            await connection.commit();
            
            req.session.success = `Current term set to "${term.term_name}" successfully`;
            res.redirect('/academic-years');
        } catch (trxErr) {
            await connection.rollback();
            throw trxErr;
        }
    } catch (error) {
        console.error('Error setting current term:', error);
        req.session.error = 'Failed to set current term';
        res.redirect('/academic-years');
    }
});

// GET route - Edit Term (Redirects to academic-years with modal trigger)
router.get('/edit-term/:id', authenticate, requireRole('admin'), async (req, res) => {
    res.redirect(`/academic-years?editTerm=${req.params.id}`);
});

// POST route - Edit Term
router.post('/edit-term/:id', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const termId = req.params.id;
        const { term_name, start_date, end_date, is_current } = req.body;

        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        // Check if term exists
        const [terms] = academicTermsHaveSchoolId
            ? await connection.execute(
                'SELECT at.*, ay.year_name, ay.start_date as year_start, ay.end_date as year_end FROM academic_terms at JOIN academic_years ay ON at.academic_year_id = ay.id WHERE at.id = ? AND (at.school_id = ? OR ? IS NULL OR at.school_id IS NULL)',
                [termId, schoolId, schoolId]
            )
            : await connection.execute(
                'SELECT at.*, ay.year_name, ay.start_date as year_start, ay.end_date as year_end FROM academic_terms at JOIN academic_years ay ON at.academic_year_id = ay.id WHERE at.id = ?',
                [termId]
            );

        if (terms.length === 0) {
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(404).json({ success: false, message: 'Academic term not found' });
            }
            req.session.error = 'Academic term not found';
            return res.redirect('/academic-years');
        }

        const currentTermData = terms[0];

        // Validate required fields
        if (!start_date || !end_date) {
            const msg = 'Both start date and end date are required';
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(400).json({ success: false, message: msg });
            }
            req.session.error = msg;
            return res.redirect('/academic-years');
        }

        const startDateObj = moment(start_date, 'YYYY-MM-DD');
        const endDateObj = moment(end_date, 'YYYY-MM-DD');

        if (!startDateObj.isValid() || !endDateObj.isValid()) {
            const msg = 'Invalid date format. Please use YYYY-MM-DD';
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(400).json({ success: false, message: msg });
            }
            req.session.error = msg;
            return res.redirect('/academic-years');
        }

        if (startDateObj.isAfter(endDateObj)) {
            const msg = 'Start date must be before or equal to end date';
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(400).json({ success: false, message: msg });
            }
            req.session.error = msg;
            return res.redirect('/academic-years');
        }

        const formattedStart = startDateObj.format('YYYY-MM-DD');
        const formattedEnd = endDateObj.format('YYYY-MM-DD');
        const nameToSave = (term_name && term_name.trim()) || currentTermData.term_name;
        const setAsCurrent = is_current === 'on' || is_current === '1' || is_current === true || is_current === 1;

        await connection.beginTransaction();

        try {
            if (setAsCurrent) {
                // Unset other current terms
                if (academicTermsHaveSchoolId && schoolId) {
                    await connection.execute(
                        'UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL)',
                        [schoolId]
                    );
                } else {
                    await connection.execute('UPDATE academic_terms SET is_current = FALSE WHERE is_current = TRUE');
                }

                // Also ensure parent academic year is current
                if (academicYearsHaveSchoolId && schoolId) {
                    await connection.execute(
                        'UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE AND (school_id = ? OR school_id IS NULL)',
                        [schoolId]
                    );
                    await connection.execute(
                        'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
                        [currentTermData.academic_year_id]
                    );
                } else {
                    await connection.execute('UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE');
                    await connection.execute(
                        'UPDATE academic_years SET is_current = TRUE WHERE id = ?',
                        [currentTermData.academic_year_id]
                    );
                }
            }

            // Update term details
            await connection.execute(
                'UPDATE academic_terms SET term_name = ?, start_date = ?, end_date = ?, is_current = ?, updated_at = NOW() WHERE id = ?',
                [nameToSave, formattedStart, formattedEnd, setAsCurrent ? 1 : (currentTermData.is_current ? 1 : 0), termId]
            );

            await connection.commit();

            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.json({ 
                    success: true, 
                    message: `Term "${nameToSave}" updated successfully` 
                });
            }

            req.session.success = `Term "${nameToSave}" updated successfully`;
            res.redirect('/academic-years');
        } catch (trxErr) {
            await connection.rollback();
            throw trxErr;
        }
    } catch (error) {
        console.error('Error updating term:', error);
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(500).json({ success: false, message: 'Failed to update term: ' + error.message });
        }
        req.session.error = 'Failed to update term: ' + error.message;
        res.redirect('/academic-years');
    }
});

// GET route to delete academic year
router.get('/delete-academic-year/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const feesHaveSchoolId = await tableHasColumn(connection, 'fees', 'school_id');
        const studentScoresHaveSchoolId = await tableHasColumn(connection, 'student_scores', 'school_id');
        
        // Check if academic year is used in any records
        const [academicYears] = academicYearsHaveSchoolId
            ? await connection.execute(
                'SELECT year_name FROM academic_years WHERE id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)',
                [req.params.id, schoolId, schoolId]
            )
            : await connection.execute(
                'SELECT year_name FROM academic_years WHERE id = ?',
                [req.params.id]
            );
        
        if (academicYears.length === 0) {
            req.session.error = 'Academic year not found';
            return res.redirect('/academic-years');
        }
        
        const yearName = academicYears[0].year_name;
        
        const [feeRecords] = feesHaveSchoolId
            ? await connection.execute(
                'SELECT COUNT(*) as count FROM fees WHERE academic_year = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)',
                [yearName, schoolId, schoolId]
            )
            : await connection.execute(
                'SELECT COUNT(*) as count FROM fees WHERE academic_year = ?',
                [yearName]
            );
        
        const [scoreRecords] = studentScoresHaveSchoolId
            ? await connection.execute(
                'SELECT COUNT(*) as count FROM student_scores WHERE academic_year = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)',
                [yearName, schoolId, schoolId]
            )
            : await connection.execute(
                'SELECT COUNT(*) as count FROM student_scores WHERE academic_year = ?',
                [yearName]
            );
        
        if (feeRecords[0].count > 0 || scoreRecords[0].count > 0) {
            req.session.error = 'Cannot delete academic year. It is being used in fee records or student scores.';
            return res.redirect('/academic-years');
        }
        
        // Delete academic year (terms will be deleted automatically due to CASCADE)
        if (academicYearsHaveSchoolId) {
            await connection.execute(
                'DELETE FROM academic_years WHERE id = ? AND (school_id = ? OR ? IS NULL OR school_id IS NULL)',
                [req.params.id, schoolId, schoolId]
            );
        } else {
            await connection.execute(
                'DELETE FROM academic_years WHERE id = ?',
                [req.params.id]
            );
        }
        
        req.session.success = 'Academic year deleted successfully';
        res.redirect('/academic-years');
    } catch (error) {
        console.error('Error deleting academic year:', error);
        req.session.error = 'Failed to delete academic year';
        res.redirect('/academic-years');
    }
});

// GET route to display the add student form

// GET route to display the add student form
router.get('/add-student', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        
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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
        
        // Get classes with their levels and departments
        const [classes] = await connection.execute(`
            SELECT id, className, classCode, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `, [schoolId]);

        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
        }

        res.render('add-student', { 
            classes: classes,
            nigerianStates: nigerianStates,
            formData: {},
            success: success,
            error: null,
            mode: 'add',
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });
    } catch (error) {
        console.error('Error loading add student form:', error);
        res.render('add-student', { 
            classes: [],
            nigerianStates: nigerianStates,
            formData: {},
            success: null,
            error: 'Failed to load data',
            mode: 'add',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// POST route to save student with parent linking
router.post('/save-student', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const {
        studentId,
        firstName,
        middleName,
        lastName,
        email,
        nationality,
        classId,
        gender,
        mobileNumber,
        parentsName,
        parentsMobileNumber,
        dateOfBirth,
        address,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        // Parent fields
        existingParentId,
        parentFirstName,
        parentLastName,
        parentEmail,
        parentPhone,
        parentPassword,
        parentRelationship,
        parentOccupation,
        parentEmergencyContact,
        parentAddress,
        setAsPrimary
    } = req.body;

    const isEdit = !!studentId;
    const mode = isEdit ? 'edit' : 'add';

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // Validate required fields for student
        if (!firstName || !lastName || !email || !classId) {
            const [classes] = await connection.execute('SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className', [schoolId]);
            
            return res.render(isEdit ? 'edit-student' : 'add-student', { 
                classes: classes,
                nigerianStates: nigerianStates,
                formData: req.body,
                error: 'Please fill in all required fields (First Name, Last Name, Email, and Class).',
                mode: mode,
                studentId: studentId
            });
        }

        // Check if email already exists (excluding current student for edits)
        let emailCheckQuery = 'SELECT id, admission_number FROM students WHERE email = ?';
        let emailCheckParams = [email];
        
        if (isEdit) {
            emailCheckQuery += ' AND id != ?';
            emailCheckParams.push(studentId);
        }
        
        const [existingStudents] = await connection.execute(emailCheckQuery, emailCheckParams);
        
        if (existingStudents.length > 0) {
            const [classes] = await connection.execute('SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className', [schoolId]);
            
            return res.render(isEdit ? 'edit-student' : 'add-student', { 
                classes: classes,
                nigerianStates: nigerianStates,
                formData: req.body,
                error: 'A student with this email already exists. Admission Number: ' + existingStudents[0].admission_number,
                mode: mode,
                studentId: studentId
            });
        }

        // Get department from class if it's Senior Secondary
        let studentDepartment = null;
        const [classInfo] = await connection.execute('SELECT level, department FROM classes WHERE id = ?', [classId]);
        
        if (classInfo.length > 0 && classInfo[0].level === 'SENIOR SECONDARY') {
            studentDepartment = classInfo[0].department;
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            let finalStudentId = studentId;
            let admissionNumber = null;

            if (isEdit) {
                // Update existing student
                await connection.execute(
                    `UPDATE students SET 
                        firstName = ?, middleName = ?, lastName = ?, email = ?, classId = ?, 
                        gender = ?, mobileNumber = ?, parentsName = ?, parentsMobileNumber = ?, 
                        dateOfBirth = ?, nationality = ?, address = ?, department = ?, 
                        stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?
                     WHERE id = ? AND school_id = ?`,
                    [
                        firstName,
                        middleName || null,
                        lastName,
                        email,
                        classId,
                        gender || null,
                        mobileNumber || null,
                        parentsName || null,
                        parentsMobileNumber || null,
                        dateOfBirth || null,
                        nationality || null,
                        address || null,
                        studentDepartment,
                        stateOfOrigin || null,
                        localGovernment || null,
                        residentialState || null,
                        residentialLGA || null,
                        studentId,
                        schoolId
                    ]
                );
                finalStudentId = studentId;
            } else {
                // Generate admission number for new student
                const currentYear = new Date().getFullYear().toString().slice(-2);
                
                const [lastStudent] = await connection.execute(
                    'SELECT admission_number FROM students WHERE admission_number LIKE ? ORDER BY id DESC LIMIT 1',
                    [`ADM${currentYear}%`]
                );
                
                let nextNumber = 1;
                if (lastStudent.length > 0) {
                    const lastAdmissionNumber = lastStudent[0].admission_number;
                    const lastNumber = parseInt(lastAdmissionNumber.slice(5)) || 0;
                    nextNumber = lastNumber + 1;
                }
                
                admissionNumber = `ADM${currentYear}${nextNumber.toString().padStart(4, '0')}`;

                // Insert new student
                const [studentResult] = await connection.execute(
                    `INSERT INTO students 
                    (admission_number, firstName, middleName, lastName, email, classId, gender, 
                     mobileNumber, parentsName, parentsMobileNumber, dateOfBirth, nationality, 
                     address, department, stateOfOrigin, localGovernment, residentialState, residentialLGA, school_id) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        admissionNumber,
                        firstName,
                        middleName || null,
                        lastName,
                        email,
                        classId,
                        gender || null,
                        mobileNumber || null,
                        parentsName || null,
                        parentsMobileNumber || null,
                        dateOfBirth || null,
                        nationality || null,
                        address || null,
                        studentDepartment,
                        stateOfOrigin || null,
                        localGovernment || null,
                        residentialState || null,
                        residentialLGA || null,
                        schoolId
                    ]
                );
                finalStudentId = studentResult.insertId;
            }

            // Handle Parent Linking (only for new students or when parent info is provided)
            let parentId = null;
            
            if (!isEdit || (existingParentId || (parentFirstName && parentLastName && parentEmail))) {
                // Check if using an existing parent
                if (existingParentId && existingParentId !== '') {
                    parentId = existingParentId;
                    
                    // Verify parent exists and belongs to same school
                    const [parentCheck] = await connection.execute(
                        'SELECT id FROM parents WHERE id = ? AND school_id = ?',
                        [parentId, schoolId]
                    );
                    
                    if (parentCheck.length === 0) {
                        throw new Error('Selected parent does not exist or does not belong to this school');
                    }
                } 
                // Check if we need to create a new parent
                else if (parentFirstName && parentFirstName.trim() !== '' && 
                         parentLastName && parentLastName.trim() !== '' && 
                         parentEmail && parentEmail.trim() !== '' &&
                         parentPhone && parentPhone.trim() !== '') {
                    
                    // Check if parent with this email already exists
                    const [existingParents] = await connection.execute(
                        'SELECT id FROM parents WHERE email = ?',
                        [parentEmail]
                    );
                    
                    if (existingParents.length > 0) {
                        parentId = existingParents[0].id;
                    } else {
                        // Hash the password (use default if not provided)
                        const passwordToHash = parentPassword && parentPassword.trim() !== '' ? parentPassword : 'password123';
                        const hashedPassword = await argon2.hash(passwordToHash);
                        
                        // Insert new parent
                        const [parentResult] = await connection.execute(
                            `INSERT INTO parents 
                            (first_name, last_name, email, phone, address, relationship, occupation, emergency_contact, password, school_id, status) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                            [
                                parentFirstName.trim(),
                                parentLastName.trim(),
                                parentEmail.trim(),
                                parentPhone.trim(),
                                parentAddress || null,
                                parentRelationship || 'Parent',
                                parentOccupation || null,
                                parentEmergencyContact || null,
                                hashedPassword,
                                schoolId
                            ]
                        );
                        parentId = parentResult.insertId;
                    }
                }
                
                // Create link between student and parent if we have both IDs
                if (parentId && finalStudentId) {
                    // Check if link already exists
                    const [existingLink] = await connection.execute(
                        'SELECT id FROM parent_students WHERE parent_id = ? AND student_id = ?',
                        [parentId, finalStudentId]
                    );
                    
                    if (existingLink.length === 0) {
                        // If setAsPrimary is true, remove primary status from other parents for this student
                        if (setAsPrimary === '1' || setAsPrimary === 'on') {
                            await connection.execute(
                                'UPDATE parent_students SET is_primary = 0 WHERE student_id = ?',
                                [finalStudentId]
                            );
                        }
                        
                        // Create the link
                        await connection.execute(
                            `INSERT INTO parent_students (parent_id, student_id, relationship, is_primary, can_receive_notifications) 
                             VALUES (?, ?, ?, ?, 1)`,
                            [
                                parentId, 
                                finalStudentId, 
                                parentRelationship || 'Parent', 
                                (setAsPrimary === '1' || setAsPrimary === 'on') ? 1 : 0
                            ]
                        );
                    }
                }
            }

            await connection.commit();

            // Set success message
            if (isEdit) {
                req.session.success = 'Student updated successfully!';
            } else {
                req.session.success = `Student added successfully! Admission Number: ${admissionNumber}`;
                if (parentId) {
                    req.session.success += ` Parent linked successfully.`;
                }
            }
            
            res.redirect('/all-students');

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error saving student:', error);
        
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const [classes] = await connection.execute('SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className', [schoolId]);
        
        let errorMessage = `Failed to ${isEdit ? 'update' : 'add'} student. Please try again.`;
        if (error.code === 'ER_DUP_ENTRY') {
            if (error.sqlMessage && error.sqlMessage.includes('admission_number')) {
                errorMessage = 'Failed to generate unique admission number. Please try again.';
            } else if (error.sqlMessage && error.sqlMessage.includes('email')) {
                errorMessage = 'A student with this email already exists.';
            }
        } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            errorMessage = 'The selected class does not exist.';
        } else if (error.code === 'ER_DATA_TOO_LONG') {
            errorMessage = 'One or more fields contain data that is too long. Please check your inputs.';
        } else if (error.message) {
            errorMessage = error.message;
        }

        res.render(isEdit ? 'edit-student' : 'add-student', { 
            classes: classes,
            nigerianStates: nigerianStates,
            formData: req.body,
            error: errorMessage,
            mode: mode,
            studentId: studentId
        });
    }
});

// GET /edit-student/:id
// GET /edit-student/:id
router.get('/edit-student/:id', authenticate, requireRole('admin'), async (req, res) => {
    const studentId = req.params.id;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        // Get student data
        const [students] = await connection.execute(
            'SELECT * FROM students WHERE id = ? AND school_id = ?',
            [studentId, schoolId]
        );

        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }

        const student = students[0];

        // Get classes with their levels and departments
        const [classes] = await connection.execute(`
            SELECT id, className, classCode, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `, [schoolId]);

        // Get linked parents for this student (for edit mode)
        const [linkedParents] = await connection.execute(`
            SELECT p.*, ps.relationship, ps.is_primary
            FROM parents p
            JOIN parent_students ps ON p.id = ps.parent_id
            WHERE ps.student_id = ? AND p.school_id = ?
        `, [studentId, schoolId]);

        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
        }

        res.render('edit-student', {
            classes: classes,
            nigerianStates: nigerianStates,
            formData: student,
            linkedParents: linkedParents,
            success: success,
            error: null,
            mode: 'edit',
            studentId: studentId,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error loading edit student form:', error);
        req.session.error = 'Error loading student data: ' + error.message;
        res.redirect('/all-students');
    }
});

// GET route to delete student
router.get('/delete-student/:id', authenticate, requireRole('admin'), async (req, res) => {
    const studentId = req.params.id;

    try {
        const connection = await getConnection();
        
        // First check if student exists
        const [students] = await connection.execute(
            'SELECT admission_number FROM students WHERE id = ? AND school_id = ?',
            [studentId, req.session.schoolId || null]
        );
        
        if (students.length === 0) {
            req.session.error = 'Student not found';
            return res.redirect('/all-students');
        }
        
        const admissionNumber = students[0].admission_number;
        
        // Start transaction
        await connection.beginTransaction();
        
        try {
            // Delete parent-student links first
            await connection.execute('DELETE FROM parent_students WHERE student_id = ?', [studentId]);
            
            // Delete fees
            await connection.execute('DELETE FROM fees WHERE studentId = ?', [studentId]);
            
            // Delete attendance records
            await connection.execute('DELETE FROM attendance_records WHERE student_id = ?', [studentId]);
            
            // Delete scores
            await connection.execute('DELETE FROM student_scores WHERE student_id = ?', [studentId]);
            
            // Then delete the student
            const [result] = await connection.execute('DELETE FROM students WHERE id = ? AND school_id = ?', [studentId, req.session.schoolId || null]);
            
            if (result.affectedRows === 0) {
                throw new Error('Failed to delete student');
            }
            
            await connection.commit();
            req.session.success = `Student ${admissionNumber} deleted successfully`;
            
        } catch (error) {
            await connection.rollback();
            throw error;
        }
        
        res.redirect('/all-students');
    } catch (error) {
        console.error('Error deleting student:', error);
        
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            req.session.error = `Cannot delete student. There are related records that must be deleted first.`;
        } else {
            req.session.error = 'Error deleting student: ' + error.message;
        }
        res.redirect('/all-students');
    }
});

// GET route - View all students
router.get('/all-students', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        
        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let notificationTotal = 0;  // Renamed to avoid conflict
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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
        
        const { page, limit, offset, q } = parsePage(req);
        let studentWhere = "WHERE s.school_id = ? AND (s.status IS NULL OR s.status != 'graduated')";
        const studentParams = [schoolId];
        if (q) {
            studentWhere += ` AND (
                s.firstName LIKE ? OR 
                s.lastName LIKE ? OR 
                s.middleName LIKE ? OR 
                CONCAT_WS(' ', s.firstName, s.middleName, s.lastName) LIKE ? OR
                CONCAT_WS(' ', s.firstName, s.lastName) LIKE ? OR
                s.admission_number LIKE ? OR 
                s.email LIKE ? OR 
                s.gender LIKE ? OR 
                DATE_FORMAT(s.dateOfBirth, '%Y-%m-%d') LIKE ? OR 
                DATE_FORMAT(s.dateOfBirth, '%d/%m/%Y') LIKE ? OR 
                DATE_FORMAT(s.dateOfBirth, '%m/%d/%Y') LIKE ? OR 
                c.className LIKE ? OR 
                c.department LIKE ? OR 
                c.level LIKE ?
            )`;
            const like = searchLike(q);
            studentParams.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like);
        }
        const [studentCountRows] = await connection.execute(
            `SELECT COUNT(*) as total FROM students s LEFT JOIN classes c ON s.classId = c.id ${studentWhere}`,
            studentParams
        );
        const listTotal = studentCountRows[0]?.total || 0;
        const totalPages = Math.max(1, Math.ceil(listTotal / limit));

        const [classes] = await connection.execute(
            'SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className',
            [schoolId]
        );

        const [students] = await connection.query(`
            SELECT s.*, c.className, c.level, c.department AS classDepartment
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            ${studentWhere}
            ORDER BY 
                CASE 
                    WHEN c.level = 'KG' THEN 1
                    WHEN c.level = 'NURSERY' THEN 2
                    WHEN c.level = 'PRIMARY' THEN 3
                    WHEN c.level = 'JUNIOR SECONDARY' THEN 4
                    WHEN c.level = 'SENIOR SECONDARY' THEN 5
                    ELSE 6
                END,
                c.className,
                s.admission_number,
                s.firstName
            LIMIT ${limit} OFFSET ${offset}
        `, studentParams);
        
        // Format registration dates for display
        const formattedStudents = students.map(student => ({
            ...student,
            registrationDate: student.registrationDate ? 
                new Date(student.registrationDate).toLocaleDateString() : 'N/A',
            dateOfBirth: student.dateOfBirth ?
                new Date(student.dateOfBirth).toLocaleDateString() : 'N/A'
        }));
        
        // Check for success message from session
        const success = req.session.success || null;
        if (req.session.success) {
            delete req.session.success;
        }

        const flashError = req.session.error || null;
        if (req.session.error) {
            delete req.session.error;
        }
        
        res.render('all-students', { 
            students: formattedStudents,
            classes: classes || [],
            success: success,
            error: flashError,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            pagerPage: page,
            totalPages,
            totalRecords: listTotal,
            extraQuery: q ? `&q=${encodeURIComponent(q)}` : '',
            searchQ: q
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.render('all-students', { 
            students: [], 
            error: 'Failed to load students.',
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            pagerPage: 1,
            totalPages: 1,
            totalRecords: 0,
            extraQuery: '',
            searchQ: ''
        });
    }
});

router.get('/api/students/search', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ students: [] });
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const like = searchLike(q);
        const [rows] = await connection.query(
            `SELECT id, firstName, middleName, lastName, admission_number
             FROM students
             WHERE school_id = ?
               AND (firstName LIKE ? OR lastName LIKE ? OR middleName LIKE ? OR admission_number LIKE ?)
             ORDER BY firstName, lastName
             LIMIT 20`,
            [schoolId, like, like, like, like]
        );
        res.json({ students: rows });
    } catch (error) {
        console.error('Student search error:', error);
        res.status(500).json({ students: [], error: 'Search failed' });
    }
});

// ==================== PARENT VIEW STUDENT PROFILE ROUTE ====================

// GET route - Parent views student profile (protected by parent role)


// Teacher Routes
router.get('/add-teacher', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        res.render('add-teacher', {
            formData: {},
            error: null,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error loading add teacher form:', error);
        res.render('add-teacher', {
            formData: {},
            error: 'Failed to load form',
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

router.get('/all-teachers', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        const { page, limit, offset, q } = parsePage(req);
        let teacherWhere = 'WHERE school_id = ?';
        const teacherParams = [schoolId];
        if (q) {
            teacherWhere += ' AND (firstName LIKE ? OR lastName LIKE ? OR email LIKE ? OR designation LIKE ?)';
            const like = searchLike(q);
            teacherParams.push(like, like, like, like);
        }
        const [teacherCountRows] = await connection.execute(
            `SELECT COUNT(*) as total FROM teachers ${teacherWhere}`,
            teacherParams
        );
        const listTotal = teacherCountRows[0]?.total || 0;
        const totalPages = Math.max(1, Math.ceil(listTotal / limit));
        const [teachers] = await connection.query(
            `SELECT * FROM teachers ${teacherWhere} ORDER BY firstName, lastName LIMIT ${limit} OFFSET ${offset}`,
            teacherParams
        );

        // Format dates for display
        const formattedTeachers = teachers.map(teacher => ({
            ...teacher,
            joiningDate: teacher.joiningDate ? moment(teacher.joiningDate).format('D MMMM, YYYY') : 'N/A',
            dateOfBirth: teacher.dateOfBirth ? moment(teacher.dateOfBirth).format('D MMMM, YYYY') : 'N/A'
        }));

        res.render('all-teachers', {
            teachers: formattedTeachers,
            error: null,
            success: req.session.success || null,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            pagerPage: page,
            totalPages,
            totalRecords: listTotal,
            extraQuery: q ? `&q=${encodeURIComponent(q)}` : '',
            searchQ: q
        });

        // Clear success message
        delete req.session.success;
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.render('all-teachers', {
            teachers: [],
            error: 'Failed to load teachers. Please try again.',
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            pagerPage: 1,
            totalPages: 1,
            totalRecords: 0,
            extraQuery: '',
            searchQ: ''
        });
    }
});

router.get('/edit-teacher/:id', authenticate, requireRole('admin'), async (req, res) => {
    const teacherId = req.params.id;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ? AND school_id = ?', [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const teacher = teachers[0];

        // Format dates for the form
        const formattedTeacher = {
            ...teacher,
            joiningDate: teacher.joiningDate ? moment(teacher.joiningDate).format('YYYY-MM-DD') : '',
            dateOfBirth: teacher.dateOfBirth ? moment(teacher.dateOfBirth).format('YYYY-MM-DD') : ''
        };

        res.render('edit-teacher', {
            teacher: formattedTeacher,
            error: null,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error fetching teacher:', error);
        req.session.error = 'Error fetching teacher details';
        res.redirect('/all-teachers');
    }
});

router.post('/add-teacher', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {

    const {
        firstName,
        lastName,
        email,
        joiningDate,
        password,
        mobileNumber,
        gender,
        designation,
        department,
        dateOfBirth,
        education,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address
    } = req.body;

    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'joiningDate', 'password', 'mobileNumber'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            return res.render('add-teacher', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                formData: req.body
            });
        }

        const connection = await getConnection();

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Format the dates
        let formattedJoiningDate = null;
        let formattedDateOfBirth = null;
        
        try {
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid() 
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            return res.render('add-teacher', { 
                error: 'Invalid date format. Please use the correct date format.',
                formData: req.body
            });
        }

        // Insert into database
        const [result] = await connection.execute(
            `INSERT INTO teachers 
            (firstName, lastName, email, joiningDate, password, mobileNumber, gender, 
            designation, department, dateOfBirth, education, nationality, stateOfOrigin, 
            localGovernment, residentialState, residentialLGA, emergencyContactName, 
            emergencyContactNumber, address, school_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firstName,
                lastName,
                email,
                formattedJoiningDate,
                hashedPassword,
                mobileNumber,
                gender || null,
                designation || null,
                department || null,
                formattedDateOfBirth,
                education || null,
                nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null,
                req.session.schoolId || null
            ]
        );

        console.log('Teacher inserted successfully, ID:', result.insertId);
        
        // Set success message in session
        req.session.success = 'Teacher added successfully';
        res.redirect('/all-teachers');
        
    } catch (error) {
        console.error('Error adding teacher:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.render('add-teacher', { 
                error: 'Email already exists',
                formData: req.body
            });
        }
        
        res.render('add-teacher', { 
            error: 'Failed to add teacher. Please try again. Error: ' + error.message,
            formData: req.body
        });
    }
});

router.post('/edit-teacher/:id', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const teacherId = req.params.id; 
    const {
        firstName,
        lastName,
        email,
        joiningDate,
        mobileNumber,
        gender,
        designation,
        department,
        dateOfBirth,
        education,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address
    } = req.body;

    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'joiningDate', 'mobileNumber'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ? AND school_id = ?', [teacherId, req.session.schoolId || null]);
            return res.render('edit-teacher', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                teacher: teachers[0] || {}
            });
        }

        const connection = await getConnection();

        // Format the dates to 'YYYY-MM-DD'
        let formattedJoiningDate = null;
        let formattedDateOfBirth = null;
        
        try {
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid() 
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ? AND school_id = ?', [teacherId, req.session.schoolId || null]);
            return res.render('edit-teacher', { 
                error: 'Invalid date format. Please use the correct date format',
                teacher: teachers[0] || {}
            });
        }

        // Update the teacher in the database
        const [result] = await connection.execute(
            `UPDATE teachers SET 
            firstName = ?, lastName = ?, email = ?, joiningDate = ?, mobileNumber = ?, 
            gender = ?, designation = ?, department = ?, dateOfBirth = ?, education = ?,
            nationality = ?, stateOfOrigin = ?, localGovernment = ?, residentialState = ?,
            residentialLGA = ?, emergencyContactName = ?, emergencyContactNumber = ?, address = ?
            WHERE id = ? AND school_id = ?`,
            [
                firstName,
                lastName,
                email,
                formattedJoiningDate,
                mobileNumber,
                gender || null,
                designation || null,
                department || null,
                formattedDateOfBirth,
                education || null,
                nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null,
                teacherId,
                req.session.schoolId || null
            ]
        );

        console.log('Update result:', result);

        if (result.affectedRows === 0) {
            req.session.error = 'Teacher not found or no changes made';
        } else {
            req.session.success = 'Teacher updated successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error updating teacher:', error);
        
        // Handle duplicate email error
        if (error.code === 'ER_DUP_ENTRY') {
            const connection = await getConnection();
            const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ? AND school_id = ?', [teacherId, req.session.schoolId || null]);
            return res.render('edit-teacher', { 
                error: 'Email already exists',
                teacher: teachers[0] || {}
            });
        }
        
        req.session.error = 'Error updating teacher: ' + error.message;
        res.redirect('/all-teachers');
    }
});
router.get('/delete-teacher/:id', authenticate, requireRole('admin'), async (req, res) => {
    const teacherId = req.params.id;

    try {
        const connection = await getConnection();
        
        // Check if teacher exists before deleting
        const [teachers] = await connection.execute('SELECT * FROM teachers WHERE id = ? AND school_id = ?', [teacherId, req.session.schoolId || null]);
        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/all-teachers');
        }

        const [result] = await connection.execute('DELETE FROM teachers WHERE id = ? AND school_id = ?', [teacherId, req.session.schoolId || null]);
        
        if (result.affectedRows === 0) {
            req.session.error = 'Failed to delete teacher';
        } else {
            req.session.success = 'Teacher deleted successfully';
        }
        
        res.redirect('/all-teachers');
    } catch (error) {
        console.error('Error deleting teacher:', error);
        
        // Handle foreign key constraint errors
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            req.session.error = 'Cannot delete teacher. This teacher is associated with existing records.';
        } else {
            req.session.error = 'Error deleting teacher: ' + error.message;
        }
        
        res.redirect('/all-teachers');
    }
});



router.get('/add-class', authenticate, requireRole('admin'), (req, res) => {
    return res.redirect('/all-classes');
});

router.post('/add-class', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const {
        className,
        classCode,
        professorId,
        maximumStudents,
        level,
        department,
        autoAllDepartments
    } = req.body;

    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Validate required fields
        if (!className || !className.trim() || !classCode || !classCode.trim() || !professorId || !level) {
            req.session.error = 'Class Name, Class Code, Level and Teacher are required fields';
            return res.redirect('/all-classes');
        }

        const isSeniorSecondary = level === 'SENIOR SECONDARY';
        const isAllDepartments = isSeniorSecondary && (
            department === 'ALL' || 
            autoAllDepartments === '1' || 
            autoAllDepartments === 'true' || 
            autoAllDepartments === true
        );

        // Validate department for Senior Secondary if not auto all departments
        if (isSeniorSecondary && !isAllDepartments && !department) {
            req.session.error = 'Department is required for Senior Secondary (or choose all 3 departments)';
            return res.redirect('/all-classes');
        }

        // Verify teacher exists
        let teacherQuery = 'SELECT firstName, lastName FROM teachers WHERE id = ?';
        let teacherParams = [professorId];
        if (schoolId) {
            teacherQuery += ' AND (school_id = ? OR school_id IS NULL)';
            teacherParams.push(schoolId);
        }
        let [teacher] = await connection.execute(teacherQuery, teacherParams);

        if (teacher.length === 0) {
            const [fallbackTeacher] = await connection.execute('SELECT firstName, lastName FROM teachers WHERE id = ?', [professorId]);
            if (fallbackTeacher.length > 0) {
                teacher = fallbackTeacher;
            }
        }

        if (teacher.length === 0) {
            req.session.error = 'Selected teacher does not exist';
            return res.redirect('/all-classes');
        }

        const professorName = `${teacher[0].firstName} ${teacher[0].lastName}`;
        const baseClassName = className.trim();
        const baseClassCode = classCode.trim().toUpperCase();
        const maxCapacity = maximumStudents ? parseInt(maximumStudents) : null;

        if (isAllDepartments) {
            // Automatically register for all 3 departments: Science, Commercial, Art
            const depts = [
                { name: 'Science', dept: 'SCIENCE', suffix: 'SCI' },
                { name: 'Commercial', dept: 'COMMERCIAL', suffix: 'COMM' },
                { name: 'Art', dept: 'ART', suffix: 'ART' }
            ];

            // Check if any code already exists
            for (const item of depts) {
                const finalCode = `${baseClassCode}-${item.suffix}`;
                let checkQuery = 'SELECT id FROM classes WHERE classCode = ?';
                let checkParams = [finalCode];
                if (schoolId) {
                    checkQuery += ' AND (school_id = ? OR school_id IS NULL)';
                    checkParams.push(schoolId);
                }
                const [existing] = await connection.execute(checkQuery, checkParams);
                if (existing.length > 0) {
                    req.session.error = `A class with code "${finalCode}" already exists. Please choose a different Class Code.`;
                    return res.redirect('/all-classes');
                }
            }

            // Insert the 3 classes in a transaction
            await connection.beginTransaction();
            try {
                for (const item of depts) {
                    // e.g. "SSS 2 Science", "SSS 2 Commercial", "SSS 2 Art"
                    const finalName = baseClassName.toLowerCase().includes(item.name.toLowerCase())
                        ? baseClassName
                        : `${baseClassName} ${item.name}`;
                    const finalCode = `${baseClassCode}-${item.suffix}`;

                    await connection.execute(
                        `INSERT INTO classes 
                        (className, classCode, professorName, professorId, maximumStudents, level, department, school_id) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            finalName,
                            finalCode,
                            professorName,
                            professorId,
                            maxCapacity,
                            level,
                            item.dept,
                            schoolId
                        ]
                    );
                }
                await connection.commit();
                req.session.success = `Successfully registered 3 senior secondary classes: "${baseClassName} Science", "${baseClassName} Commercial", and "${baseClassName} Art".`;
                return res.redirect('/all-classes');
            } catch (txErr) {
                await connection.rollback();
                throw txErr;
            }

        } else {
            // Single class registration
            const finalDept = isSeniorSecondary ? department.trim().toUpperCase() : null;

            // Check if class code exists
            let checkQuery = 'SELECT id FROM classes WHERE classCode = ?';
            let checkParams = [baseClassCode];
            if (schoolId) {
                checkQuery += ' AND (school_id = ? OR school_id IS NULL)';
                checkParams.push(schoolId);
            }
            const [existing] = await connection.execute(checkQuery, checkParams);
            if (existing.length > 0) {
                req.session.error = `A class with code "${baseClassCode}" already exists. Please choose a different Class Code.`;
                return res.redirect('/all-classes');
            }

            await connection.execute(
                `INSERT INTO classes 
                (className, classCode, professorName, professorId, maximumStudents, level, department, school_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    baseClassName,
                    baseClassCode,
                    professorName,
                    professorId,
                    maxCapacity,
                    level,
                    finalDept,
                    schoolId
                ]
            );

            req.session.success = `Class "${baseClassName}" added successfully.`;
            return res.redirect('/all-classes');
        }

    } catch (error) {
        console.error('Error adding class:', error);
        let errMsg = error.message;
        if (error.code === 'ER_DUP_ENTRY') {
            errMsg = 'A class with this code or details already exists';
        }
        req.session.error = 'Failed to add class: ' + errMsg;
        return res.redirect('/all-classes');
    }
});

router.get('/all-classes', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
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
                totalCount = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
            totalCount = 0;
            notifications = [];
        }

        // If an admin user is not linked to a school, do NOT show global data
        if (!schoolId) {
            return res.render('all-classes', {
                classes: [],
                teachers: [],
                error: 'Your admin account is not linked to a school. Please contact support/admin to fix your school setup.',
                username: username,
                unreadCount: unreadCount,
                totalCount: totalCount,
                notifications: notifications
            });
        }

        const [teachers] = await connection.execute(
            'SELECT id, firstName, lastName FROM teachers WHERE school_id = ? ORDER BY firstName, lastName',
            [schoolId]
        );

        const [classes] = await connection.execute(`
            SELECT 
                id, 
                className, 
                level,
                department,
                classCode,
                professorName,
                professorId,
                maximumStudents
            FROM classes
            WHERE school_id = ?
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `, [schoolId]);

        const success = req.session.success || null;
        const error = req.session.error || null;
        delete req.session.success;
        delete req.session.error;

        res.render('all-classes', {
            classes: classes,
            teachers: teachers || [],
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            success: success,
            error: error
        });

    } catch (error) {
        console.error('Error fetching classes:', error);
        const errorMsg = req.session.error || 'Failed to load classes';
        delete req.session.error;
        res.render('all-classes', {
            classes: [],
            teachers: [],
            error: errorMsg,
            success: null,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: []
        });
    }
});

// Helper to get teachers for class dropdown
async function getTeachersForDropdown(connection, schoolId) {
    if (schoolId) {
        const [teachers] = await connection.execute(
            'SELECT id, firstName, lastName FROM teachers WHERE school_id = ? ORDER BY firstName, lastName',
            [schoolId]
        );
        return teachers;
    } else {
        const [teachers] = await connection.execute(
            'SELECT id, firstName, lastName FROM teachers ORDER BY firstName, lastName'
        );
        return teachers;
    }
}

// Helper to validate class input data
function validateClassData(data, isEdit = false) {
    const errors = [];
    if (!data.className || !data.className.trim()) {
        errors.push('Class Name is required');
    }
    if (!data.classCode || !data.classCode.trim()) {
        errors.push('Class Code is required');
    }
    if (!data.level || !data.level.trim()) {
        errors.push('Level is required');
    }
    if (!data.professorId) {
        errors.push('Class Teacher is required');
    }
    if (data.level === 'SENIOR SECONDARY' && (!data.department || !data.department.trim())) {
        errors.push('Department is required for Senior Secondary');
    }
    return errors;
}

// GET route to display edit class form
router.get('/edit-class/:id', authenticate, requireRole('admin'), async (req, res) => {
    const classId = req.params.id;
    const schoolId = req.session.schoolId || null;
    const username = req.session.username || 'Admin';

    try {
        const connection = await getConnection();
        
        // Get class details
        let classQuery = 'SELECT * FROM classes WHERE id = ?';
        let classParams = [classId];
        if (schoolId) {
            classQuery += ' AND (school_id = ? OR school_id IS NULL)';
            classParams.push(schoolId);
        }
        let [classes] = await connection.execute(classQuery, classParams);

        if (classes.length === 0 && schoolId) {
            // fallback: check without school filter in case schoolId was unset on class
            const [fallbackClasses] = await connection.execute('SELECT * FROM classes WHERE id = ?', [classId]);
            if (fallbackClasses.length > 0) {
                classes = fallbackClasses;
            }
        }

        if (classes.length === 0) {
            req.session.error = 'Class not found';
            return res.redirect('/all-classes');
        }

        const classData = classes[0];
        
        // Get all teachers for dropdown
        const teachers = await getTeachersForDropdown(connection, schoolId);
        
        // Get available departments based on level
        let deptQuery = 'SELECT DISTINCT department FROM classes WHERE department IS NOT NULL AND department != ""';
        let deptParams = [];
        if (schoolId) {
            deptQuery += ' AND (school_id = ? OR school_id IS NULL)';
            deptParams.push(schoolId);
        }
        const [departments] = await connection.execute(deptQuery, deptParams);

        // Get student count for this class
        let studentCount = 0;
        try {
            const [studentRows] = await connection.execute(
                'SELECT COUNT(*) as count FROM students WHERE classId = ?',
                [classId]
            );
            studentCount = studentRows[0]?.count || 0;
        } catch (scErr) {
            console.error('Error counting students for class:', scErr.message);
        }

        // Get notifications and topbar counts
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];
        try {
            const adminId = req.session.userId;
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);
            if (tableCheck[0].count > 0 && adminId) {
                const [unreadResult] = await connection.execute(
                    'SELECT COUNT(*) as count FROM admin_notifications WHERE admin_id = ? AND is_read = 0',
                    [adminId]
                );
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(
                    'SELECT COUNT(*) as total FROM admin_notifications WHERE admin_id = ?',
                    [adminId]
                );
                totalCount = totalResult[0]?.total || 0;

                const [notificationList] = await connection.execute(
                    `SELECT id, message, is_read, 
                            DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                     FROM admin_notifications 
                     WHERE admin_id = ?
                     ORDER BY created_at DESC 
                     LIMIT 10`,
                    [adminId]
                );
                notifications = notificationList;
            }
        } catch (notifErr) {
            console.error('Error fetching notifications for edit-class:', notifErr.message);
        }

        const success = req.session.success || null;
        const error = req.session.error || null;
        delete req.session.success;
        delete req.session.error;

        res.render('edit-class', {
            teachers: teachers || [],
            classData: classData,
            departments: departments || [],
            studentCount: studentCount,
            moment: moment,
            error: error,
            success: success,
            mode: 'edit',
            classId: classId,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications
        });
    } catch (error) {
        console.error('Error fetching class for edit:', error);
        req.session.error = 'Error loading class data: ' + error.message;
        res.redirect('/all-classes');
    }
});

// POST route to update class
router.post('/edit-class/:id', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const classId = req.params.id;
    const schoolId = req.session.schoolId || null;
    const username = req.session.username || 'Admin';
    const {
        className,
        classCode,
        professorId,
        maximumStudents,
        level,
        department
    } = req.body;

    let connection;
    try {
        connection = await getConnection();
        const teachers = await getTeachersForDropdown(connection, schoolId);

        // Validate input
        const errors = validateClassData(req.body, true);
        if (errors.length > 0) {
            const [classData] = await connection.execute(
                'SELECT * FROM classes WHERE id = ?', 
                [classId]
            );
            
            return res.render('edit-class', {
                teachers: teachers,
                classData: { ...(classData[0] || {}), ...req.body },
                departments: [],
                studentCount: 0,
                moment: moment,
                error: errors.join(', '),
                success: null,
                mode: 'edit',
                classId: classId,
                username: username,
                unreadCount: 0,
                totalCount: 0,
                notifications: []
            });
        }

        // Check if class code already exists (excluding current class)
        let codeQuery = 'SELECT id FROM classes WHERE classCode = ? AND id != ?';
        let codeParams = [classCode.trim().toUpperCase(), classId];
        if (schoolId) {
            codeQuery += ' AND (school_id = ? OR school_id IS NULL)';
            codeParams.push(schoolId);
        }
        const [existingClass] = await connection.execute(codeQuery, codeParams);
        
        if (existingClass.length > 0) {
            const [classData] = await connection.execute(
                'SELECT * FROM classes WHERE id = ?', 
                [classId]
            );
            
            return res.render('edit-class', {
                teachers: teachers,
                classData: { ...(classData[0] || {}), ...req.body },
                departments: [],
                studentCount: 0,
                moment: moment,
                error: 'A class with this code already exists',
                success: null,
                mode: 'edit',
                classId: classId,
                username: username,
                unreadCount: 0,
                totalCount: 0,
                notifications: []
            });
        }

        // Verify teacher exists and get teacher name
        let teacherQuery = 'SELECT firstName, lastName FROM teachers WHERE id = ?';
        let teacherParams = [professorId];
        if (schoolId) {
            teacherQuery += ' AND (school_id = ? OR school_id IS NULL)';
            teacherParams.push(schoolId);
        }
        let [teacher] = await connection.execute(teacherQuery, teacherParams);
        
        if (teacher.length === 0) {
            const [fallbackTeacher] = await connection.execute('SELECT firstName, lastName FROM teachers WHERE id = ?', [professorId]);
            if (fallbackTeacher.length > 0) {
                teacher = fallbackTeacher;
            }
        }

        if (teacher.length === 0) {
            const [classData] = await connection.execute(
                'SELECT * FROM classes WHERE id = ?', 
                [classId]
            );
            
            return res.render('edit-class', {
                teachers: teachers,
                classData: { ...(classData[0] || {}), ...req.body },
                departments: [],
                studentCount: 0,
                moment: moment,
                error: 'Selected teacher does not exist',
                success: null,
                mode: 'edit',
                classId: classId,
                username: username,
                unreadCount: 0,
                totalCount: 0,
                notifications: []
            });
        }

        const professorName = `${teacher[0].firstName} ${teacher[0].lastName}`;

        // Start transaction to check if update affects related records
        await connection.beginTransaction();

        try {
            // Check if class has students
            const [studentCount] = await connection.execute(
                'SELECT COUNT(*) as count FROM students WHERE classId = ?',
                [classId]
            );

            // Check if updated_at exists in classes table
            const hasUpdatedAt = await tableHasColumn(connection, 'classes', 'updated_at');

            // Update class
            let updateSql = `UPDATE classes SET 
                className = ?, 
                classCode = ?, 
                professorName = ?, 
                professorId = ?, 
                maximumStudents = ?, 
                level = ?, 
                department = ?`;
            if (hasUpdatedAt) {
                updateSql += `, updated_at = NOW()`;
            }
            updateSql += ` WHERE id = ?`;
            const updateParams = [
                className.trim(),
                classCode.trim().toUpperCase(),
                professorName,
                professorId,
                maximumStudents ? parseInt(maximumStudents) : null,
                level,
                level === 'SENIOR SECONDARY' ? department : null,
                classId
            ];
            if (schoolId) {
                updateSql += ` AND (school_id = ? OR school_id IS NULL)`;
                updateParams.push(schoolId);
            }

            const [result] = await connection.execute(updateSql, updateParams);

            // If level changed and there are students, log note
            if (studentCount[0]?.count > 0) {
                const [oldClass] = await connection.execute(
                    'SELECT level FROM classes WHERE id = ?',
                    [classId]
                );
                if (oldClass[0] && oldClass[0].level !== level) {
                    console.log(`Class level changed from ${oldClass[0].level} to ${level} while having ${studentCount[0].count} students`);
                }
            }

            await connection.commit();

            req.session.success = 'Class updated successfully';
            return res.redirect('/all-classes');

        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

    } catch (error) {
        console.error('Error updating class:', error);
        
        let teachers = [];
        let classData = [{}];
        try {
            if (!connection) connection = await getConnection();
            teachers = await getTeachersForDropdown(connection, schoolId);
            const [cd] = await connection.execute(
                'SELECT * FROM classes WHERE id = ?', 
                [classId]
            );
            classData = cd;
        } catch (fetchErr) {
            console.error('Error fetching class data on error:', fetchErr);
        }
        
        let errorMsg = error.message;
        if (error.code === 'ER_DUP_ENTRY') {
            if (error.sqlMessage && error.sqlMessage.includes('classCode')) {
                errorMsg = 'Class code already exists';
            } else {
                errorMsg = 'A class with these details already exists';
            }
        }
        
        res.render('edit-class', {
            teachers: teachers,
            classData: { ...(classData[0] || {}), ...req.body },
            departments: [],
            studentCount: 0,
            moment: moment,
            error: 'Failed to update class: ' + errorMsg,
            success: null,
            mode: 'edit',
            classId: classId,
            username: username,
            unreadCount: 0,
            totalCount: 0,
            notifications: []
        });
    }
});

// Alias for about-class to navigate to edit-class
router.get('/about-class/:id', authenticate, requireRole('admin'), (req, res) => {
    res.redirect(`/edit-class/${req.params.id}`);
});

// API endpoint to get student count for a class
router.get('/api/student-count/:classId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute(
            'SELECT COUNT(*) as count FROM students WHERE classId = ?',
            [req.params.classId]
        );
        res.json({ count: rows[0]?.count || 0 });
    } catch (err) {
        console.error('Error in /api/student-count:', err);
        res.json({ count: 0 });
    }
});

// API endpoint to get subjects for a class
router.get('/api/class-subjects/:classId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const classId = req.params.classId;
        let subjects = [];
        try {
            const [rows] = await connection.execute(
                `SELECT s.id, s.name, s.subject_code as code 
                 FROM class_subjects cs 
                 JOIN subjects s ON cs.subject_id = s.id 
                 WHERE cs.class_id = ? 
                 ORDER BY s.name`,
                [classId]
            );
            subjects = rows;
        } catch (e1) {
            try {
                const [rows] = await connection.execute(
                    `SELECT id, subjectName as name, subjectCode as code 
                     FROM class_subjects 
                     WHERE classId = ? 
                     ORDER BY subjectName`,
                    [classId]
                );
                subjects = rows;
            } catch (e2) {
                console.error('Error fetching class subjects:', e2.message);
            }
        }
        res.json({ subjects });
    } catch (err) {
        console.error('Error in /api/class-subjects:', err);
        res.json({ subjects: [] });
    }
});

// API endpoint for recent class activity
router.get('/api/class-activity/:classId', authenticate, requireRole('admin'), async (req, res) => {
    res.json({ activities: [] });
});

// GET route to delete class - Updated with proper checks
router.get('/delete-class/:id', authenticate, requireRole('admin'), async (req, res) => {
    const classId = req.params.id;

    try {
        const connection = await getConnection();
        
        // Check if class exists
        const [classes] = await connection.execute(
            'SELECT className, classCode FROM classes WHERE id = ? AND school_id = ?',
            [classId, req.session.schoolId || null]
        );
        
        if (classes.length === 0) {
            req.session.error = 'Class not found';
            return res.redirect('/all-classes');
        }

        const className = classes[0].className;
        const classCode = classes[0].classCode;

        // Check if class has students
        const [studentCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM students WHERE classId = ?',
            [classId]
        );

        if (studentCount[0].count > 0) {
            req.session.error = `Cannot delete class ${className}. It has ${studentCount[0].count} student(s) enrolled.`;
            return res.redirect('/all-classes');
        }

        // Check if class has subjects assigned
        const [subjectCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM class_subjects WHERE class_id = ?',
            [classId]
        );

        if (subjectCount[0].count > 0) {
            req.session.error = `Cannot delete class ${className}. It has subjects assigned to it.`;
            return res.redirect('/all-classes');
        }

        // Check if class has attendance records
        const [attendanceCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM attendance_records WHERE class_id = ?',
            [classId]
        );

        if (attendanceCount[0].count > 0) {
            req.session.error = `Cannot delete class ${className}. It has attendance records.`;
            return res.redirect('/all-classes');
        }

        // If all checks pass, delete the class
        await connection.execute(
            'DELETE FROM classes WHERE id = ? AND school_id = ?',
            [classId, req.session.schoolId || null]
        );

        req.session.success = `Class ${className} (${classCode}) deleted successfully`;
        res.redirect('/all-classes');

    } catch (error) {
        console.error('Error deleting class:', error);
        
        // Handle foreign key constraint errors
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            req.session.error = 'Cannot delete class. It is referenced by other records in the system.';
        } else {
            req.session.error = 'Error deleting class: ' + error.message;
        }
        
        res.redirect('/all-classes');
    }
});


// Staff Routes
router.get('/all-staff', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
        const [staff] = staffHasSchoolId
            ? await connection.execute('SELECT * FROM staff WHERE school_id = ?', [schoolId])
            : await connection.execute('SELECT * FROM staff');

        res.render('all-staff', {
            staff: staff,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.render('all-staff', {
            staff: [],
            error: 'Failed to load staff.',
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

router.get('/add-staff', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        res.render('add-staff', {
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error loading add staff form:', error);
        res.render('add-staff', {
            error: 'Failed to load form',
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

router.post('/add-staff', authenticate, requireRole('admin'), uploadWithFile.single('image'), async (req, res) => {
    const {
        firstName,
        lastName,
        gender,
        dateOfBirth,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address,
        email,
        position,
        department,
        phone,
        joiningDate
    } = req.body;
    
    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'position', 'department', 'phone'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            return res.render('add-staff', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                formData: req.body
            });
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
        let imagePath = req.file ? '/images/staff/' + req.file.filename : null;
        
        // Format dates
        let formattedDateOfBirth = null;
        let formattedJoiningDate = null;
        
        try {
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid()
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            return res.render('add-staff', { 
                error: 'Invalid date format. Please use the correct date format.',
                formData: req.body
            });
        }

        if (staffHasSchoolId) {
            await connection.execute(
                `INSERT INTO staff 
                (firstName, lastName, gender, dateOfBirth, nationality, stateOfOrigin, 
                localGovernment, residentialState, residentialLGA, emergencyContactName, 
                emergencyContactNumber, address, email, position, department, phone, 
                joiningDate, imagePath, school_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    firstName,
                    lastName,
                    gender || null,
                    formattedDateOfBirth,
                    nationality || null,
                    stateOfOrigin || null,
                    localGovernment || null,
                    residentialState || null,
                    residentialLGA || null,
                    emergencyContactName || null,
                    emergencyContactNumber || null,
                    address || null,
                    email,
                    position,
                    department,
                    phone,
                    formattedJoiningDate,
                    imagePath,
                    schoolId
                ]
            );
        } else {
            await connection.execute(
                `INSERT INTO staff 
                (firstName, lastName, gender, dateOfBirth, nationality, stateOfOrigin, 
                localGovernment, residentialState, residentialLGA, emergencyContactName, 
                emergencyContactNumber, address, email, position, department, phone, 
                joiningDate, imagePath) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    firstName,
                    lastName,
                    gender || null,
                    formattedDateOfBirth,
                    nationality || null,
                stateOfOrigin || null,
                localGovernment || null,
                residentialState || null,
                residentialLGA || null,
                emergencyContactName || null,
                emergencyContactNumber || null,
                address || null,
                email,
                position,
                department,
                phone,
                formattedJoiningDate,
                imagePath
                ]
            );
        }
        
        req.session.success = 'Staff member added successfully';
        res.redirect('/all-staff');
    } catch (error) {
        console.error('Error adding staff:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.render('add-staff', { 
                error: 'Email already exists',
                formData: req.body
            });
        }
        
        res.render('add-staff', { 
            error: 'Failed to add staff. Please try again. Error: ' + error.message,
            formData: req.body
        });
    }
});

// Add edit staff route
router.get('/edit-staff/:id', authenticate, requireRole('admin'), async (req, res) => {
    const staffId = req.params.id;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
        const [staff] = staffHasSchoolId
            ? await connection.execute('SELECT * FROM staff WHERE id = ? AND school_id = ?', [staffId, schoolId])
            : await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
        
        if (staff.length === 0) {
            req.session.error = 'Staff member not found';
            return res.redirect('/all-staff');
        }
        
        res.render('edit-staff', { staff: staff[0] });
    } catch (error) {
        console.error('Error fetching staff:', error);
        req.session.error = 'Error loading staff details';
        res.redirect('/all-staff');
    }
});

router.post('/edit-staff/:id', authenticate, requireRole('admin'), uploadWithFile.single('image'), async (req, res) => {
    const staffId = req.params.id;
    const {
        firstName,
        lastName,
        gender,
        dateOfBirth,
        nationality,
        stateOfOrigin,
        localGovernment,
        residentialState,
        residentialLGA,
        emergencyContactName,
        emergencyContactNumber,
        address,
        email,
        position,
        department,
        phone,
        joiningDate
    } = req.body;
    
    try {
        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'position', 'department', 'phone'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!req.body[field] || req.body[field].trim() === '') {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
            const [staff] = staffHasSchoolId
                ? await connection.execute('SELECT * FROM staff WHERE id = ? AND school_id = ?', [staffId, schoolId])
                : await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: `Missing required fields: ${missingFields.join(', ')}`,
                staff: staff[0] || {}
            });
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
        
        // Check if new image was uploaded
        let imagePath = null;
        if (req.file) {
            imagePath = '/images/staff/' + req.file.filename;
            
            // Get old image path to delete it later
            const [currentStaff] = staffHasSchoolId
                ? await connection.execute('SELECT imagePath FROM staff WHERE id = ? AND school_id = ?', [staffId, schoolId])
                : await connection.execute('SELECT imagePath FROM staff WHERE id = ?', [staffId]);
            const oldImagePath = currentStaff[0]?.imagePath;
            
            // Delete old image file if it exists
            if (oldImagePath) {
                const fs = require('fs');
                const path = require('path');
                const oldImageFullPath = path.join(__dirname, 'public', oldImagePath);
                
                if (fs.existsSync(oldImageFullPath)) {
                    fs.unlinkSync(oldImageFullPath);
                }
            }
        }
        
        // Format dates
        let formattedDateOfBirth = null;
        let formattedJoiningDate = null;
        
        try {
            if (dateOfBirth) {
                formattedDateOfBirth = moment(dateOfBirth, 'YYYY-MM-DD').isValid()
                    ? moment(dateOfBirth, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
            
            if (joiningDate) {
                formattedJoiningDate = moment(joiningDate, 'YYYY-MM-DD').isValid()
                    ? moment(joiningDate, 'YYYY-MM-DD').format('YYYY-MM-DD')
                    : null;
            }
        } catch (dateError) {
            console.error('Date formatting error:', dateError);
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
            const [staff] = staffHasSchoolId
                ? await connection.execute('SELECT * FROM staff WHERE id = ? AND school_id = ?', [staffId, schoolId])
                : await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: 'Invalid date format. Please use the correct date format.',
                staff: staff[0] || {}
            });
        }

        // Build update query based on whether image was uploaded
        let query, params;
        if (imagePath) {
            query = `UPDATE staff SET 
                firstName = ?, lastName = ?, gender = ?, dateOfBirth = ?, nationality = ?, 
                stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?, 
                emergencyContactName = ?, emergencyContactNumber = ?, address = ?, email = ?, 
                position = ?, department = ?, phone = ?, joiningDate = ?, imagePath = ? 
                WHERE id = ?${staffHasSchoolId ? ' AND school_id = ?' : ''}`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                imagePath, staffId
            ];
            if (staffHasSchoolId) params.push(schoolId);
        } else {
            query = `UPDATE staff SET 
                firstName = ?, lastName = ?, gender = ?, dateOfBirth = ?, nationality = ?, 
                stateOfOrigin = ?, localGovernment = ?, residentialState = ?, residentialLGA = ?, 
                emergencyContactName = ?, emergencyContactNumber = ?, address = ?, email = ?, 
                position = ?, department = ?, phone = ?, joiningDate = ? 
                WHERE id = ?${staffHasSchoolId ? ' AND school_id = ?' : ''}`;
            params = [
                firstName, lastName, gender || null, formattedDateOfBirth, nationality || null,
                stateOfOrigin || null, localGovernment || null, residentialState || null,
                residentialLGA || null, emergencyContactName || null, emergencyContactNumber || null,
                address || null, email, position, department, phone, formattedJoiningDate,
                staffId
            ];
            if (staffHasSchoolId) params.push(schoolId);
        }

        const [result] = await connection.execute(query, params);

        if (result.affectedRows === 0) {
            req.session.error = 'Staff member not found or no changes made';
        } else {
            req.session.success = 'Staff member updated successfully';
        }
        
        res.redirect('/all-staff');
    } catch (error) {
        console.error('Error updating staff:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            const staffHasSchoolId = await tableHasColumn(connection, 'staff', 'school_id');
            const [staff] = staffHasSchoolId
                ? await connection.execute('SELECT * FROM staff WHERE id = ? AND school_id = ?', [staffId, schoolId])
                : await connection.execute('SELECT * FROM staff WHERE id = ?', [staffId]);
            return res.render('edit-staff', { 
                error: 'Email already exists',
                staff: staff[0] || {}
            });
        }
        
        req.session.error = 'Error updating staff member: ' + error.message;
        res.redirect('/all-staff');
    }
});
// Fees Routes



// GET route to display add fees form
router.get('/api/terms/:academicYearId', authenticate, async (req, res) => {
    const { academicYearId } = req.params;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');
        
        const [terms] = academicTermsHaveSchoolId
            ? await connection.execute(
                `SELECT id, term_name, is_current 
                 FROM academic_terms 
                 WHERE academic_year_id = ? AND school_id = ?
                 ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END`,
                [academicYearId, schoolId]
            )
            : await connection.execute(
                `SELECT id, term_name, is_current 
                 FROM academic_terms 
                 WHERE academic_year_id = ? 
                 ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END`,
                [academicYearId]
            );
        
        res.json(terms);
        
    } catch (error) {
        console.error('Error fetching terms:', error);
        res.status(500).json({ error: 'Failed to fetch terms' });
    }
});

// Record fee payment for a specific student (opened from All Students → Fee action)
// Record fee payment for a specific student (opened from All Students → Fee action)
router.get('/add-fees/:studentId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const studentId = parseInt(req.params.studentId, 10);
        if (!Number.isFinite(studentId)) {
            return res.redirect('/all-students');
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        
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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
        
        const academicYearsHaveSchoolId = await tableHasColumn(connection, 'academic_years', 'school_id');
        const academicTermsHaveSchoolId = await tableHasColumn(connection, 'academic_terms', 'school_id');

        const [studentRows] = await connection.execute(`
            SELECT 
                s.id,
                s.firstName,
                s.middleName,
                s.lastName,
                s.email,
                s.classId,
                c.className,
                c.department AS classDepartment
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.id = ? AND s.school_id = ?
        `, [studentId, schoolId]);

        if (studentRows.length === 0) {
            req.session.error = 'Student not found or access denied.';
            return res.redirect('/all-students');
        }

        const selectedStudent = studentRows[0];

        // Get academic years
        const [academicYears] = academicYearsHaveSchoolId
            ? await connection.execute(
                `SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC`,
                [schoolId]
            )
            : await connection.execute(`SELECT * FROM academic_years ORDER BY start_date DESC`);
        
        // Get current academic year
        const [currentAcademicYear] = academicYearsHaveSchoolId
            ? await connection.execute(
                `SELECT * FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1`,
                [schoolId]
            )
            : await connection.execute(`SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1`);
        
        // Get terms for the current academic year
        let terms = [];
        if (currentAcademicYear.length > 0) {
            [terms] = academicTermsHaveSchoolId
                ? await connection.execute(
                    `SELECT * FROM academic_terms 
                     WHERE academic_year_id = ? AND school_id = ?
                     ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END`,
                    [currentAcademicYear[0].id, schoolId]
                )
                : await connection.execute(
                    `SELECT * FROM academic_terms 
                     WHERE academic_year_id = ? 
                     ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END`,
                    [currentAcademicYear[0].id]
                );
        }
        
        // Get distinct fee types from class bills
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
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

        res.render('add-fees', {
            selectedStudent,
            feeTypes: feeTypes,
            paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '',
            school: school,
            formData: {},
            success: req.query.success === '1' ? 'Fee payment recorded successfully.' : null,
            error: null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });
    } catch (error) {
        console.error('Error loading add fees form:', error);
        res.render('add-fees', {
            selectedStudent: null,
            feeTypes: [],
            paymentTypes: [],
            academicYears: [],
            terms: [],
            currentAcademicYear: '',
            school: {
                name: "Excel College",
                address: "12 Education Road, Lagos, Nigeria",
                email: "info@excelcollege.edu.ng",
                phone: "+234 812 345 6789",
                website: "www.excelcollege.edu.ng"
            },
            formData: {},
            success: null,
            error: 'Failed to load form data',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// Opening /add-fees without a student redirects to the student list (fees are recorded per student from there)
router.get('/add-fees', authenticate, requireRole('admin'), (req, res) => {
    res.redirect('/all-students');
});

// Get bill amount for specific criteria
router.post('/get-bill-amount', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    try {
        const { studentId, feeType, academicYear, term } = req.body;
        
        if (!studentId || !feeType || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters'
            });
        }
        
        const connection = await getConnection();
        
        // Get student's class first
        const [studentData] = await connection.execute(
            'SELECT classId FROM students WHERE id = ?',
            [studentId]
        );
        
        if (studentData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Student not found'
            });
        }
        
        const classId = studentData[0].classId;
        
        // Get bill amount
        const [bills] = await connection.execute(`
            SELECT amount FROM class_bills 
            WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [classId, feeType, academicYear, term]);
        
        if (bills.length > 0) {
            res.json({
                success: true,
                amount: bills[0].amount,
                hasBill: true
            });
        } else {
            // Check if fee type exists at all
            const [feeTypeCheck] = await connection.execute(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = ? AND is_active = 1 LIMIT 1
            `, [feeType]);
            
            if (feeTypeCheck.length === 0) {
                res.json({
                    success: false,
                    error: `Fee type "${feeType}" is not configured in the system.`,
                    hasBill: false
                });
            } else {
                res.json({
                    success: false,
                    error: 'No bill found for the selected criteria',
                    hasBill: false
                });
            }
        }
    } catch (error) {
        console.error('Error fetching bill amount:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch bill amount'
        });
    }
});

// POST route to handle fee payment submission
router.post('/add-fees', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { studentId, feeType, paymentType, amount, academicYear, term, paymentDate, notes } = req.body;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        let selectedStudentRow = null;
        if (studentId) {
            const [sr] = await connection.execute(`
                SELECT
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.email,
                    s.classId,
                    c.className,
                    c.department AS classDepartment
                FROM students s
                LEFT JOIN classes c ON s.classId = c.id
                WHERE s.id = ? AND s.school_id = ?
            `, [studentId, schoolId]);
            selectedStudentRow = sr[0] || null;
        }

        // Get academic years for the form in case of error
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year
        let terms = [];
        const [selectedYear] = await connection.execute(
            'SELECT id FROM academic_years WHERE year_name = ?',
            [academicYear]
        );
        
        if (selectedYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [selectedYear[0].id]);
        }
        
        // Get distinct fee types from class bills for form repopulation
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
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

        // Validate required fields
        const errors = [];
        if (!studentId) errors.push('Student');
        if (!feeType) errors.push('Fee Type');
        if (!paymentType) errors.push('Payment Type');
        if (!amount) errors.push('Amount');
        if (!academicYear) errors.push('Academic Year');
        if (!term) errors.push('Term');
        if (!paymentDate) errors.push('Payment Date');

        if (errors.length > 0) {
            return res.render('add-fees', {
                selectedStudent: selectedStudentRow,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                success: null,
                error: `Missing required fields: ${errors.join(', ')}`
            });
        }

        // Validate amount is a valid number
        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
            return res.render('add-fees', {
                selectedStudent: selectedStudentRow,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                success: null,
                error: 'Please enter a valid amount in Naira'
            });
        }

        // Get student's actual details from database including classId and admission_number
        const [studentData] = await connection.execute(`
            SELECT 
                s.firstName, s.middleName, s.lastName, s.email, s.classId, s.admission_number,
                c.className, c.department 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.id = ? AND s.school_id = ?`,
            [studentId, schoolId]
        );
        
        if (studentData.length === 0) {
            return res.render('add-fees', {
                selectedStudent: selectedStudentRow,
                feeTypes: feeTypes,
                paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: academicYear,
                school: school,
                formData: req.body,
                success: null,
                error: 'Selected student not found'
            });
        }

        const student = studentData[0];
        const studentName = studentDisplayName(student);
        const studentClass = student.className || 'Not assigned';
        const studentDepartment = student.department || '';
        const studentEmail = student.email || '';
        const admissionNumber = student.admission_number || '';
        
        // Check if there's a class bill for this fee type
        const [classBills] = await connection.execute(`
            SELECT amount FROM class_bills 
            WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [student.classId, feeType, academicYear, term]);
        
        let billAmount = 0;
        let hasBill = false;
        
        if (classBills.length > 0) {
            hasBill = true;
            billAmount = parseFloat(classBills[0].amount);
        } else {
            // If no bill found, check if fee type exists in class bills at all
            const [feeTypeCheck] = await connection.execute(`
                SELECT fee_type FROM class_bills 
                WHERE fee_type = ? AND is_active = 1 LIMIT 1
            `, [feeType]);
            
            if (feeTypeCheck.length === 0) {
                return res.render('add-fees', {
                    selectedStudent: selectedStudentRow,
                    feeTypes: feeTypes,
                    paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
                    academicYears: academicYears,
                    terms: terms,
                    currentAcademicYear: academicYear,
                    school: school,
                    formData: req.body,
                    success: null,
                    error: `Fee type "${feeType}" is not configured in the system. Please contact administrator.`
                });
            }
        }
        
        // Calculate total amount paid so far for this fee type, term, and academic year
        const [previousPayments] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid, SUM(balance) as totalBalance 
            FROM fees 
            WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
        `, [studentId, feeType, academicYear, term]);
        
        const totalPaidSoFar = parseFloat(previousPayments[0].totalPaid) || 0;
        const currentBalance = parseFloat(previousPayments[0].totalBalance) || 0;
        
        // Check if this is a subsequent payment for the same fee type
        const isSubsequentPayment = totalPaidSoFar > 0;
        
        // Calculate remaining balance and new payment details
        let amountPaid = amountValue;
        let balance = 0;
        let status = 'paid';
        let notificationType = 'success';
        
        if (hasBill) {
            const totalAmountDue = billAmount;
            const totalPaidAfterThisPayment = totalPaidSoFar + amountValue;
            
            if (totalPaidAfterThisPayment < totalAmountDue) {
                // Partial payment - still owes more
                status = 'partial';
                balance = totalAmountDue - totalPaidAfterThisPayment;
            } else if (totalPaidAfterThisPayment > totalAmountDue) {
                // Overpayment - student paid more than required
                status = 'overpaid';
                balance = -(totalPaidAfterThisPayment - totalAmountDue); // Negative balance indicates overpayment
                amountPaid = totalAmountDue - totalPaidSoFar; // Adjust amount paid to avoid over-crediting
            } else {
                // Exact payment - fully paid
                status = 'paid';
                balance = 0;
            }
        } else {
            // No bill exists, use the entered amount
            status = 'paid';
            balance = 0;
        }
        
        // Format payment date
        const formattedPaymentDate = moment(paymentDate, 'YYYY-MM-DD').format('YYYY-MM-DD');
        
        // Generate receipt number
        const receiptNumber = 'REC-' + Date.now();
        
        // Insert fee payment
        await connection.execute(
            `INSERT INTO fees (
                studentId, admission_number, studentName, email,
                className, department,
                feeType, paymentType, amount, billAmount, amountPaid, balance, paymentDate, 
                receiptNumber, academicYear, term, notes, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                studentId,
                admissionNumber,
                studentName,
                studentEmail,
                studentClass,
                studentDepartment,
                feeType,
                paymentType,
                hasBill ? billAmount : amountValue, // amount
                hasBill ? billAmount : amountValue, // billAmount
                amountPaid,
                balance,
                formattedPaymentDate,
                receiptNumber,
                academicYear,
                term,
                notes || null,
                status
            ]
        );

        // Set success notification with appropriate message
        let message = '';
        let notificationTitle = 'Fee Payment Successful';
        
        if (isSubsequentPayment) {
            notificationTitle = 'Additional Payment Recorded';
            message = `Additional payment of ₦${amountValue.toLocaleString()} recorded for ${studentName}! Receipt: ${receiptNumber}`;
            
            if (hasBill) {
                message += `\n\nPrevious payments: ₦${totalPaidSoFar.toLocaleString()}`;
                message += `\nThis payment: ₦${amountPaid.toLocaleString()}`;
                message += `\nTotal paid now: ₦${(totalPaidSoFar + amountPaid).toLocaleString()} of ₦${billAmount.toLocaleString()}`;
                
                if (status === 'partial') {
                    message += `\nRemaining Balance: ₦${balance.toLocaleString()}`;
                    notificationType = 'info';
                } else if (status === 'overpaid') {
                    message += `\nOverpayment: ₦${Math.abs(balance).toLocaleString()} (this amount will be credited for future payments)`;
                    notificationType = 'warning';
                } else if (status === 'paid') {
                    message += `\nFee fully paid! No balance remaining.`;
                    notificationType = 'success';
                }
            }
        } else {
            // First payment for this fee type
            message = `Fee payment of ₦${amountValue.toLocaleString()} recorded successfully for ${studentName}! Receipt: ${receiptNumber}`;
            
            if (hasBill) {
                if (status === 'partial') {
                    message += `\nRemaining Balance: ₦${balance.toLocaleString()}`;
                    notificationType = 'info';
                } else if (status === 'overpaid') {
                    message += `\nOverpayment: ₦${Math.abs(balance).toLocaleString()} (this amount will be credited for future payments)`;
                    notificationType = 'warning';
                } else if (status === 'paid') {
                    message += `\nFee fully paid! No balance remaining.`;
                    notificationType = 'success';
                }
                
                message += `\nTotal paid for ${feeType} (${term}): ₦${(totalPaidSoFar + amountPaid).toLocaleString()} of ₦${billAmount.toLocaleString()}`;
            }
        }
        
        req.session.notification = {
            type: notificationType,
            title: notificationTitle,
            message: message,
            isSubsequentPayment: isSubsequentPayment,
            previousAmount: totalPaidSoFar,
            currentAmount: totalPaidSoFar + amountPaid,
            totalDue: hasBill ? billAmount : amountValue,
            balance: balance,
            receiptNumber: receiptNumber,
            studentName: studentName
        };
        
        return res.redirect(`/add-fees/${studentId}?success=1`);

    } catch (error) {
        console.error('Error adding fee payment:', error);
        
        // Get fresh data for form repopulation
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        let selectedStudentRow = null;
        if (req.body.studentId) {
            const [sr] = await connection.execute(`
                SELECT
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.email,
                    s.classId,
                    c.className,
                    c.department AS classDepartment
                FROM students s
                LEFT JOIN classes c ON s.classId = c.id
                WHERE s.id = ? AND s.school_id = ?
            `, [req.body.studentId, schoolId]);
            selectedStudentRow = sr[0] || null;
        }

        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get terms for the selected academic year if available
        let terms = [];
        if (req.body.academicYear) {
            const [selectedYear] = await connection.execute(
                'SELECT id FROM academic_years WHERE year_name = ?',
                [req.body.academicYear]
            );
            
            if (selectedYear.length > 0) {
                [terms] = await connection.execute(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = ? 
                    ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END
                `, [selectedYear[0].id]);
            }
        }
        
        // Get distinct fee types from class bills for form repopulation
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
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
        
        res.render('add-fees', {
            selectedStudent: selectedStudentRow,
            feeTypes: feeTypes,
            paymentTypes: ['Cash', 'Bank Transfer', 'Credit Card', 'Mobile Money'],
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: req.body.academicYear || '',
            school: school,
            formData: req.body,
            success: null,
            error: error.code === 'ER_DUP_ENTRY' ? 'A fee payment with these details already exists' : 'Failed to add fee payment: ' + error.message
        });
    }
});

// Get class bills for a specific class
router.get('/get-class-bills', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { classId } = req.query;
        
        const connection = await getConnection();
        const [bills] = await connection.execute(`
            SELECT * FROM class_bills 
            WHERE class_id = ? AND is_active = 1
            ORDER BY fee_type
        `, [classId]);
        
        res.json({
            success: true,
            bills: bills
        });
    } catch (error) {
        console.error('Error fetching class bills:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch class bills'
        });
    }
});

router.post('/generate-fees-from-bills', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { classId, academicYear, term } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!classId || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Class, Academic Year, and Term are required'
            });
        }
        
        // Get class bills for the selected criteria
        const [classBills] = await connection.execute(`
            SELECT * FROM class_bills 
            WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
        `, [classId, academicYear, term]);
        
        if (classBills.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No class bills found for the selected criteria'
            });
        }
        
        // Get students in the class
        const [students] = await connection.execute(`
            SELECT s.*, c.className 
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id 
            WHERE s.classId = ?
        `, [classId]);
        
        if (students.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No students found in the selected class'
            });
        }
        
        let generatedCount = 0;
        let skippedCount = 0;
        
        // Generate fees for each student
        for (const student of students) {
            for (const bill of classBills) {
                // Check if fee already exists for this student and bill
                const [existingFees] = await connection.execute(`
                    SELECT id FROM fees 
                    WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
                `, [student.id, bill.fee_type, academicYear, term]);
                
                if (existingFees.length === 0) {
                    // Generate receipt number
                    const receiptNumber = `REC-${student.id}-${Date.now()}-${bill.id}`;
                    
                    // Insert fee record
                    await connection.execute(`
                        INSERT INTO fees (
                            studentId, studentName, email, className, department,
                            feeType, paymentType, amount, amountPaid, paymentDate,
                            receiptNumber, academicYear, term, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        student.id,
                        studentDisplayName(student),
                        student.email,
                        student.className,
                        student.department,
                        bill.fee_type,
                        'Pending', // Default payment type
                        bill.amount,
                        0, // Initially unpaid
                        new Date().toISOString().split('T')[0], // Current date
                        receiptNumber,
                        academicYear,
                        term,
                        'pending' // Initial status
                    ]);
                    
                    generatedCount++;
                } else {
                    skippedCount++;
                }
            }
        }
        
        res.json({
            success: true,
            message: `Generated ${generatedCount} fee records. ${skippedCount} already existed.`,
            generated: generatedCount,
            skipped: skippedCount
        });
        
    } catch (error) {
        console.error('Error generating fees from bills:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate fees: ' + error.message
        });
    }
});

// GET route for fees collection listing with filtering
router.get('/fees-collection', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const { academicYear, term, status, classId, feeType, page = 1, limit = 50 } = req.query;
        
        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
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
                totalCount = totalResult[0]?.total || 0;

                // Get recent notifications for dropdown
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, 
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
            totalCount = 0;
            notifications = [];
        }
        
        // Get academic years for filter dropdown
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        // Get classes for filter
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY className
        `);
        
        // Get distinct fee types from class bills
        const [feeTypesResult] = await connection.execute(`
            SELECT DISTINCT fee_type 
            FROM class_bills 
            WHERE is_active = 1
            ORDER BY fee_type
        `);
        
        const feeTypes = feeTypesResult.map(row => row.fee_type);
        
        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1';
        let queryParams = [];
        
        if (academicYear) {
            whereClause += ' AND f.academicYear = ?';
            queryParams.push(academicYear);
        }
        
        if (term) {
            whereClause += ' AND f.term = ?';
            queryParams.push(term);
        }
        
        if (status) {
            whereClause += ' AND f.status = ?';
            queryParams.push(status);
        }
        
        if (classId) {
            whereClause += ' AND s.classId = ?';
            queryParams.push(classId);
        }
        
        if (feeType) {
            whereClause += ' AND f.feeType = ?';
            queryParams.push(feeType);
        }
        
        // Get total count for pagination
        const [totalCountResult] = await connection.execute(`
            SELECT COUNT(*) as total
            FROM fees f
            LEFT JOIN students s ON f.studentId = s.id
            LEFT JOIN classes c ON s.classId = c.id
            ${whereClause}
        `, queryParams);
        
        const totalRecords = totalCountResult[0].total;
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;
        
        // Get fees with filters - join with students to filter by class
        const [fees] = await connection.execute(`
            SELECT 
                f.*,
                s.classId,
                c.className as studentClassName
            FROM fees f
            LEFT JOIN students s ON f.studentId = s.id
            LEFT JOIN classes c ON s.classId = c.id
            ${whereClause}
            ORDER BY f.paymentDate DESC, f.created_at DESC
            LIMIT ? OFFSET ?
        `, [...queryParams, parseInt(limit), parseInt(offset)]);
        
        // Format amounts for display and calculate payment status
        const formattedFees = fees.map(fee => {
            const billAmount = fee.billAmount || fee.amount;
            const amountPaid = fee.amountPaid || 0;
            const balance = fee.balance !== null && fee.balance !== undefined ? fee.balance : billAmount - amountPaid;
            
            let paymentStatus = fee.status;
            let statusClass = 'success';
            
            if (billAmount > 0) {
                if (amountPaid < billAmount) {
                    paymentStatus = 'Partial';
                    statusClass = 'warning';
                } else if (amountPaid > billAmount) {
                    paymentStatus = 'Overpaid';
                    statusClass = 'info';
                } else if (amountPaid === billAmount) {
                    paymentStatus = 'Paid';
                    statusClass = 'success';
                }
            }
            
            return {
                ...fee,
                billAmount: billAmount,
                formattedBillAmount: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(billAmount),
                formattedAmount: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(amountPaid),
                formattedBalance: new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: 'NGN'
                }).format(Math.abs(balance)),
                paymentStatus: paymentStatus,
                statusClass: statusClass,
                hasBill: fee.billAmount !== null && fee.billAmount !== undefined,
                isPartial: amountPaid < billAmount,
                isOverpaid: amountPaid > billAmount,
                balance: balance
            };
        });

        res.render('fees-collection', { 
            fees: formattedFees,
            academicYears: academicYears,
            classes: classes,
            feeTypes: feeTypes,
            selectedAcademicYear: academicYear || '',
            selectedTerm: term || '',
            selectedStatus: status || '',
            selectedClassId: classId || '',
            selectedFeeType: feeType || '',
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalCount: totalRecords,
            limit: parseInt(limit),
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: totalCount,          // ADD THIS LINE (renamed to avoid conflict)
            notifications: notifications,    // ADD THIS LINE
            moment: require('moment'),
            title: 'Fee Collection',
            notification: req.session.notification
        });
        
        // Clear notification after displaying
        delete req.session.notification;

    } catch (error) {
        console.error('Error fetching fees:', error);
        res.render('fees-collection', { 
            fees: [],
            academicYears: [],
            classes: [],
            feeTypes: [],
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedStatus: '',
            selectedClassId: '',
            selectedFeeType: '',
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            limit: 50,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            notifications: [],                          // ADD THIS LINE
            error: 'Failed to load fee records',
            title: 'Fee Collection'
        });
    }
});

router.get('/fee-receipt/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get fee payment details
        const [payments] = await connection.execute(`
            SELECT f.* 
            FROM fees f
            WHERE f.id = ?
        `, [req.params.id]);

        if (payments.length === 0) {
            return res.status(404).send('Receipt not found');
        }

        const receipt = payments[0];
        
        // Calculate amounts based on bill information
        const billAmount = receipt.billAmount || receipt.amount;
        const amountPaid = receipt.amountPaid || 0;
        const balance = receipt.balance !== null && receipt.balance !== undefined ? 
            receipt.balance : billAmount - amountPaid;
        
        // Determine payment status and messages
        let paymentStatus = 'Paid in Full';
        let statusMessage = '';
        let balanceMessage = '';
        
        if (billAmount > 0) {
            if (amountPaid < billAmount) {
                paymentStatus = 'Partial Payment';
                statusMessage = `Balance Due: ₦${Math.abs(balance).toLocaleString('en-NG')}`;
                balanceMessage = `The student still needs to pay ₦${Math.abs(balance).toLocaleString('en-NG')} to complete this fee payment.`;
            } else if (amountPaid > billAmount) {
                paymentStatus = 'Overpaid';
                statusMessage = `Overpayment: ₦${Math.abs(balance).toLocaleString('en-NG')}`;
                balanceMessage = `The student has overpaid by ₦${Math.abs(balance).toLocaleString('en-NG')}. This amount can be credited towards future payments.`;
            } else {
                paymentStatus = 'Paid in Full';
                statusMessage = 'No balance remaining';
                balanceMessage = 'This fee has been fully paid.';
            }
        }
        
        // Get total paid for this fee type, term, and academic year
        const [totalPayments] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid
            FROM fees 
            WHERE studentId = ? AND feeType = ? AND academicYear = ? AND term = ?
        `, [receipt.studentId, receipt.feeType, receipt.academicYear, receipt.term]);
        
        const totalPaid = parseFloat(totalPayments[0].totalPaid) || 0;
        
        // Format amounts as Naira
        const formatNaira = (amount) => {
            return new Intl.NumberFormat('en-NG', {
                style: 'currency',
                currency: 'NGN'
            }).format(amount || 0);
        };
        
        // Enhanced number to words conversion
        const numberToWords = (num) => {
            const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
            const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
            const tens = ['', 'Ten', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
            
            const convertLessThanThousand = (n) => {
                if (n === 0) return '';
                if (n < 10) return units[n];
                if (n < 20) return teens[n - 10];
                if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + units[n % 10] : '');
                
                return units[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' and ' + convertLessThanThousand(n % 100) : '');
            };
            
            if (num === 0) return 'Zero';
            
            let result = '';
            if (num >= 1000000) {
                result += convertLessThanThousand(Math.floor(num / 1000000)) + ' Million ';
                num %= 1000000;
            }
            if (num >= 1000) {
                result += convertLessThanThousand(Math.floor(num / 1000)) + ' Thousand ';
                num %= 1000;
            }
            if (num > 0) {
                result += convertLessThanThousand(num);
            }
            
            return result.trim();
        };
        
        // Format receipt data
        receipt.formattedBillAmount = formatNaira(billAmount);
        receipt.formattedAmountPaid = formatNaira(amountPaid);
        receipt.formattedBalance = formatNaira(Math.abs(balance));
        receipt.amountInWords = numberToWords(amountPaid) + ' Naira Only';
        receipt.paymentStatus = paymentStatus;
        receipt.statusMessage = statusMessage;
        receipt.balanceMessage = balanceMessage;
        receipt.hasBill = receipt.billAmount !== null && receipt.billAmount !== undefined;
        receipt.isPartial = amountPaid < billAmount;
        receipt.isOverpaid = amountPaid > billAmount;
        receipt.billAmount = billAmount;
        receipt.actualAmountPaid = amountPaid;
        receipt.balanceAmount = balance;
        receipt.totalPaid = totalPaid;
        receipt.formattedTotalPaid = formatNaira(totalPaid);
        
        // Get school information from database (scoped per school)
        const schoolId = req.session.schoolId || null;
        const [schoolInfo] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            logo: "/images/school-logo.png",
            website: "www.excelcollege.edu.ng",
            terms: "All payments are in Nigerian Naira (₦). Payment once made is non-refundable."
        };

        res.render('fee-receipt', { 
            receipt: receipt,
            school: school,
            moment: require('moment'),
            formatNaira: formatNaira
        });

    } catch (error) {
        console.error('Error generating receipt:', error);
        res.status(500).send('Error generating receipt');
    }
});
// Library Routes

// Library Routes
router.get('/all-library', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        const libraryHasSchoolId = await tableHasColumn(connection, 'library_books', 'school_id');
        const [books] = libraryHasSchoolId
            ? await connection.execute('SELECT * FROM library_books WHERE school_id = ?', [schoolId])
            : await connection.execute('SELECT * FROM library_books');

        res.render('all-library', {
            books: books,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error fetching library books:', error);
        res.render('all-library', {
            books: [],
            error: 'Failed to load library books.',
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// GET route - Add library book form
router.get('/add-library', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        res.render('add-library', {
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            formData: {},
            error: null
        });

    } catch (error) {
        console.error('Error loading add library form:', error);
        res.render('add-library', {
            error: 'Failed to load form: ' + error.message,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            formData: {}
        });
    }
});

// POST route - Add library book
router.post('/add-library', authenticate, requireRole('admin'), uploadWithFile.single('bookCover'), async (req, res) => {
    const { title, author, isbn, quantity, category } = req.body;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        // Get notifications for error rendering
        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        // Validate required fields
        if (!title || !author || !quantity) {
            try {
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [unreadResult] = await connection.execute(`
                        SELECT COUNT(*) as count FROM admin_notifications 
                        WHERE admin_id = ? AND is_read = 0
                    `, [adminId]);
                    unreadCount = unreadResult[0]?.count || 0;

                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total FROM admin_notifications 
                        WHERE admin_id = ?
                    `, [adminId]);
                    notificationTotal = totalResult[0]?.total || 0;

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
            }

            return res.render('add-library', {
                error: 'Title, Author, and Quantity are required fields',
                formData: req.body,
                username: username,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment')
            });
        }

        const libraryHasSchoolId = await tableHasColumn(connection, 'library_books', 'school_id');
        let coverPath = req.file ? '/images/library/' + req.file.filename : null;

        if (libraryHasSchoolId) {
            await connection.execute(
                'INSERT INTO library_books (title, author, isbn, quantity, category, coverPath, school_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [title, author, isbn || null, parseInt(quantity), category || null, coverPath, schoolId]
            );
        } else {
            await connection.execute(
                'INSERT INTO library_books (title, author, isbn, quantity, category, coverPath) VALUES (?, ?, ?, ?, ?, ?)',
                [title, author, isbn || null, parseInt(quantity), category || null, coverPath]
            );
        }

        req.session.success = 'Book added successfully';
        res.redirect('/all-library');

    } catch (error) {
        console.error('Error adding book:', error);

        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                notificationTotal = totalResult[0]?.total || 0;

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
        }

        res.render('add-library', {
            error: 'Failed to add book: ' + error.message,
            formData: req.body,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });
    }
});

// Calendar Routes
// Calendar Routes
router.get('/school-calendar', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, term } = req.query;
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const calendarEventsHaveSchoolId = await tableHasColumn(connection, 'calendar_events', 'school_id');

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

        // Build the WHERE clause if filters are provided
        let whereClause = 'WHERE 1=1'; // Show all events, not just future ones
        let queryParams = [];

        if (calendarEventsHaveSchoolId) {
            whereClause += ' AND school_id = ?';
            queryParams.push(schoolId);
        }

        if (academicYear && academicYear !== '') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }

        if (term && term !== '') {
            whereClause += ' AND term = ?';
            queryParams.push(term);
        }

        // Get events with optional filtering - select ALL columns
        const [events] = await connection.execute(`
            SELECT * FROM calendar_events 
            ${whereClause}
            ORDER BY eventDate ASC, startTime ASC
        `, queryParams);

        // Get academic years for filter dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT academic_year 
            FROM calendar_events 
            WHERE academic_year IS NOT NULL AND academic_year != ''
            ORDER BY academic_year DESC
        `);

        // Get terms for filter dropdown
        const [terms] = await connection.execute(`
            SELECT DISTINCT term 
            FROM calendar_events 
            WHERE term IS NOT NULL AND term != ''
            ORDER BY 
                CASE term
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                    ELSE 4
                END
        `);

        res.render('school-calendar', {
            events: events,
            academicYears: academicYears,
            terms: terms,
            selectedAcademicYear: academicYear || '',
            selectedTerm: term || '',
            username: username,  // ADD THIS LINE
            unreadCount: unreadCount,  // ADD THIS LINE
            totalCount: notificationTotal,  // ADD THIS LINE
            notifications: notifications,  // ADD THIS LINE
            moment: require('moment')
        });
    } catch (error) {
        console.error('Error fetching calendar events:', error);

        // Get fallback data for error rendering
        let academicYears = [];
        let terms = [];

        try {
            const connection = await getConnection();
            [academicYears] = await connection.execute(`
                SELECT DISTINCT academic_year 
                FROM calendar_events 
                WHERE academic_year IS NOT NULL AND academic_year != ''
                ORDER BY academic_year DESC
            `);
            [terms] = await connection.execute(`
                SELECT DISTINCT term 
                FROM calendar_events 
                WHERE term IS NOT NULL AND term != ''
                ORDER BY term
            `);
            releaseConnection(connection);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('school-calendar', {
            events: [],
            academicYears: academicYears,
            terms: terms,
            selectedAcademicYear: '',
            selectedTerm: '',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,  // ADD THIS LINE
            totalCount: 0,  // ADD THIS LINE
            notifications: [],  // ADD THIS LINE
            error: 'Failed to load calendar.',
            moment: require('moment')
        });
    }
});

router.get('/add-event', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

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

        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);

        // Get current academic year
        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);

        // Get terms for the current academic year
        let terms = [];
        let currentTerm = null;

        if (currentAcademicYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);

            // Get current term
            const [currentTermResult] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? AND is_current = TRUE LIMIT 1
            `, [currentAcademicYear[0].id]);

            if (currentTermResult.length > 0) {
                currentTerm = currentTermResult[0];
            }
        }

        res.render('add-event', {
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            currentTerm: currentTerm,
            username: username,  // ADD THIS LINE
            unreadCount: unreadCount,  // ADD THIS LINE
            totalCount: notificationTotal,  // ADD THIS LINE
            notifications: notifications,  // ADD THIS LINE
            moment: require('moment'),
            formData: {}
        });
    } catch (error) {
        console.error('Error loading add event form:', error);

        // Get fallback data for error rendering
        let academicYears = [];
        let terms = [];

        try {
            const connection = await getConnection();
            [academicYears] = await connection.execute(`
                SELECT * FROM academic_years ORDER BY start_date DESC
            `);
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms ORDER BY start_date DESC
            `);
            releaseConnection(connection);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('add-event', {
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: null,
            currentTerm: null,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,  // ADD THIS LINE
            totalCount: 0,  // ADD THIS LINE
            notifications: [],  // ADD THIS LINE
            moment: require('moment'),
            formData: {},
            error: 'Failed to load form data: ' + error.message
        });
    }
});

// POST route for add-event
router.post('/add-event', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { title, description, eventDate, startTime, endTime, academicYear, term } = req.body;

    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        // Get notifications for error rendering
        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        // Validate required fields
        if (!title || !eventDate || !academicYear || !term) {
            // Re-fetch academic data for form repopulation
            const [academicYears] = await connection.execute(`
                SELECT * FROM academic_years ORDER BY start_date DESC
            `);

            const [currentAcademicYear] = await connection.execute(`
                SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
            `);

            let terms = [];
            if (currentAcademicYear.length > 0) {
                [terms] = await connection.execute(`
                    SELECT * FROM academic_terms 
                    WHERE academic_year_id = ? 
                    ORDER BY 
                        CASE term_name
                            WHEN 'First Term' THEN 1
                            WHEN 'Second Term' THEN 2
                            WHEN 'Third Term' THEN 3
                        END
                `, [currentAcademicYear[0].id]);
            }

            try {
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [unreadResult] = await connection.execute(`
                        SELECT COUNT(*) as count FROM admin_notifications 
                        WHERE admin_id = ? AND is_read = 0
                    `, [adminId]);
                    unreadCount = unreadResult[0]?.count || 0;

                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total FROM admin_notifications 
                        WHERE admin_id = ?
                    `, [adminId]);
                    notificationTotal = totalResult[0]?.total || 0;

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
            }

            return res.render('add-event', {
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
                formData: req.body,
                username: username,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment'),
                error: 'Please fill in all required fields (Title, Date, Academic Year, and Term)'
            });
        }

        await connection.execute(
            'INSERT INTO calendar_events (title, description, eventDate, startTime, endTime, academic_year, term, school_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [title, description || null, eventDate, startTime || null, endTime || null, academicYear, term, req.session.schoolId || null]
        );

        req.session.success = 'Event added successfully';
        res.redirect('/school-calendar');

    } catch (error) {
        console.error('Error adding event:', error);

        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                notificationTotal = totalResult[0]?.total || 0;

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
        }

        // Re-fetch academic data for form repopulation
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);

        const [currentAcademicYear] = await connection.execute(`
            SELECT * FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);

        let terms = [];
        if (currentAcademicYear.length > 0) {
            [terms] = await connection.execute(`
                SELECT * FROM academic_terms 
                WHERE academic_year_id = ? 
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [currentAcademicYear[0].id]);
        }

        res.render('add-event', {
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            formData: req.body,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            error: 'Failed to add event: ' + error.message
        });
    }
});

// View student profile by ID

router.get('/staff-profile/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const [staff] = await connection.execute(
            'SELECT * FROM staff WHERE id = ?', 
            [req.params.id]
        );

        if (staff.length === 0) {
            return res.status(404).send('Staff member not found');
        }

        const member = staff[0];
        res.render('staff-profile', { staff: member, moment: require('moment') });
    } catch (error) {
        console.error('Error fetching staff profile:', error);
        res.status(500).send('Error loading profile');
    }
});

// Display form to register new subjects
// SUBJECT ROUTES
// Display form to register new subjects
router.get('/register-subjects', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get distinct levels from classes table
        const [levels] = await connection.execute('SELECT DISTINCT level as name FROM classes ORDER BY level');

        // Get distinct departments from classes table
        const [departments] = await connection.execute('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');

        // Get all classes grouped by level
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);

        // Group classes by level
        const classesByLevel = {};
        classes.forEach(cls => {
            if (!classesByLevel[cls.level]) {
                classesByLevel[cls.level] = [];
            }
            classesByLevel[cls.level].push(cls);
        });

        res.render('register-subjects', {
            levels: levels,
            departments: departments,
            classesByLevel: classesByLevel,
            formData: req.query.classId ? { classId: req.query.classId } : {},
            error: null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });
    } catch (error) {
        console.error('Error loading form:', error);
        res.render('register-subjects', {
            levels: [],
            departments: [],
            classesByLevel: {},
            formData: {},
            error: 'Failed to load data',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});
router.post('/register-subjects', authenticate, requireRole('admin'), async (req, res) => {
    let connection = null;
    
    try {
        connection = await getConnection();
        const { level, department, subjects, subject_codes, descriptions, autoAllDepartments } = req.body;

        const isAllDepartments = level === 'SENIOR SECONDARY' && (
            department === 'ALL' ||
            autoAllDepartments === '1' ||
            autoAllDepartments === 'true' ||
            autoAllDepartments === true ||
            autoAllDepartments === 'on'
        );

        // Debug logging
        console.log('Form data received:', {
            level: level,
            department: department,
            isAllDepartments: isAllDepartments,
            subjects: subjects,
            subject_codes: subject_codes,
            descriptions: descriptions
        });

        await connection.beginTransaction();

        // Validate inputs
        if (!level || !subjects || !Array.isArray(subjects) || subjects.length === 0) {
            console.log('Validation failed - missing required fields');
            throw new Error('Please select a level and add at least one subject');
        }

        // For SENIOR SECONDARY, department is required unless registering for all departments
        if (level === 'SENIOR SECONDARY' && !isAllDepartments && (!department || department.trim() === '')) {
            throw new Error('Please select a department or choose to register for all departments for Senior Secondary subjects');
        }

        // Get all classes for the selected level and department
        let classQuery = 'SELECT id, className, department FROM classes WHERE level = ?';
        let classParams = [level];
        
        if (level === 'SENIOR SECONDARY' && !isAllDepartments && department) {
            classQuery += ' AND department = ?';
            classParams.push(department.trim());
        }

        const [classes] = await connection.execute(classQuery, classParams);

        if (classes.length === 0) {
            const deptText = level === 'SENIOR SECONDARY' ? (isAllDepartments ? ' across all departments' : ' - ' + department) : '';
            throw new Error(`No classes found for level: ${level}${deptText}`);
        }

        console.log(`Found ${classes.length} classes for ${level}${level === 'SENIOR SECONDARY' ? (isAllDepartments ? ' across all departments' : ' - ' + department) : ''}`);

        // Process each subject for all classes
        for (let i = 0; i < subjects.length; i++) {
            const subjectName = (subjects[i] || '').trim();
            const subjectCode = (subject_codes && subject_codes[i] ? subject_codes[i] : '').trim();
            
            if (!subjectName) continue;

            let finalSubjectCode = subjectCode;

            // If no subject code provided, generate one based on level and index
            if (!finalSubjectCode) {
                const levelPrefix = level.substring(0, 2).toUpperCase();
                finalSubjectCode = `${levelPrefix}${(i + 1).toString().padStart(3, '0')}`;
            }

            // Create or reuse a subject entry (handle duplicate subject_code gracefully)
            let subjectId;
            try {
                const [subjectResult] = await connection.execute(
                    'INSERT INTO subjects (name, subject_code, description) VALUES (?, ?, ?)',
                    [
                        subjectName,
                        finalSubjectCode,
                        descriptions && descriptions[i] ? descriptions[i].trim() : null
                    ]
                );
                subjectId = subjectResult.insertId;
                console.log(`Created new subject: "${subjectName}" with code: ${finalSubjectCode} and ID: ${subjectId}`);
            } catch (insertError) {
                if (insertError.code === 'ER_DUP_ENTRY') {
                    // Subject code already exists – reuse existing subject id
                    const [existing] = await connection.execute(
                        'SELECT id FROM subjects WHERE subject_code = ? LIMIT 1',
                        [finalSubjectCode]
                    );
                    if (existing.length === 0) {
                        throw insertError;
                    }
                    subjectId = existing[0].id;
                    console.log(`Reusing existing subject ID ${subjectId} for code ${finalSubjectCode}`);
                } else {
                    throw insertError;
                }
            }

            // Link subject to ALL classes in this level/department
            for (const classInfo of classes) {
                try {
                    await connection.execute(
                        `INSERT INTO class_subjects (class_id, subject_id) 
                         VALUES (?, ?)`,
                        [classInfo.id, subjectId]
                    );
                } catch (linkError) {
                    // Ignore duplicate entry errors for class_subjects
                    if (linkError.code !== 'ER_DUP_ENTRY') {
                        throw linkError;
                    }
                    console.log(`Subject ${subjectId} already linked to class ${classInfo.id}`);
                }
            }

            console.log(`Subject "${subjectName}" registered for ${classes.length} classes`);
        }

        await connection.commit();
        
        const deptLabel = level === 'SENIOR SECONDARY' 
            ? (isAllDepartments ? ' across all departments (Science, Commercial, Art)' : ` - ${department}`) 
            : '';
        req.session.notification = {
            type: 'success',
            message: `Subjects registered successfully for ${level}${deptLabel} (${classes.length} classes)`
        };
        res.redirect('/view-subjects');

    } catch (error) {
        // Rollback transaction if connection exists
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }
        
        console.error('Registration error:', error);
        
        // Get levels, departments, and classes for the form
        let levels = [];
        let departments = [];
        let classesByLevel = {};
        try {
            const tempConnection = await getConnection();
            [levels] = await tempConnection.execute('SELECT DISTINCT level as name FROM classes ORDER BY level');
            [departments] = await tempConnection.execute('SELECT DISTINCT department as name FROM classes WHERE department IS NOT NULL ORDER BY department');
            
            const [classes] = await tempConnection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `);
            
            // Group classes by level
            classes.forEach(cls => {
                if (!classesByLevel[cls.level]) {
                    classesByLevel[cls.level] = [];
                }
                classesByLevel[cls.level].push(cls);
            });
            
            releaseConnection(tempConnection);
        } catch (dbError) {
            console.error('Error fetching form data:', dbError);
        }
        
        res.render('register-subjects', {
            levels: levels,
            departments: departments,
            classesByLevel: classesByLevel,
            formData: req.body,
            error: error.message || 'Failed to register subjects',
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: []
        });
    } finally {
        // Always close the connection
        if (connection) {
            try {
                releaseConnection(connection);
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }
    }
});

// Update the loadClassesForLevel function to handle multi-select properly
function loadClassesForLevel(level, department = '') {
    classesContainer.innerHTML = '';
    
    if (!level) {
        const select = document.createElement('select');
        select.className = 'form-control';
        select.multiple = true;
        select.name = 'classIds';
        select.innerHTML = '<option value="">Select a level first</option>';
        classesContainer.appendChild(select);
        return;
    }

    const select = document.createElement('select');
    select.className = 'form-control';
    select.multiple = true;
    select.name = 'classIds';
    select.required = true;
    select.size = 5; // Show 5 options at once

    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select classes (' + level + (department ? ' - ' + department : '') + ')';
    defaultOption.disabled = true;
    select.appendChild(defaultOption);

    // Filter classes by level and department
    const filteredClasses = classesData[level] || [];
    const classesToShow = department ? 
        filteredClasses.filter(cls => cls.department === department) : 
        filteredClasses;

    if (classesToShow.length === 0) {
        const noClassesOption = document.createElement('option');
        noClassesOption.value = '';
        noClassesOption.textContent = 'No classes available for this selection';
        noClassesOption.disabled = true;
        select.appendChild(noClassesOption);
    } else {
        classesToShow.forEach(cls => {
            const option = document.createElement('option');
            option.value = cls.id;
            option.textContent = cls.className + (cls.department ? ' (' + cls.department + ')' : '');
            // Pre-select if previously selected
            if (Array.isArray(formData.classIds) && formData.classIds.includes(cls.id.toString())) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    classesContainer.appendChild(select);
}

// View all subjects by class
// View all subjects by class
router.get('/view-subjects', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const selectedClassId = req.query.classId || null;

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get all classes for the filter dropdown
        const [allClasses] = await connection.execute(`
            SELECT 
                c.id, 
                c.className,
                c.level,
                c.department
            FROM classes c
            WHERE c.school_id = ?
            ORDER BY 
                CASE c.level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                c.className
        `, [schoolId]);

        // Build the WHERE clause if a class is selected
        let whereClause = '';
        let queryParams = [];
        if (selectedClassId) {
            whereClause = 'WHERE c.id = ?';
            queryParams = [selectedClassId];
        }

        // Get subjects with teachers - fixed column names
        const query = `
            SELECT 
                c.id AS classId,
                c.className,
                c.level,
                c.department,
                s.id AS subjectId,
                s.name AS subjectName,
                s.subject_code AS subjectCode,
                t.id AS teacherId,
                CONCAT(t.firstName, ' ', t.lastName) AS teacherName,
                COUNT(ss.student_id) AS studentCount,
                MAX(cs.created_at) AS lastUpdated
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            LEFT JOIN teachers t ON cs.teacher_id = t.id
            LEFT JOIN student_subjects ss ON s.id = ss.subject_id
            ${whereClause}
            GROUP BY c.id, s.id, t.id
            ORDER BY c.className, s.name
        `;

        const [subjects] = await connection.execute(query, queryParams);

        // Format dates
        const formattedSubjects = subjects.map(subject => ({
            ...subject,
            formattedDate: subject.lastUpdated ?
                moment(subject.lastUpdated).format('DD MMM YYYY') : 'Never'
        }));

        res.render('view-subjects', {
            classes: allClasses,
            subjects: formattedSubjects,
            selectedClassId: selectedClassId,
            notification: req.session.notification || null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications,    // ADD THIS LINE
            moment: require('moment')
        });

        delete req.session.notification;

    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.render('view-subjects', {
            classes: [],
            subjects: [],
            selectedClassId: null,
            notification: null,
            error: 'Failed to load subjects data',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: [],                          // ADD THIS LINE
            moment: require('moment')
        });
    }
});

// View subjects for a specific class
router.get('/class-subjects/:classId', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        
        // Get class info with level and department
        const [classes] = await connection.execute(
            'SELECT id, className, level, department FROM classes WHERE id = ?',
            [req.params.classId]
        );
        
        if (classes.length === 0) {
            return res.status(404).send('Class not found');
        }

        const classInfo = classes[0];
        classInfo.displayName = classInfo.level === 'SENIOR SECONDARY' && classInfo.department 
            ? `${classInfo.className} (${classInfo.department})` 
            : classInfo.className;

        // Get subjects for this class
        const [subjects] = await connection.execute(
            'SELECT id, subjectName, subjectCode FROM class_subjects WHERE classId = ? ORDER BY subjectName',
            [req.params.classId]
        );

        // Get students in this class
        const [students] = await connection.execute(
            `SELECT s.id, s.firstName, s.middleName, s.lastName, s.department 
             FROM students s 
             WHERE s.classId = ? 
             ORDER BY s.firstName`,
            [req.params.classId]
        );

        // Get enrolled subjects for each student
        const enrolledStudents = await Promise.all(students.map(async student => {
            const [enrollments] = await connection.execute(
                `SELECT ss.subjectId, cs.subjectName, cs.subjectCode 
                 FROM student_subjects ss
                 JOIN class_subjects cs ON ss.subjectId = cs.id
                 WHERE ss.studentId = ?`,
                [student.id]
            );
            return {
                ...student,
                enrollments,
                displayName: studentDisplayName(student) +
                    (student.department ? ` (${student.department})` : '')
            };
        }));

        res.render('class-subjects', {
            classInfo: classInfo,
            subjects: subjects,
            students: enrolledStudents,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error fetching class subjects:', error);
        res.status(500).render('error', {
            message: 'Error loading class subjects',
            error: { status: 500 }
        });
    }
});

// Unenroll student from subject
router.delete('/unenroll-student-subject', authenticate, requireRole('admin'), async (req, res) => {
    const { studentId, subjectId } = req.query;
    
    if (!studentId || !subjectId) {
        return res.status(400).json({ 
            success: false,
            error: 'Student ID and Subject ID are required'
        });
    }

    try {
        const connection = await getConnection();
        
        const [result] = await connection.execute(
            'DELETE FROM student_subjects WHERE student_id = ? AND subject_id = ?', // Fixed column names
            [studentId, subjectId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Enrollment record not found'
            });
        }

        res.json({ 
            success: true,
            message: 'Student successfully unenrolled from subject'
        });

    } catch (error) {
        console.error('Error unenrolling student:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to unenroll student',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET route to display teacher assignment form
// GET route to display teacher assignment form
router.get('/assign-teachers', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get all teachers, classes, and subjects for the user's school
        const [teachers] = await connection.execute('SELECT id, firstName, lastName FROM teachers WHERE school_id = ? ORDER BY lastName', [schoolId]);
        const [classes] = await connection.execute('SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className', [schoolId]);
        const subjectsHaveSchoolId = await tableHasColumn(connection, 'subjects', 'school_id');
        const [subjects] = subjectsHaveSchoolId
            ? await connection.execute('SELECT id, name FROM subjects WHERE school_id = ? ORDER BY name', [schoolId])
            : await connection.execute(`
                SELECT DISTINCT s.id, s.name
                FROM subjects s
                JOIN class_subjects cs ON cs.subject_id = s.id
                JOIN classes c ON cs.class_id = c.id
                WHERE c.school_id = ?
                ORDER BY s.name
            `, [schoolId]);
        const [academicYears] = await connection.execute('SELECT DISTINCT academic_year FROM class_bills WHERE school_id = ? ORDER BY academic_year DESC', [schoolId]);

        // Get existing assignments
        const [assignments] = await connection.execute(`
            SELECT ta.*, t.firstName, t.lastName, c.className, s.name AS subjectName
            FROM teacher_assignments ta
            JOIN teachers t ON ta.teacher_id = t.id
            JOIN classes c ON ta.class_id = c.id
            JOIN subjects s ON ta.subject_id = s.id
            WHERE t.school_id = ? AND c.school_id = ?
            ORDER BY c.className, s.name
        `, [schoolId, schoolId]);

        res.render('assign-teachers', {
            teachers: teachers,
            classes: classes,
            subjects: subjects,
            academicYears: academicYears.map(y => y.academic_year),
            assignments: assignments,
            error: null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });
    } catch (error) {
        console.error('Error loading teacher assignment form:', error);
        res.render('assign-teachers', {
            teachers: [],
            classes: [],
            subjects: [],
            academicYears: [],
            assignments: [],
            error: 'Failed to load data',
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// POST route to assign teacher to class and subject
router.post('/assign-teacher', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { teacherId, classId, subjectId, academicYear } = req.body;
    const schoolId = req.session.schoolId || null;
    
    try {
        const connection = await getConnection();

        const [teacherCheck] = await connection.execute(
            'SELECT id FROM teachers WHERE id = ? AND school_id = ?',
            [teacherId, schoolId]
        );
        const [classCheck] = await connection.execute(
            'SELECT id FROM classes WHERE id = ? AND school_id = ?',
            [classId, schoolId]
        );
        if (teacherCheck.length === 0 || classCheck.length === 0) {
            return res.status(403).json({
                success: false,
                error: 'Invalid teacher or class for this school'
            });
        }
        
        // Check if assignment already exists
        const [existing] = await connection.execute(
            'SELECT id FROM teacher_assignments WHERE teacher_id = ? AND class_id = ? AND subject_id = ? AND academic_year = ?',
            [teacherId, classId, subjectId, academicYear]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'This teacher is already assigned to this class and subject for the selected academic year'
            });
        }
        
        // Create new assignment
        await connection.execute(
            'INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, academic_year) VALUES (?, ?, ?, ?)',
            [teacherId, classId, subjectId, academicYear]
        );
        
        res.json({ success: true, message: 'Teacher assigned successfully' });
    } catch (error) {
        console.error('Error assigning teacher:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to assign teacher'
        });
    }
});

// Student Records Routes - Updated to use academic_years and academic_terms

router.get('/student-records', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // Get students with their class information
        const { page, limit, offset, q } = parsePage(req);
        let recWhere = 'WHERE s.school_id = ?';
        const recParams = [schoolId];
        if (q) {
            recWhere += ' AND (s.firstName LIKE ? OR s.lastName LIKE ? OR s.middleName LIKE ? OR s.admission_number LIKE ?)';
            const like = searchLike(q);
            recParams.push(like, like, like, like);
        }
        const [recCountRows] = await connection.execute(
            `SELECT COUNT(*) as total FROM students s ${recWhere}`,
            recParams
        );
        const listTotal = recCountRows[0]?.total || 0;
        const totalPages = Math.max(1, Math.ceil(listTotal / limit));

        const [students] = await connection.query(`
            SELECT 
                s.id, 
                s.firstName, 
                s.middleName, 
                s.lastName, 
                s.admission_number,
                s.email,
                s.gender,
                s.department as student_department,
                c.id as class_id,
                c.className, 
                c.level, 
                c.department as class_department
            FROM students s 
            LEFT JOIN classes c ON s.classId = c.id
            ${recWhere}
            ORDER BY c.className, s.firstName, s.lastName
            LIMIT ${limit} OFFSET ${offset}
        `, recParams);
        
        // Format student data for display
        const formattedStudents = students.map(student => ({
            id: student.id,
            firstName: student.firstName,
            middleName: student.middleName,
            lastName: student.lastName,
            fullName: studentDisplayName(student),
            admission_number: student.admission_number || 'N/A',
            email: student.email || 'N/A',
            gender: student.gender || 'N/A',
            className: student.className || 'Not Assigned',
            level: student.level || 'N/A',
            department: student.class_department || student.student_department || null,
            class_id: student.class_id
        }));
        
        // Get statistics for dashboard
        const [stats] = await connection.execute(`
            SELECT 
                COUNT(DISTINCT s.id) as total_students,
                COUNT(DISTINCT c.id) as total_classes,
                COUNT(DISTINCT c.level) as total_levels
            FROM students s
            LEFT JOIN classes c ON s.classId = c.id
            WHERE s.school_id = ?
        `, [schoolId]);
        
        const yearTerm = await getCachedCurrentYearTerm(connection, schoolId);
        const username = req.session.username || 'Admin';
        const role = req.session.role || 'admin';
        const userId = req.session.userId || null;

        res.render('student-records-list', { 
            students: formattedStudents,
            stats: stats[0] || { total_students: 0, total_classes: 0, total_levels: 0 },
            currentAcademicYear: yearTerm.yearName || '2023-2024',
            currentTerm: yearTerm.termName || 'First Term',
            username: username,
            role: role,
            userId: userId,
            title: 'Student Records',
            currentPage: 'student-records',
            error: null,
            success: req.session.success || null,
            moment: require('moment'),
            pagerPage: page,
            totalPages,
            totalRecords: listTotal,
            extraQuery: q ? `&q=${encodeURIComponent(q)}` : '',
            searchQ: q
        });
        
        // Clear session messages
        delete req.session.success;
        delete req.session.error;
        
    } catch (error) {
        console.error('Error fetching students:', error);
        
        // Render error page with default values
        res.render('student-records-list', { 
            students: [],
            stats: { total_students: 0, total_classes: 0, total_levels: 0 },
            currentAcademicYear: '2023-2024',
            currentTerm: 'First Term',
            username: req.session.username || 'Admin',
            role: req.session.role || 'admin',
            userId: req.session.userId || null,
            title: 'Student Records',
            currentPage: 'student-records',
            error: 'Failed to load student records. Please try again later.',
            success: null,
            moment: require('moment'),
            pagerPage: 1,
            totalPages: 1,
            totalRecords: 0,
            extraQuery: '',
            searchQ: ''
        });
    }
});

router.get('/student-records/:studentId', authenticate, requireRole('admin'), async (req, res) => {
    const { studentId } = req.params;
    const { term, academicYear } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get available academic years and terms
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms ORDER BY start_date DESC
        `);
        
        if (!term || !academicYear) {
            return res.render('select-term', { 
                studentId, 
                academicYears, 
                terms,
                error: null
            });
        }
        
        // Get student details with class information
        const [studentResults] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (studentResults.length === 0) {
            return res.status(404).render('error', {
                message: 'Student not found',
                error: { status: 404 }
            });
        }
        
        const student = studentResults[0];
        
        if (term === 'session') {
            // Calculate session record - get subjects the student is actually enrolled in
            const [sessionResults] = await connection.execute(`
                SELECT 
                    s.id as subject_id,
                    s.name as subject_name,
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
                    SELECT subject_id 
                    FROM student_scores 
                    WHERE student_id = ? AND academic_year = ?
                    GROUP BY subject_id
                )
                ORDER BY s.name
            `, [studentId, academicYear, studentId, academicYear, studentId, academicYear, studentId, academicYear]);
            
            // Calculate averages and totals
            let totalAverage = 0;
            let totalSubjectsWithScores = 0;
            const sessionRecord = sessionResults.map(subject => {
                const firstTerm = parseFloat(subject.first_term_score) || 0;
                const secondTerm = parseFloat(subject.second_term_score) || 0;
                const thirdTerm = parseFloat(subject.third_term_score) || 0;
                
                // Only calculate average if at least one term has scores
                let average = 0;
                let termsWithScores = 0;
                
                if (firstTerm > 0) termsWithScores++;
                if (secondTerm > 0) termsWithScores++;
                if (thirdTerm > 0) termsWithScores++;
                
                if (termsWithScores > 0) {
                    average = (firstTerm + secondTerm + thirdTerm) / termsWithScores;
                    totalAverage += average;
                    totalSubjectsWithScores++;
                }
                
                return {
                    ...subject,
                    average: average.toFixed(2),
                    firstTerm: firstTerm.toFixed(1),
                    secondTerm: secondTerm.toFixed(1),
                    thirdTerm: thirdTerm.toFixed(1),
                    hasScores: termsWithScores > 0
                };
            });
            
            // Calculate overall percentage
            const overallAverage = totalSubjectsWithScores > 0 ? totalAverage / totalSubjectsWithScores : 0;
            const percentage = ((overallAverage / 100) * 100).toFixed(2);
            
            // Determine grade
            let grade = 'F';
            if (overallAverage >= 80) grade = 'A';
            else if (overallAverage >= 70) grade = 'B';
            else if (overallAverage >= 60) grade = 'C';
            else if (overallAverage >= 50) grade = 'D';
            else if (overallAverage >= 40) grade = 'E';
            
            res.render('student-record', { 
                student, 
                subjects: sessionRecord, 
                scores: [], 
                terms: ['First Term', 'Second Term', 'Third Term'],
                academicYears,
                selectedTerm: 'session',
                selectedYear: academicYear,
                sessionRecord: sessionRecord.filter(subject => subject.hasScores),
                totalAverage: overallAverage.toFixed(2),
                percentage,
                grade,
                success: req.query.success,
                error: req.query.error
            });
            
        } else {
            // Show specific term scores - only subjects the student has scores for
            const [scores] = await connection.execute(`
                SELECT s.id as subject_id, s.name as subject_name, 
                       sc.test_score, sc.exam_score, 
                       COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                       sc.term
                FROM subjects s
                JOIN student_scores sc ON s.id = sc.subject_id 
                WHERE sc.student_id = ? AND sc.term = ? AND sc.academic_year = ?
                ORDER BY s.name
            `, [studentId, term, academicYear]);
            
            // Calculate term statistics
            let termTotal = 0;
            let termAverage = 0;
            
            if (scores.length > 0) {
                termTotal = scores.reduce((sum, score) => sum + parseFloat(score.total_score || 0), 0);
                termAverage = termTotal / scores.length;
            }
            
            const termPercentage = ((termAverage / 100) * 100).toFixed(2);
            
            // Determine grade for the term
            let termGrade = 'F';
            if (termAverage >= 80) termGrade = 'A';
            else if (termAverage >= 70) termGrade = 'B';
            else if (termAverage >= 60) termGrade = 'C';
            else if (termAverage >= 50) termGrade = 'D';
            else if (termAverage >= 40) termGrade = 'E';
            
            res.render('student-record', { 
                student, 
                subjects: scores, 
                scores, 
                terms: ['First Term', 'Second Term', 'Third Term'],
                academicYears,
                selectedTerm: term,
                selectedYear: academicYear,
                sessionRecord: null,
                termTotal: termTotal.toFixed(2),
                termAverage: termAverage.toFixed(2),
                termPercentage,
                termGrade,
                success: req.query.success,
                error: req.query.error
            });
        }
    } catch (error) {
        console.error('Error loading student record:', error);
        res.status(500).render('error', {
            message: 'Error loading student record',
            error: { status: 500, details: error.message }
        });
    }
});


// Term Reports Routes
router.get('/term-reports', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get available academic years for the user's school
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Get all classes for the user's school
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `, [schoolId]);

        // Terms for selection
        const terms = ['First Term', 'Second Term', 'Third Term'];

        res.render('term-report-selection', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            formData: {
                classId: req.query.classId || '',
                term: req.query.term || '',
                academicYear: req.query.academicYear || ''
            },
            error: req.query.error || null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });

    } catch (error) {
        console.error('Error loading term report selection:', error);

        // Get classes for error fallback
        let classes = [];
        let academicYears = [];

        try {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ? 
                ORDER BY className
            `, [schoolId]);
            [academicYears] = await connection.execute(`
                SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
            `, [schoolId]);
            releaseConnection(connection);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('term-report-selection', {
            classes: classes,
            academicYears: academicYears,
            terms: ['First Term', 'Second Term', 'Third Term'],
            formData: {
                classId: '',
                term: '',
                academicYear: ''
            },
            error: 'Failed to load selection data: ' + error.message,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// Updated term report routes to accept class parameter
router.get('/first-term/:classId?', authenticate, requireRole('admin'), async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('First Term', classId, res);
});

router.get('/second-term/:classId?', authenticate, requireRole('admin'), async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('Second Term', classId, res);
});

router.get('/third-term/:classId?', authenticate, requireRole('admin'), async (req, res) => {
    const classId = req.params.classId || req.query.classId;
    if (!classId) {
        return res.redirect('/term-reports?error=Please select a class');
    }
    await generateTermReport('Third Term', classId, res);
});

// Updated helper function to accept classId
// Updated helper function to accept classId
async function generateTermReport(term, classId, res) {
    try {
        const connection = await getConnection();
        const schoolId = res.req.session.schoolId || null;
        const adminId = res.req.session.userId;
        const username = res.req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get current academic year if not specified
        const [currentYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);

        const academicYear = currentYear.length > 0 ? currentYear[0].year_name : new Date().getFullYear().toString();

        // Get class information
        const [classResults] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE id = ? AND school_id = ?
        `, [classId, schoolId]);

        if (classResults.length === 0) {
            return res.render('term-report', {
                term: term,
                academicYear: academicYear,
                classReports: [],
                termName: `${term} Report`,
                error: 'Class not found',
                username: username,              // ADD THIS LINE
                unreadCount: unreadCount,        // ADD THIS LINE
                totalCount: notificationTotal,   // ADD THIS LINE
                notifications: notifications     // ADD THIS LINE
            });
        }

        const classInfo = classResults[0];

        // Get students with their scores for this specific class
        const [results] = await connection.execute(`
            SELECT 
                s.id as student_id,
                s.firstName as first_name,
                s.middleName as middle_name,
                s.lastName as last_name,
                s.admission_number,
                s.department as student_department,
                COUNT(DISTINCT sc.subject_id) as subject_count,
                COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
            FROM students s
            JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.term = ? AND sc.academic_year = ? AND sc.class_id = ?
            WHERE s.school_id = ?
            GROUP BY s.id
            HAVING subject_count > 0
            ORDER BY average_score DESC
        `, [term, academicYear, classId, schoolId]);

        // Process results for this class
        const processedResults = results.map((student, index) => {
            const avgScore = Number(student.average_score) || 0;
            const percentage = ((avgScore / 100) * 100).toFixed(2);

            return {
                ...student,
                first_name: studentDisplayName(student),
                last_name: '',
                average_score: avgScore,
                position: index + 1,
                percentage: isNaN(percentage) ? '0.00' : percentage,
                formattedAverage: avgScore.toFixed(2)
            };
        });

        // Create classReports array with just this one class
        const classReports = [{
            classInfo: classInfo,
            students: processedResults,
            studentCount: processedResults.length
        }];

        res.render('term-report', {
            term: term,
            academicYear: academicYear,
            classReports: classReports,
            termName: `${term} Report - ${classInfo.className}`,
            error: null,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications     // ADD THIS LINE
        });

    } catch (error) {
        console.error(`Error generating ${term} report:`, error);

        res.render('term-report', {
            term: term,
            academicYear: '',
            classReports: [],
            termName: `${term} Report`,
            error: `Failed to generate ${term} report: ${error.message}`,
            username: res.req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                                 // ADD THIS LINE
            totalCount: 0,                                  // ADD THIS LINE
            notifications: []                               // ADD THIS LINE
        });
    }
}

// Add this API endpoint to your SchoolApp.js
router.get('/api/subjects-by-class', authenticate, async (req, res) => {
    const { classId } = req.query;
    
    try {
        const connection = await getConnection();
        
        const [subjects] = await connection.execute(`
            SELECT s.id, s.name 
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
            ORDER BY s.name
        `, [classId]);
        
        res.json({
            success: true,
            subjects: subjects
        });
        
    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch subjects'
        });
    }
});

// /enter-scores route — connections are released via releaseConnection() and request cleanup
router.get('/enter-scores', authenticate, async (req, res) => {
    let connection = null;
    try {
        connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const teacherId = req.session.userId;
        const userRole = req.session.role;
        const adminId = req.session.userId;
        const username = req.session.username || 'Teacher';
        const { classId, term, academicYear, action, studentId } = req.query;

        // ============================================================
        // IF action=enter AND studentId is provided, show individual score entry
        // ============================================================
        if (action === 'enter' && studentId) {
            // Get student details
            const [students] = await connection.execute(`
                SELECT s.*, c.className, c.level, c.department
                FROM students s
                LEFT JOIN classes c ON s.classId = c.id
                WHERE s.id = ? AND s.school_id = ?
            `, [studentId, schoolId]);

            if (students.length === 0) {
                if (connection) { releaseConnection(connection); connection = null; }
                return res.redirect('/enter-scores?error=Student not found');
            }

            const student = students[0];

            // Get subjects for this class
            const [subjects] = await connection.execute(`
                SELECT s.id, s.name, s.subject_code
                FROM subjects s
                JOIN class_subjects cs ON s.id = cs.subject_id
                WHERE cs.class_id = ?
                ORDER BY s.name
            `, [classId]);

            // Get existing scores for this student in this specific class
            const [existingScores] = await connection.execute(`
                SELECT subject_id, test_score, exam_score
                FROM student_scores
                WHERE student_id = ? AND term = ? AND academic_year = ? AND class_id = ?
            `, [studentId, term, academicYear, classId]);

            // Create a map of existing scores
            const scoreMap = {};
            existingScores.forEach(score => {
                scoreMap[score.subject_id] = {
                    test_score: score.test_score,
                    exam_score: score.exam_score
                };
            });

            // Prepare subjects with existing scores
            const subjectsWithScores = subjects.map(subject => ({
                id: subject.id,
                name: subject.name,
                subject_code: subject.subject_code,
                test_score: scoreMap[subject.id] ? scoreMap[subject.id].test_score : 0,
                exam_score: scoreMap[subject.id] ? scoreMap[subject.id].exam_score : 0
            }));

            // Load existing teacher / management comments for this term and for session
            let teacherCommentText = '';
            let managementCommentText = '';
            let sessionTeacherCommentText = '';
            let sessionManagementCommentText = '';
            try {
                await ensureStudentCommentsTable(connection);
                const commentsHaveClassId = await tableHasColumn(connection, 'student_comments', 'class_id');
                const commentRows = commentsHaveClassId
                    ? (await connection.execute(`
                        SELECT term, comment_type, comment
                        FROM student_comments
                        WHERE student_id = ? AND academic_year = ? AND class_id = ?
                          AND term IN (?, 'Session')
                          AND comment_type IN ('teacher', 'management')
                    `, [studentId, academicYear, classId, term]))[0]
                    : (await connection.execute(`
                        SELECT term, comment_type, comment
                        FROM student_comments
                        WHERE student_id = ? AND academic_year = ?
                          AND term IN (?, 'Session')
                          AND comment_type IN ('teacher', 'management')
                    `, [studentId, academicYear, term]))[0];

                commentRows.forEach((row) => {
                    if (row.term === term && row.comment_type === 'teacher') teacherCommentText = row.comment || '';
                    if (row.term === term && row.comment_type === 'management') managementCommentText = row.comment || '';
                    if (row.term === 'Session' && row.comment_type === 'teacher') sessionTeacherCommentText = row.comment || '';
                    if (row.term === 'Session' && row.comment_type === 'management') sessionManagementCommentText = row.comment || '';
                });
            } catch (commentErr) {
                console.warn('Could not load student comments:', commentErr.message);
            }

            // Get unread notifications
            let unreadCount = 0;
            let notificationTotal = 0;
            let notifications = [];

            if (userRole === 'admin') {
                try {
                    const [tableCheck] = await connection.execute(`
                        SELECT COUNT(*) as count FROM information_schema.tables 
                        WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
                    `);
                    if (tableCheck[0].count > 0) {
                        const [unreadResult] = await connection.execute(`
                            SELECT COUNT(*) as count FROM admin_notifications 
                            WHERE admin_id = ? AND is_read = 0
                        `, [adminId]);
                        unreadCount = unreadResult[0]?.count || 0;

                        const [totalResult] = await connection.execute(`
                            SELECT COUNT(*) as total FROM admin_notifications 
                            WHERE admin_id = ?
                        `, [adminId]);
                        notificationTotal = totalResult[0]?.total || 0;

                        const [notificationList] = await connection.execute(`
                            SELECT id, message, is_read, 
                                   DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                            FROM admin_notifications 
                            WHERE admin_id = ?
                            ORDER BY created_at DESC 
                            LIMIT 10
                        `, [adminId]);
                        notifications = notificationList;
                    }
                } catch (err) {
                    console.error('Error fetching admin notifications:', err.message);
                    unreadCount = 0;
                    notificationTotal = 0;
                    notifications = [];
                }
            } else if (userRole === 'teacher') {
                try {
                    const [tableCheck] = await connection.execute(`
                        SELECT COUNT(*) as count FROM information_schema.tables 
                        WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
                    `);
                    if (tableCheck[0].count > 0) {
                        const [unreadResult] = await connection.execute(`
                            SELECT COUNT(*) as count FROM teacher_notifications 
                            WHERE teacher_id = ? AND is_read = 0
                        `, [teacherId]);
                        unreadCount = unreadResult[0]?.count || 0;

                        const [totalResult] = await connection.execute(`
                            SELECT COUNT(*) as total FROM teacher_notifications 
                            WHERE teacher_id = ?
                        `, [teacherId]);
                        notificationTotal = totalResult[0]?.total || 0;

                        const [notificationList] = await connection.execute(`
                            SELECT id, message, is_read, 
                                   DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                            FROM teacher_notifications 
                            WHERE teacher_id = ?
                            ORDER BY created_at DESC 
                            LIMIT 10
                        `, [teacherId]);
                        notifications = notificationList;
                    }
                } catch (err) {
                    console.error('Error fetching teacher notifications:', err.message);
                    unreadCount = 0;
                    notificationTotal = 0;
                    notifications = [];
                }
            }

            // Close connection before rendering
            if (connection) { releaseConnection(connection); connection = null; }

            // Render the individual score entry form
            return res.render('enter-scores-student', {
                studentId: student.id,
                studentFirstName: student.firstName,
                studentMiddleName: student.middleName || '',
                studentLastName: student.lastName,
                admissionNumber: student.admission_number || 'N/A',
                className: student.className || 'N/A',
                classLevel: student.level || 'N/A',
                classDepartment: student.department || null,
                classId: classId,
                term: term,
                termName: term,
                academicYear: academicYear,
                yearName: academicYear,
                subjects: subjectsWithScores,
                teacherComment: teacherCommentText,
                managementComment: managementCommentText,
                sessionTeacherComment: sessionTeacherCommentText,
                sessionManagementComment: sessionManagementCommentText,
                username: username,
                role: userRole,
                userId: req.session.userId,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment'),
                error: req.query.error || null,
                success: req.query.success || null,
                title: 'Enter Scores - Student',
                currentPage: 'enter-scores'
            });
        }

        // ============================================================
        // IF classId, term, academicYear are provided (show student list)
        // ============================================================
        if (classId && term && academicYear) {
            // Get class details
            const [classData] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE id = ? AND school_id = ?
            `, [classId, schoolId]);

            if (classData.length === 0) {
                if (connection) { releaseConnection(connection); connection = null; }
                return res.redirect('/enter-scores?error=Class not found');
            }

            const classInfo = classData[0];

            // Get students in this class with their score progress
            const [students] = await connection.execute(`
                SELECT 
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.admission_number,
                    s.department as student_department,
                    COUNT(DISTINCT cs.subject_id) as total_subjects,
                    COUNT(DISTINCT sc.id) as scores_entered
                FROM students s
                LEFT JOIN class_subjects cs ON cs.class_id = s.classId
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.subject_id = cs.subject_id
                    AND sc.term = ? 
                    AND sc.academic_year = ?
                    AND sc.class_id = ?
                WHERE s.classId = ? AND s.school_id = ?
                GROUP BY s.id
                ORDER BY s.lastName, s.firstName
            `, [term, academicYear, classId, classId, schoolId]);

            // Get unread notifications
            let unreadCount = 0;
            let notificationTotal = 0;
            let notifications = [];

            if (userRole === 'admin') {
                try {
                    const [tableCheck] = await connection.execute(`
                        SELECT COUNT(*) as count FROM information_schema.tables 
                        WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
                    `);
                    if (tableCheck[0].count > 0) {
                        const [unreadResult] = await connection.execute(`
                            SELECT COUNT(*) as count FROM admin_notifications 
                            WHERE admin_id = ? AND is_read = 0
                        `, [adminId]);
                        unreadCount = unreadResult[0]?.count || 0;

                        const [totalResult] = await connection.execute(`
                            SELECT COUNT(*) as total FROM admin_notifications 
                            WHERE admin_id = ?
                        `, [adminId]);
                        notificationTotal = totalResult[0]?.total || 0;

                        const [notificationList] = await connection.execute(`
                            SELECT id, message, is_read, 
                                   DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                            FROM admin_notifications 
                            WHERE admin_id = ?
                            ORDER BY created_at DESC 
                            LIMIT 10
                        `, [adminId]);
                        notifications = notificationList;
                    }
                } catch (err) {
                    console.error('Error fetching admin notifications:', err.message);
                    unreadCount = 0;
                    notificationTotal = 0;
                    notifications = [];
                }
            } else if (userRole === 'teacher') {
                try {
                    const [tableCheck] = await connection.execute(`
                        SELECT COUNT(*) as count FROM information_schema.tables 
                        WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
                    `);
                    if (tableCheck[0].count > 0) {
                        const [unreadResult] = await connection.execute(`
                            SELECT COUNT(*) as count FROM teacher_notifications 
                            WHERE teacher_id = ? AND is_read = 0
                        `, [teacherId]);
                        unreadCount = unreadResult[0]?.count || 0;

                        const [totalResult] = await connection.execute(`
                            SELECT COUNT(*) as total FROM teacher_notifications 
                            WHERE teacher_id = ?
                        `, [teacherId]);
                        notificationTotal = totalResult[0]?.total || 0;

                        const [notificationList] = await connection.execute(`
                            SELECT id, message, is_read, 
                                   DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                            FROM teacher_notifications 
                            WHERE teacher_id = ?
                            ORDER BY created_at DESC 
                            LIMIT 10
                        `, [teacherId]);
                        notifications = notificationList;
                    }
                } catch (err) {
                    console.error('Error fetching teacher notifications:', err.message);
                    unreadCount = 0;
                    notificationTotal = 0;
                    notifications = [];
                }
            }

            // Close connection before rendering
            if (connection) { releaseConnection(connection); connection = null; }

            // Render the student list view
            return res.render('enter-scores-list', {
                students: students,
                classId: classId,
                className: classInfo.className,
                classLevel: classInfo.level,
                classDepartment: classInfo.department,
                term: term,
                termName: term,
                academicYear: academicYear,
                yearName: academicYear,
                username: username,
                role: userRole,
                userId: req.session.userId,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment'),
                error: req.query.error || null,
                success: req.query.success || null,
                title: 'Select Student - Score Entry',
                currentPage: 'enter-scores'
            });
        }

        // ============================================================
        // DEFAULT: Show the selection page
        // ============================================================

        // Get unread notifications count for the topbar (for admin users)
        let unreadCount = 0;
        let notificationTotal = 0;
        let notifications = [];

        // Only fetch notifications for admin users (teachers have their own notification system)
        if (userRole === 'admin') {
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
                               DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
        } else if (userRole === 'teacher') {
            // For teachers, get teacher notifications
            try {
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [unreadResult] = await connection.execute(`
                        SELECT COUNT(*) as count FROM teacher_notifications 
                        WHERE teacher_id = ? AND is_read = 0
                    `, [teacherId]);
                    unreadCount = unreadResult[0]?.count || 0;

                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total FROM teacher_notifications 
                        WHERE teacher_id = ?
                    `, [teacherId]);
                    notificationTotal = totalResult[0]?.total || 0;
                }
            } catch (err) {
                unreadCount = 0;
                notificationTotal = 0;
            }
        }

        // Get academic years and terms for the user's school
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms WHERE school_id = ? ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `, [schoolId]);

        // Get current academic year and term for the user's school
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        // Set default values
        const defaultAcademicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '';
        const defaultTerm = currentTerm.length > 0 ? currentTerm[0].term_name : '';

        // Get teacher's assigned classes (for teachers only)
        let teacherClasses = [];
        let allClasses = [];

        if (userRole === 'teacher') {
            // Get ONLY classes assigned to this teacher
            [teacherClasses] = await connection.execute(`
                SELECT c.id, c.className, c.level, c.department, c.classCode
                FROM classes c
                WHERE c.professorId = ? AND c.school_id = ?
                ORDER BY 
                    CASE c.level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    c.className
            `, [teacherId, schoolId]);
            allClasses = teacherClasses;
        } else {
            // Admin can see all classes
            [allClasses] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ?
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `, [schoolId]);
        }

        // Close connection before rendering
        if (connection) { releaseConnection(connection); connection = null; }

        // If teacher has no classes, show appropriate message
        if (userRole === 'teacher' && teacherClasses.length === 0) {
            return res.render('enter-scores-selection', {
                classes: [],
                teacherClasses: [],
                academicYears: academicYears,
                terms: terms,
                currentAcademicYear: defaultAcademicYear,
                currentTerm: defaultTerm,
                formData: {
                    classId: classId || '',
                    term: term || defaultTerm,
                    academicYear: academicYear || defaultAcademicYear
                },
                error: 'You are not assigned to any classes. Please contact the school administrator.',
                success: null,
                title: 'Select Criteria for Score Entry',
                currentPage: 'enter-scores',
                username: username,
                role: userRole,
                userId: req.session.userId,
                unreadCount: unreadCount,
                totalCount: notificationTotal,
                notifications: notifications,
                moment: require('moment')
            });
        }

        // Create formData object
        const formData = {
            classId: classId || '',
            term: term || defaultTerm,
            academicYear: academicYear || defaultAcademicYear
        };

        res.render('enter-scores-selection', {
            classes: allClasses,
            teacherClasses: teacherClasses,
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: defaultAcademicYear,
            currentTerm: defaultTerm,
            formData: formData,
            error: req.query.error || null,
            success: req.query.success || null,
            title: 'Select Criteria for Score Entry',
            currentPage: 'enter-scores',
            username: username,
            role: userRole,
            userId: req.session.userId,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading score entry form:', error);

        // IMPORTANT: Close connection on error
        if (connection) {
            try {
                releaseConnection(connection);
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }

        // Get classes for error fallback - use a separate connection
        let allClasses = [];
        let academicYears = [];
        let terms = [];
        let fallbackConnection = null;

        try {
            fallbackConnection = await getConnection();
            const schoolId = req.session.schoolId || null;
            const role = req.session.role;
            const teacherId = req.session.userId;

            if (role === 'teacher') {
                [allClasses] = await fallbackConnection.execute(`
                    SELECT c.id, c.className, c.level, c.department 
                    FROM classes c
                    WHERE c.professorId = ? AND c.school_id = ?
                    ORDER BY c.className
                `, [teacherId, schoolId]);
            } else {
                [allClasses] = await fallbackConnection.execute(`
                    SELECT id, className, level, department 
                    FROM classes 
                    WHERE school_id = ? 
                    ORDER BY className
                `, [schoolId]);
            }

            [academicYears] = await fallbackConnection.execute(`
                SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
            `, [schoolId]);

            [terms] = await fallbackConnection.execute(`
                SELECT * FROM academic_terms WHERE school_id = ? ORDER BY start_date DESC
            `, [schoolId]);

        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        } finally {
            if (fallbackConnection) {
                try {
                    releaseConnection(fallbackConnection);
                } catch (endError) {
                    console.error('Error releasing fallback connection:', endError);
                }
            }
        }

        res.render('enter-scores-selection', {
            classes: allClasses,
            teacherClasses: allClasses,
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: '',
            currentTerm: '',
            formData: {
                classId: '',
                term: '',
                academicYear: ''
            },
            error: 'Failed to load form data: ' + error.message,
            title: 'Error',
            currentPage: 'enter-scores',
            username: req.session.username || 'Teacher',
            role: req.session.role || 'teacher',
            userId: req.session.userId || null,
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment')
        });
    }
});

// POST route to save individual student scores (AJAX) - FIXED

router.post('/api/save-student-score', authenticate, async (req, res) => {
    let connection = null;
    try {
        // Get connection first
        connection = await getConnection();

        const { studentId, subjectId, testScore, examScore, totalScore, grade, term, academicYear } = req.body;
        const schoolId = req.session.schoolId || null;
        const teacherId = req.session.userId;
        const role = req.session.role;

        // Validate inputs
        if (!studentId || !subjectId || !term || !academicYear) {
            if (connection) { releaseConnection(connection); }
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters'
            });
        }

        // IMPORTANT: Parse scores as FLOAT/NUMBER
        const testScoreNum = parseFloat(testScore) || 0;
        const examScoreNum = parseFloat(examScore) || 0;

        // Validate score ranges
        if (testScoreNum < 0 || testScoreNum > 40) {
            if (connection) { releaseConnection(connection); }
            return res.status(400).json({
                success: false,
                message: 'Test score must be between 0 and 40'
            });
        }
        if (examScoreNum < 0 || examScoreNum > 60) {
            if (connection) { releaseConnection(connection); }
            return res.status(400).json({
                success: false,
                message: 'Exam score must be between 0 and 60'
            });
        }

        // If teacher, verify they have access to this student's class
        if (role === 'teacher') {
            const [classCheck] = await connection.execute(`
                SELECT c.id FROM classes c
                JOIN students s ON s.classId = c.id
                WHERE s.id = ? AND c.professorId = ? AND c.school_id = ?
            `, [studentId, teacherId, schoolId]);

            if (classCheck.length === 0) {
                if (connection) { releaseConnection(connection); }
                return res.status(403).json({
                    success: false,
                    message: 'You do not have permission to enter scores for this student'
                });
            }
        }

        let targetClassId = req.body.classId;
        if (!targetClassId) {
            const [st] = await connection.execute('SELECT classId, school_id FROM students WHERE id = ?', [studentId]);
            if (st.length > 0) {
                targetClassId = st[0].classId;
                if (!schoolId) schoolId = st[0].school_id;
            }
        }

        // Check if record exists for this class
        const [existing] = await connection.execute(
            `SELECT id FROM student_scores 
             WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?`,
            [studentId, subjectId, term, academicYear, targetClassId]
        );

        if (existing.length > 0) {
            // Update existing record with parsed numbers
            await connection.execute(
                `UPDATE student_scores 
                 SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW() 
                 WHERE id = ?`,
                [testScoreNum, examScoreNum, schoolId, existing[0].id]
            );
        } else {
            // Insert new record with parsed numbers and class_id
            await connection.execute(
                `INSERT INTO student_scores 
                 (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [studentId, subjectId, term, academicYear, targetClassId, schoolId, testScoreNum, examScoreNum]
            );
        }

        // Close connection before sending success response
        if (connection) { releaseConnection(connection); }

        res.json({
            success: true,
            message: 'Score saved successfully'
        });

    } catch (error) {
        console.error('Error saving student score:', error);

        // Close connection on error
        if (connection) {
            try {
                releaseConnection(connection);
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }

        res.status(500).json({
            success: false,
            message: 'Failed to save score: ' + error.message
        });
    }
});

// POST route to save all student scores (bulk save)
router.post('/save-student-scores', authenticate, uploadNoFile.none(), async (req, res) => {
    let connection = null;
    const { studentId, classId, term, academicYear, subjects, testScores, examScores } = req.body;

    try {
        connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const teacherId = req.session.userId;
        const role = req.session.role;

        if (!studentId || !classId || !term || !academicYear || !subjects) {
            if (connection) { releaseConnection(connection); }
            return res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&error=Missing required parameters`);
        }

        // If teacher, verify they have access to this class
        if (role === 'teacher') {
            const [classCheck] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [classId, teacherId, schoolId]);

            if (classCheck.length === 0) {
                if (connection) { releaseConnection(connection); }
                return res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&error=You do not have permission to enter scores for this class`);
            }
        }

        // Convert to arrays if needed
        const subjectIds = Array.isArray(subjects) ? subjects : [subjects];
        const testScoresArray = testScores ? (Array.isArray(testScores) ? testScores : [testScores]) : [];
        const examScoresArray = examScores ? (Array.isArray(examScores) ? examScores : [examScores]) : [];

        // Start transaction
        await connection.beginTransaction();

        try {
            for (let i = 0; i < subjectIds.length; i++) {
                const subjectId = subjectIds[i];
                const testScore = parseFloat(testScoresArray[i]) || 0;
                const examScore = parseFloat(examScoresArray[i]) || 0;
                const totalScore = testScore + examScore;

                // Validate score ranges
                if (testScore < 0 || testScore > 40) {
                    throw new Error(`Test score for subject must be between 0 and 40`);
                }
                if (examScore < 0 || examScore > 60) {
                    throw new Error(`Exam score for subject must be between 0 and 60`);
                }

                // Check if record exists for this class
                const [existing] = await connection.execute(
                    'SELECT id FROM student_scores WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?',
                    [studentId, subjectId, term, academicYear, classId]
                );

                if (existing.length > 0) {
                    // Update existing
                    await connection.execute(
                        'UPDATE student_scores SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW() WHERE id = ?',
                        [testScore, examScore, schoolId, existing[0].id]
                    );
                } else {
                    // Insert new with class_id and school_id
                    await connection.execute(
                        'INSERT INTO student_scores (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
                        [studentId, subjectId, term, academicYear, classId, schoolId, testScore, examScore]
                    );
                }
            }

            await connection.commit();

            // Close connection before redirect
            if (connection) { releaseConnection(connection); }

            res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&success=Scores saved successfully`);

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error saving student scores:', error);

        // Close connection on error
        if (connection) {
            try {
                releaseConnection(connection);
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }

        res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&error=${encodeURIComponent(error.message)}`);
    }
});

// API endpoint to get subjects for a class (for AJAX)
router.get('/api/subjects-by-class', authenticate, async (req, res) => {
    const { classId } = req.query;
    const teacherId = req.session.userId;
    const role = req.session.role;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // If teacher, verify they have access to this class
        if (role === 'teacher') {
            const [classCheck] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [classId, teacherId, schoolId]);
            
            if (classCheck.length === 0) {
                return res.status(403).json({
                    success: false,
                    error: 'You do not have permission to access this class'
                });
            }
        }
        
        const [subjects] = await connection.execute(`
            SELECT s.id, s.name, s.subject_code
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
            ORDER BY s.name
        `, [classId]);
        
        res.json({
            success: true,
            subjects: subjects
        });
        
    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch subjects'
        });
    }
});

// POST route to save individual student scores (AJAX)
router.post('/api/save-student-score', authenticate, async (req, res) => {
    const { studentId, subjectId, score, grade, remark, term, academicYear } = req.body;
    
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        
        // Validate inputs
        if (!studentId || !subjectId || !term || !academicYear) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required parameters' 
            });
        }
        
        // Validate score range
        const scoreValue = score !== null && score !== '' ? parseFloat(score) : null;
        if (scoreValue !== null && (scoreValue < 0 || scoreValue > 100)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Score must be between 0 and 100' 
            });
        }
        
        let targetClassId = req.body.classId;
        if (!targetClassId) {
            const [st] = await connection.execute('SELECT classId, school_id FROM students WHERE id = ?', [studentId]);
            if (st.length > 0) {
                targetClassId = st[0].classId;
                if (!schoolId) schoolId = st[0].school_id;
            }
        }

        // Check if record exists for this class
        const [existing] = await connection.execute(
            `SELECT id FROM student_scores 
             WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?`,
            [studentId, subjectId, term, academicYear, targetClassId]
        );
        
        let testScore = scoreValue || 0;
        let examScore = 0;
        
        if (existing.length > 0) {
            // Update existing record
            await connection.execute(
                `UPDATE student_scores 
                 SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW() 
                 WHERE id = ?`,
                [testScore, examScore, schoolId, existing[0].id]
            );
        } else {
            // Insert new record with class_id and school_id
            await connection.execute(
                `INSERT INTO student_scores 
                 (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [studentId, subjectId, term, academicYear, targetClassId, schoolId, testScore, examScore]
            );
        }
        
        res.json({ 
            success: true, 
            message: 'Score saved successfully' 
        });
        
    } catch (error) {
        console.error('Error saving student score:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to save score: ' + error.message 
        });
    }
});

// POST route to save all student scores (bulk save)
router.post('/save-student-scores', authenticate, uploadNoFile.none(), async (req, res) => {
    const { studentId, classId, term, academicYear, subjects, testScores, examScores } = req.body;
    
    try {
        const connection = await getConnection();
        
        if (!studentId || !classId || !term || !academicYear || !subjects) {
            return res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&error=Missing required parameters`);
        }
        
        // Convert to arrays if needed
        const subjectIds = Array.isArray(subjects) ? subjects : [subjects];
        const testScoresArray = testScores ? (Array.isArray(testScores) ? testScores : [testScores]) : [];
        const examScoresArray = examScores ? (Array.isArray(examScores) ? examScores : [examScores]) : [];
        
        // Start transaction
        await connection.beginTransaction();
        
        try {
            for (let i = 0; i < subjectIds.length; i++) {
                const subjectId = subjectIds[i];
                const testScore = parseFloat(testScoresArray[i]) || 0;
                const examScore = parseFloat(examScoresArray[i]) || 0;
                const totalScore = testScore + examScore;
                
                // Validate score ranges
                if (testScore < 0 || testScore > 40) {
                    throw new Error(`Test score for subject must be between 0 and 40`);
                }
                if (examScore < 0 || examScore > 60) {
                    throw new Error(`Exam score for subject must be between 0 and 60`);
                }
                
                // Check if record exists for this class
                const [existing] = await connection.execute(
                    'SELECT id FROM student_scores WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?',
                    [studentId, subjectId, term, academicYear, classId]
                );
                
                if (existing.length > 0) {
                    // Update existing
                    await connection.execute(
                        'UPDATE student_scores SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW() WHERE id = ?',
                        [testScore, examScore, req.session.schoolId || null, existing[0].id]
                    );
                } else {
                    // Insert new with class_id and school_id
                    await connection.execute(
                        'INSERT INTO student_scores (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
                        [studentId, subjectId, term, academicYear, classId, req.session.schoolId || null, testScore, examScore]
                    );
                }
            }
            
            await connection.commit();
            res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&success=Scores saved successfully`);
            
        } catch (error) {
            await connection.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('Error saving student scores:', error);
        res.redirect(`/enter-scores?action=enter&studentId=${studentId}&classId=${classId}&term=${term}&academicYear=${academicYear}&error=${encodeURIComponent(error.message)}`);
    }
});

// Broadsheet Routes - Updated
router.get('/broadsheet', authenticate, requireRole('admin'), async (req, res) => {
    const { classId, term, academicYear } = req.query;

    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get all classes with levels and departments for the user's school
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY className
        `, [schoolId]);

        // Get available academic years for the user's school
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        if (!classId || !term || !academicYear) {
            // Show selection form - pass formData with proper structure
            res.render('broadsheet-selection', {
                classes,
                academicYears,
                terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
                formData: {
                    classId: classId || '',
                    term: term || '',
                    academicYear: academicYear || ''
                },
                error: req.query.error || null,
                username: username,              // ADD THIS LINE
                unreadCount: unreadCount,        // ADD THIS LINE
                totalCount: notificationTotal,   // ADD THIS LINE
                notifications: notifications     // ADD THIS LINE
            });
        } else {
            // Generate broadsheet
            await generateBroadsheet(classId, term, academicYear, res);
        }
    } catch (error) {
        console.error('Error loading broadsheet selection:', error);

        // Get classes for error fallback
        let classes = [];
        let academicYears = [];

        try {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ? 
                ORDER BY className
            `, [schoolId]);
            [academicYears] = await connection.execute(`
                SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
            `, [schoolId]);
            releaseConnection(connection);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('broadsheet-selection', {
            classes: classes,
            academicYears: academicYears,
            terms: ['First Term', 'Second Term', 'Third Term', 'Session'],
            formData: {
                classId: '',
                term: '',
                academicYear: ''
            },
            error: 'Failed to load selection data: ' + error.message,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// Updated generateBroadsheet function with promotion logic and notifications
async function generateBroadsheet(classId, term, academicYear, res) {
    try {
        const connection = await getConnection();
        const schoolId = res.req.session.schoolId || null;
        const adminId = res.req.session.userId;
        const username = res.req.session.username || 'Admin';  // ADD THIS LINE

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get class info and verify it belongs to the user's school
        const [classResults] = await connection.execute('SELECT className, level, department FROM classes WHERE id = ? AND school_id = ?', [classId, schoolId]);

        if (classResults.length === 0) {
            return res.redirect('/broadsheet?error=Class not found or access denied');
        }

        const className = classResults[0].className;
        const classLevel = classResults[0].level;
        const classDepartment = classResults[0].department;

        if (term === 'Session') {
            // Session broadsheet - detailed format with all terms
            // Include students who took exams in this class, or were promoted from it, or are currently in this class
            const [students] = await connection.execute(`
                SELECT DISTINCT s.id, s.firstName, s.middleName, s.lastName, s.department
                FROM students s 
                LEFT JOIN student_scores sc ON sc.student_id = s.id AND sc.class_id = ? AND sc.academic_year = ?
                LEFT JOIN promotion_history ph ON ph.student_id = s.id AND ph.from_class = ? AND ph.academic_year = ?
                WHERE (s.school_id = ? OR ? IS NULL)
                  AND (
                    sc.id IS NOT NULL 
                    OR ph.id IS NOT NULL 
                    OR (s.classId = ? AND NOT EXISTS (
                        SELECT 1 FROM student_scores sc_other 
                        WHERE sc_other.student_id = s.id 
                          AND sc_other.academic_year = ? 
                          AND sc_other.class_id != ?
                    ))
                  )
                ORDER BY s.lastName, s.firstName
            `, [classId, academicYear, classId, academicYear, schoolId, schoolId, classId, academicYear, classId]);

            // Get all subjects taught in this class or having scores in this class
            const [subjects] = await connection.execute(`
                SELECT DISTINCT sub.id, sub.name 
                FROM subjects sub
                WHERE sub.id IN (
                    SELECT cs.subject_id FROM class_subjects cs WHERE cs.class_id = ?
                    UNION
                    SELECT sc.subject_id FROM student_scores sc WHERE sc.class_id = ? AND sc.academic_year = ?
                )
                ORDER BY sub.name
            `, [classId, classId, academicYear]);

            // Get scores for all students and subjects across all terms FOR THIS CLASS ONLY
            const [scores] = await connection.execute(`
                SELECT 
                    sc.student_id,
                    sc.subject_id,
                    sc.term,
                    COALESCE(sc.test_score, 0) as test_score,
                    COALESCE(sc.exam_score, 0) as exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
                FROM student_scores sc
                WHERE sc.class_id = ? AND sc.academic_year = ?
                ORDER BY sc.student_id, sc.subject_id, sc.term
            `, [classId, academicYear]);

            // Organize scores by student and subject
            const scoreMap = {};
            scores.forEach(score => {
                if (!scoreMap[score.student_id]) {
                    scoreMap[score.student_id] = {};
                }
                if (!scoreMap[score.student_id][score.subject_id]) {
                    scoreMap[score.student_id][score.subject_id] = {};
                }
                scoreMap[score.student_id][score.subject_id][score.term] = {
                    test: score.test_score,
                    exam: score.exam_score,
                    total: score.total_score
                };
            });

            // Calculate student results with promotion logic
            const studentResults = students.map(student => {
                const studentScores = scoreMap[student.id] || {};
                let subjectAverages = [];
                let totalMarks = 0;
                let subjectsWithScores = 0;

                subjects.forEach(subject => {
                    const termScores = studentScores[subject.id] || {};
                    const firstTerm = parseFloat(termScores['First Term']?.total) || 0;
                    const secondTerm = parseFloat(termScores['Second Term']?.total) || 0;
                    const thirdTerm = parseFloat(termScores['Third Term']?.total) || 0;

                    // Calculate average for this subject across all terms
                    const average = (firstTerm + secondTerm + thirdTerm) / 3;
                    subjectAverages.push({
                        subject: subject.name,
                        subjectId: subject.id,
                        firstTerm: firstTerm.toFixed(1),
                        secondTerm: secondTerm.toFixed(1),
                        thirdTerm: thirdTerm.toFixed(1),
                        average: parseFloat(average.toFixed(2))
                    });

                    totalMarks += average;
                    if (average > 0) subjectsWithScores++;
                });

                // Calculate overall average and percentage
                const overallAverage = subjectsWithScores > 0 ? totalMarks / subjectsWithScores : 0;
                const percentage = parseFloat(overallAverage.toFixed(2));

                // Determine grade
                let grade = 'F';
                if (percentage >= 80) grade = 'A';
                else if (percentage >= 70) grade = 'B';
                else if (percentage >= 60) grade = 'C';
                else if (percentage >= 50) grade = 'D';
                else if (percentage >= 40) grade = 'E';

                // Determine promotion status (45% and above promotes, below 45% repeats)
                let promotionStatus = 'Repeat';
                let promotionAction = 'repeat';
                let promotionClass = 'danger';

                if (percentage >= 45) {
                    promotionStatus = 'Promote';
                    promotionAction = 'promote';
                    promotionClass = 'success';
                }

                return {
                    id: student.id,
                    firstName: student.firstName,
                    middleName: student.middleName,
                    lastName: student.lastName,
                    department: student.department,
                    subjectAverages,
                    overallAverage: parseFloat(overallAverage.toFixed(2)),
                    percentage,
                    grade,
                    promotionStatus,
                    promotionAction,
                    promotionClass,
                    total: parseFloat(totalMarks.toFixed(2)),
                    totalSubjects: subjects.length,
                    subjectsWithScores,
                    position: 0
                };
            });

            // Sort students by percentage and assign positions
            studentResults.sort((a, b) => b.percentage - a.percentage);
            studentResults.forEach((student, index) => {
                student.position = index + 1;
            });

            res.render('broadsheet', {
                selectedClass: {
                    id: classId,
                    name: className,
                    level: classLevel,
                    department: classDepartment
                },
                term: term.toLowerCase(),
                academicYear,
                results: studentResults,
                subjects: subjects,
                isSessionReport: true,
                error: null,
                username: username,              // ADD THIS LINE
                unreadCount: unreadCount,        // ADD THIS LINE
                totalCount: notificationTotal,   // ADD THIS LINE
                notifications: notifications     // ADD THIS LINE
            });

        } else {
            // Term broadsheet (simple format)
            const [results] = await connection.execute(`
                SELECT 
                    s.id as student_id,
                    s.firstName as first_name,
                    s.middleName as middle_name,
                    s.lastName as last_name,
                    COUNT(DISTINCT sc.subject_id) as subject_count,
                    COALESCE(SUM(sc.test_score + sc.exam_score), 0) as total_score,
                    COALESCE(AVG(sc.test_score + sc.exam_score), 0) as average_score
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.term = ? AND sc.academic_year = ? AND sc.class_id = ?
                WHERE (s.classId = ? OR sc.id IS NOT NULL) AND (s.school_id = ? OR ? IS NULL)
                GROUP BY s.id
                HAVING subject_count > 0
                ORDER BY average_score DESC
            `, [term, academicYear, classId, classId, schoolId, schoolId]);

            const processedResults = results.map((student, index) => {
                const avgScore = Number(student.average_score) || 0;
                const percentage = ((avgScore / 100) * 100).toFixed(2);

                return {
                    ...student,
                    first_name: studentDisplayName(student),
                    last_name: '',
                    average_score: avgScore.toFixed(2),
                    position: index + 1,
                    percentage: isNaN(percentage) ? '0.00' : percentage
                };
            });

            res.render('broadsheet', {
                selectedClass: {
                    id: classId,
                    name: className,
                    level: classLevel,
                    department: classDepartment
                },
                term: term.toLowerCase(),
                academicYear,
                results: processedResults,
                subjects: [],
                isSessionReport: false,
                error: null,
                username: username,              // ADD THIS LINE
                unreadCount: unreadCount,        // ADD THIS LINE
                totalCount: notificationTotal,   // ADD THIS LINE
                notifications: notifications     // ADD THIS LINE
            });
        }
    } catch (error) {
        console.error('Error generating broadsheet:', error);
        res.redirect('/broadsheet?error=Failed to generate broadsheet');
    }
}

// POST route to promote student
router.post('/promote-student/:studentId', authenticate, requireRole('admin'), async (req, res) => {
    const { studentId } = req.params;
    const { academicYear, nextClassId } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate nextClassId
        if (!nextClassId || nextClassId === 'undefined') {
            return res.status(400).json({ 
                success: false, 
                error: 'Next class ID is required for promotion' 
            });
        }
        
        // Get current student info
        const [student] = await connection.execute(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Verify next class exists
        const [nextClass] = await connection.execute(
            'SELECT id, className FROM classes WHERE id = ?',
            [nextClassId]
        );
        
        if (nextClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Next class not found' });
        }
        
        // Ensure past unassigned scores remain attached to the previous class
        await connection.execute(
            'UPDATE student_scores SET class_id = ? WHERE student_id = ? AND (class_id IS NULL OR class_id = 0)',
            [student[0].classId, studentId]
        );

        // Update student class to next class
        await connection.execute(
            'UPDATE students SET classId = ? WHERE id = ?',
            [nextClassId, studentId]
        );
        
        // Record promotion in promotion history
        await connection.execute(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES (?, ?, ?, ?, ?)',
            [studentId, student[0].classId, nextClassId, academicYear, 'promoted']
        );
        
        res.json({ 
            success: true, 
            message: `Student promoted successfully to ${nextClass[0].className}` 
        });
        
    } catch (error) {
        console.error('Error promoting student:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to promote student: ' + error.message 
        });
    }
});

// POST route to promote multiple students at once
router.post('/promote-all-students', authenticate, requireRole('admin'), async (req, res) => {
    const { studentIds, nextClassId, academicYear } = req.body;

    try {
        // Validate
        if (!Array.isArray(studentIds) || studentIds.length === 0) {
            return res.status(400).json({ success: false, error: 'No students provided' });
        }
        if (!nextClassId || nextClassId === 'undefined') {
            return res.status(400).json({ success: false, error: 'Destination class is required' });
        }
        if (!academicYear) {
            return res.status(400).json({ success: false, error: 'Academic year is required' });
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        // Verify destination class exists and belongs to this school
        const [nextClass] = await connection.execute(
            'SELECT id, className FROM classes WHERE id = ? AND school_id = ?',
            [nextClassId, schoolId]
        );

        if (nextClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Destination class not found' });
        }

        const nextClassName = nextClass[0].className;

        // Fetch all students in one query, verify they belong to this school
        const placeholders = studentIds.map(() => '?').join(',');
        const [students] = await connection.execute(
            `SELECT id, classId, firstName, middleName, lastName 
             FROM students 
             WHERE id IN (${placeholders}) AND school_id = ?`,
            [...studentIds, schoolId]
        );

        if (students.length === 0) {
            return res.status(404).json({ success: false, error: 'No valid students found' });
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            let promotedCount = 0;
            const errors = [];

            for (const student of students) {
                try {
                    const fromClassId = student.classId;

                    // Skip if already in the destination class
                    if (String(fromClassId) === String(nextClassId)) {
                        continue;
                    }

                    // Ensure past unassigned scores remain attached to the from_class
                    await connection.execute(
                        'UPDATE student_scores SET class_id = ? WHERE student_id = ? AND (class_id IS NULL OR class_id = 0)',
                        [fromClassId, student.id]
                    );

                    // Update student's class
                    await connection.execute(
                        'UPDATE students SET classId = ? WHERE id = ? AND school_id = ?',
                        [nextClassId, student.id, schoolId]
                    );

                    // Log in promotion history
                    await connection.execute(
                        `INSERT INTO promotion_history 
                         (student_id, from_class, to_class, academic_year, action) 
                         VALUES (?, ?, ?, ?, ?)`,
                        [student.id, fromClassId, nextClassId, academicYear, 'promoted']
                    );

                    promotedCount++;
                } catch (studentError) {
                    const name = typeof studentDisplayName === 'function' ? studentDisplayName(student) : [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ');
                    errors.push(`${name}: ${studentError.message}`);
                    console.error(`Error promoting student ${student.id}:`, studentError);
                }
            }

            if (promotedCount === 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    error: 'No students were promoted. ' + (errors.length ? errors.join('; ') : '')
                });
            }

            await connection.commit();

            let message = `Successfully promoted ${promotedCount} student(s) to ${nextClassName}.`;
            if (errors.length > 0) {
                message += ` (${errors.length} failed)`;
            }

            res.json({
                success: true,
                message: message,
                promotedCount: promotedCount,
                failedCount: errors.length
            });

        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

    } catch (error) {
        console.error('Error promoting students:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to promote students: ' + error.message
        });
    }
});

// POST route to graduate multiple students at once
router.post('/graduate-all-students', authenticate, requireRole('admin'), async (req, res) => {
    const { studentIds, academicYear } = req.body;

    try {
        if (!Array.isArray(studentIds) || studentIds.length === 0) {
            return res.status(400).json({ success: false, error: 'No students provided' });
        }
        if (!academicYear) {
            return res.status(400).json({ success: false, error: 'Academic year is required' });
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        const placeholders = studentIds.map(() => '?').join(',');
        const [students] = await connection.execute(
            `SELECT id, classId, firstName, middleName, lastName, status
             FROM students
             WHERE id IN (${placeholders}) AND (school_id = ? OR ? IS NULL)`,
            [...studentIds, schoolId, schoolId]
        );

        if (students.length === 0) {
            return res.status(404).json({ success: false, error: 'No valid students found' });
        }

        const today = new Date().toISOString().split('T')[0];

        await connection.beginTransaction();

        try {
            let graduatedCount = 0;
            const errors = [];

            for (const student of students) {
                if (student.status === 'graduated') {
                    continue;
                }

                try {
                    await connection.execute(
                        `UPDATE students
                         SET status = 'graduated',
                             graduation_date = ?,
                             graduation_year = ?
                         WHERE id = ? AND (school_id = ? OR ? IS NULL)`,
                        [today, academicYear, student.id, schoolId, schoolId]
                    );

                    // Log in promotion history
                    try {
                        await connection.execute(
                            `INSERT INTO promotion_history
                             (student_id, from_class, to_class, academic_year, action)
                             VALUES (?, ?, ?, ?, ?)`,
                            [student.id, student.classId, null, academicYear, 'graduated']
                        );
                    } catch (hErr) {
                        await connection.execute(
                            `INSERT INTO promotion_history
                             (student_id, from_class, to_class, academic_year, action)
                             VALUES (?, ?, ?, ?, ?)`,
                            [student.id, student.classId, student.classId, academicYear, 'graduated']
                        );
                    }

                    graduatedCount++;
                } catch (studentError) {
                    const name = typeof studentDisplayName === 'function' ? studentDisplayName(student) : [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ');
                    errors.push(`${name}: ${studentError.message}`);
                    console.error(`Error graduating student ${student.id}:`, studentError);
                }
            }

            if (graduatedCount === 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    error: 'No students were graduated. ' + (errors.length ? errors.join('; ') : '')
                });
            }

            await connection.commit();

            let message = `Successfully marked ${graduatedCount} student(s) as graduated.`;
            if (errors.length > 0) {
                message += ` (${errors.length} failed)`;
            }

            res.json({
                success: true,
                message: message,
                graduatedCount: graduatedCount,
                failedCount: errors.length
            });

        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

    } catch (error) {
        console.error('Error graduating students:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to graduate students: ' + error.message
        });
    }
});

// POST route to mark a single student as graduated
router.post('/graduate-student/:studentId', authenticate, requireRole('admin'), async (req, res) => {
    const { studentId } = req.params;
    const { academicYear } = req.body;

    try {
        if (!academicYear) {
            return res.status(400).json({ success: false, error: 'Academic year is required' });
        }

        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        const [students] = await connection.execute(
            `SELECT id, classId, firstName, middleName, lastName, status
             FROM students
             WHERE id = ? AND (school_id = ? OR ? IS NULL)`,
            [studentId, schoolId, schoolId]
        );

        if (students.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }

        const student = students[0];
        if (student.status === 'graduated') {
            return res.status(400).json({ success: false, error: 'Student is already marked as graduated' });
        }

        const today = new Date().toISOString().split('T')[0];

        await connection.beginTransaction();

        try {
            await connection.execute(
                `UPDATE students
                 SET status = 'graduated',
                     graduation_date = ?,
                     graduation_year = ?
                 WHERE id = ? AND (school_id = ? OR ? IS NULL)`,
                [today, academicYear, studentId, schoolId, schoolId]
            );

            try {
                await connection.execute(
                    `INSERT INTO promotion_history
                     (student_id, from_class, to_class, academic_year, action)
                     VALUES (?, ?, ?, ?, ?)`,
                    [studentId, student.classId, null, academicYear, 'graduated']
                );
            } catch (histErr) {
                await connection.execute(
                    `INSERT INTO promotion_history
                     (student_id, from_class, to_class, academic_year, action)
                     VALUES (?, ?, ?, ?, ?)`,
                    [studentId, student.classId, student.classId, academicYear, 'graduated']
                );
            }

            await connection.commit();

            const name = typeof studentDisplayName === 'function' 
                ? studentDisplayName(student) 
                : [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' ');

            res.json({
                success: true,
                message: `Successfully marked ${name} as graduated.`
            });
        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

    } catch (error) {
        console.error('Error graduating single student:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to graduate student: ' + error.message
        });
    }
});

router.post('/repeat-student/:studentId', authenticate, requireRole('admin'), async (req, res) => {
    const { studentId } = req.params;
    const { academicYear } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Get current student info
        const [student] = await connection.execute(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );
        
        if (student.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Record repetition in promotion history (student stays in same class)
        await connection.execute(
            'INSERT INTO promotion_history (student_id, from_class, to_class, academic_year, action) VALUES (?, ?, ?, ?, ?)',
            [studentId, student[0].classId, student[0].classId, academicYear, 'repeated']
        );
        
        res.json({ success: true, message: 'Student marked to repeat' });
        
    } catch (error) {
        console.error('Error marking student to repeat:', error);
        res.status(500).json({ success: false, error: 'Failed to mark student to repeat' });
    }
});

// GET classes by level
router.get('/api/classes-by-level/:level', authenticate, async (req, res) => {
    const { level } = req.params;
    
    try {
        const connection = await getConnection();
        
        const [classes] = await connection.execute(
            'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
            [level]
        );
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error fetching classes by level:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

// GET all classes
router.get('/api/all-classes', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END,
                className
        `);
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error fetching all classes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

// GET next class options for promotion
router.get('/api/next-class-options/:studentId', authenticate, async (req, res) => {
    const { studentId } = req.params;
    
    try {
        const connection = await getConnection();
        
        // Get student's current class and level
        const [students] = await connection.execute(`
            SELECT s.id, s.classId, c.level, c.className 
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (students.length === 0) {
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        const student = students[0];
        let nextLevel = '';
        
        // Determine next level based on current level
        switch (student.level) {
            case 'KG': nextLevel = 'NURSERY'; break;
            case 'NURSERY': nextLevel = 'PRIMARY'; break;
            case 'PRIMARY': nextLevel = 'JUNIOR SECONDARY'; break;
            case 'JUNIOR SECONDARY': nextLevel = 'SENIOR SECONDARY'; break;
            case 'SENIOR SECONDARY': 
                return res.json({ success: true, classes: [] }); // Graduated
            default: nextLevel = student.level;
        }
        
        // Get classes for the next level
        const [classes] = await connection.execute(
            'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
            [nextLevel]
        );
        
        res.json({ success: true, classes: classes });
        
    } catch (error) {
        console.error('Error getting next class options:', error);
        res.status(500).json({ success: false, error: 'Failed to get next class options' });
    }
});

// Get next class options for promotion
router.get('/next-class-options/:currentClassId', authenticate, requireRole('admin'), async (req, res) => {
    const { currentClassId } = req.params;
    
    try {
        const connection = await getConnection();
        
        // Get current class info
        const [currentClass] = await connection.execute(
            'SELECT level, className FROM classes WHERE id = ?',
            [currentClassId]
        );
        
        if (currentClass.length === 0) {
            return res.status(404).json({ success: false, error: 'Class not found' });
        }
        
        // Determine next class based on current level
        let nextLevel = '';
        const currentLevel = currentClass[0].level;
        
        switch (currentLevel) {
            case 'KG':
                nextLevel = 'NURSERY';
                break;
            case 'NURSERY':
                nextLevel = 'PRIMARY';
                break;
            case 'PRIMARY':
                // For primary, go to next class (Primary 1 -> Primary 2, etc.)
                const currentClassName = currentClass[0].className;
                const classNumber = parseInt(currentClassName.match(/\d+/));
                if (classNumber && classNumber < 6) {
                    nextLevel = 'PRIMARY';
                } else {
                    nextLevel = 'JUNIOR SECONDARY';
                }
                break;
            case 'JUNIOR SECONDARY':
                nextLevel = 'SENIOR SECONDARY';
                break;
            case 'SENIOR SECONDARY':
                // Graduation - no next class
                nextLevel = 'GRADUATED';
                break;
            default:
                nextLevel = currentLevel;
        }
        
        // Get available classes for next level
        if (nextLevel === 'GRADUATED') {
            res.json({ success: true, options: [], message: 'Student has graduated' });
        } else {
            const [nextClasses] = await connection.execute(
                'SELECT id, className, department FROM classes WHERE level = ? ORDER BY className',
                [nextLevel]
            );
            
            res.json({ success: true, options: nextClasses });
        }
        
    } catch (error) {
        console.error('Error getting next class options:', error);
        res.status(500).json({ success: false, error: 'Failed to get next class options' });
    }
});

// Session Records Route - Updated
router.get('/session-records', authenticate, requireRole('admin'), async (req, res) => {
    const { classId, academicYear, studentId } = req.query;
    
    try {
        const connection = await getConnection();
        
        // Get available academic years
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years ORDER BY start_date DESC
        `);
        
        if (!classId || !academicYear) {
            // Show class selection - include level and department in the query
            const [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `);
            
            // Create formData object from query parameters
            const formData = {
                classId: classId || '',
                academicYear: academicYear || ''
            };
            
            res.render('session-records-selection', { 
                classes, 
                academicYears,
                formData, // Pass formData to the template
                error: req.query.error || null
            });
        } else {
            // Generate session records
            const [classResults] = await connection.execute('SELECT className, level, department FROM classes WHERE id = ?', [classId]);
            
            if (classResults.length === 0) {
                return res.status(404).send('Class not found');
            }
            
            const className = classResults[0].className;
            const classLevel = classResults[0].level;
            const classDepartment = classResults[0].department;
            
            // Get session records
            const [results] = await connection.execute(`
                SELECT 
                    s.id as student_id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.department as student_department,
                    sub.id as subject_id,
                    sub.name as subject_name,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'First Term' AND academic_year = ?
                    ), 0) as first_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Second Term' AND academic_year = ?
                    ), 0) as second_term_score,
                    COALESCE((
                        SELECT (test_score + exam_score) 
                        FROM student_scores 
                        WHERE student_id = s.id AND subject_id = sub.id AND term = 'Third Term' AND academic_year = ?
                    ), 0) as third_term_score
                FROM students s
                CROSS JOIN subjects sub
                WHERE s.classId = ?
                ORDER BY s.lastName, s.firstName, sub.name
            `, [academicYear, academicYear, academicYear, classId]);
            
            // Organize by student
            const students = {};
            results.forEach(row => {
                if (!students[row.student_id]) {
                    students[row.student_id] = {
                        id: row.student_id,
                        firstName: row.firstName,
                        middleName: row.middleName,
                        lastName: row.lastName,
                        department: row.student_department,
                        subjects: []
                    };
                }
                
                // Ensure scores are numbers
                const firstTerm = parseFloat(row.first_term_score) || 0;
                const secondTerm = parseFloat(row.second_term_score) || 0;
                const thirdTerm = parseFloat(row.third_term_score) || 0;
                
                const average = (firstTerm + secondTerm + thirdTerm) / 3;
                
                students[row.student_id].subjects.push({
                    subject_id: row.subject_id,
                    subject_name: row.subject_name,
                    first_term: firstTerm,
                    second_term: secondTerm,
                    third_term: thirdTerm,
                    average: average.toFixed(2)
                });
            });
            
            // Calculate overall averages
            Object.keys(students).forEach(studentId => {
                const student = students[studentId];
                let totalAverage = 0;
                
                student.subjects.forEach(subject => {
                    totalAverage += parseFloat(subject.average) || 0;
                });
                
                student.overallAverage = student.subjects.length > 0 
                    ? (totalAverage / student.subjects.length).toFixed(2) 
                    : '0.00';
                
                student.percentage = student.subjects.length > 0
                    ? ((totalAverage / (student.subjects.length * 100)) * 100).toFixed(2)
                    : '0.00';
            });

            // Collapse to full name for views that print firstName + lastName only
            Object.values(students).forEach((st) => {
                const full = studentDisplayName(st);
                st.firstName = full;
                st.lastName = '';
                st.middleName = null;
            });
            
            // Get student list for dropdown
            const studentList = Object.keys(students).map(id => {
                return {
                    id: id,
                    firstName: students[id].firstName,
                    lastName: students[id].lastName,
                    department: students[id].department
                };
            });
            
            res.render('session-records', {
                className,
                classLevel,
                classDepartment,
                classId,
                academicYear,
                students,
                studentList, // Pass student list for dropdown
                selectedStudentId: studentId || null, // Pass selected student ID
                success: req.query.success || null,
                error: req.query.error || null
            });
        }
    } catch (error) {
        console.error('Error loading session records:', error);
        
        // Even in error case, provide empty formData
        res.render('session-records-selection', {
            classes: [],
            academicYears: [],
            formData: {
                classId: '',
                academicYear: ''
            },
            error: 'Failed to load session records data'
        });
    }
});

// GET route to display class bills list and print functionality

// GET route to display class bills list and print functionality
router.get('/class-bills', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';
        const selectedClassId = req.query.classId || null;
        const selectedAcademicYear = req.query.academicYear || null;
        const selectedTerm = req.query.term || null;
        const { page = 1, limit = 20 } = req.query;

        // Check if this is a print request
        const isPrintView = req.query.print === 'true';

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

        // Build WHERE clause
        let whereClause = 'WHERE 1=1';
        let queryParams = [];

        if (selectedClassId) {
            whereClause += ' AND cb.class_id = ?';
            queryParams.push(selectedClassId);
        }

        if (selectedAcademicYear) {
            whereClause += ' AND cb.academic_year = ?';
            queryParams.push(selectedAcademicYear);
        }

        if (selectedTerm) {
            whereClause += ' AND cb.term = ?';
            queryParams.push(selectedTerm);
        }

        // Get total count for pagination (only for list view)
        let totalCount = 0;
        let totalPages = 1;
        let offset = 0;

        if (!isPrintView) {
            const [totalCountResult] = await connection.execute(
                `SELECT COUNT(*) as total FROM class_bills cb ${whereClause}`,
                queryParams
            );

            totalCount = totalCountResult[0].total;
            totalPages = Math.ceil(totalCount / limit);
            offset = (page - 1) * limit;
        }

        // Get all classes for filter dropdown
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY className
        `, [schoolId]);

        // Get academic years for filter dropdown
        let academicYears = [];

        try {
            const [yearsFromBills] = await connection.execute(`
                SELECT DISTINCT academic_year as year_name 
                FROM class_bills 
                WHERE academic_year IS NOT NULL AND academic_year != ''
                ORDER BY academic_year DESC
            `);

            if (yearsFromBills.length > 0) {
                academicYears = yearsFromBills;
            } else {
                // Fallback to academic_years table
                const [yearsFromAcademic] = await connection.execute(`
                    SELECT year_name 
                    FROM academic_years 
                    WHERE school_id = ?
                    ORDER BY start_date DESC
                `, [schoolId]);
                academicYears = yearsFromAcademic;
            }
        } catch (error) {
            console.error('Error fetching academic years:', error);
            academicYears = [];
        }

        // Get bills for display
        let bills = [];
        let billsQuery = '';

        if (isPrintView) {
            // For print view, get all bills without pagination
            billsQuery = `
                SELECT 
                    cb.*, 
                    c.className as class_display_name,
                    c.level as class_level,
                    c.department as class_department
                FROM class_bills cb
                JOIN classes c ON cb.class_id = c.id
                ${whereClause}
                ORDER BY cb.fee_type
            `;
        } else {
            // For list view, get bills with pagination and additional info
            billsQuery = `
                SELECT 
                    cb.*, 
                    c.className as class_display_name,
                    c.level as class_level,
                    c.department as class_department,
                    COUNT(DISTINCT s.id) as student_count,
                    COALESCE(SUM(CASE WHEN f.status IN ('paid', 'partial') THEN f.amountPaid ELSE 0 END), 0) as amount_collected
                FROM class_bills cb
                JOIN classes c ON cb.class_id = c.id
                LEFT JOIN students s ON s.classId = cb.class_id AND s.school_id = c.school_id
                LEFT JOIN fees f ON f.studentId = s.id 
                    AND cb.fee_type = f.feeType 
                    AND cb.academic_year = f.academicYear 
                    AND cb.term = f.term
                ${whereClause}
                GROUP BY cb.id
                ORDER BY cb.academic_year DESC, cb.term, c.className
                LIMIT ? OFFSET ?
            `;
            queryParams = [...queryParams, parseInt(limit), parseInt(offset)];
        }

        // Execute the appropriate query
        [bills] = await connection.execute(billsQuery, queryParams);

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

        // Get terms for filter
        const terms = ['First Term', 'Second Term', 'Third Term'];

        // Render the template
        res.render('class-bills-list', {
            classes: classes,
            bills: bills,
            school: school,
            selectedClassId: selectedClassId,
            selectedAcademicYear: selectedAcademicYear,
            selectedTerm: selectedTerm,
            academicYears: academicYears,
            terms: terms,
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalCount: totalCount,
            limit: parseInt(limit),
            isPrintView: isPrintView,
            username: username,
            unreadCount: unreadCount,
            notificationTotal: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading class bills:', error);

        // Get fallback data
        let classes = [];
        let academicYears = [];

        try {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ?
                ORDER BY className
            `, [schoolId]);
        } catch (dbError) {
            console.error('Error fetching fallback classes:', dbError);
        }

        res.render('class-bills-list', {
            classes: classes,
            bills: [],
            selectedClassId: null,
            selectedAcademicYear: null,
            selectedTerm: null,
            academicYears: academicYears,
            terms: ['First Term', 'Second Term', 'Third Term'],
            currentPage: 1,
            totalPages: 1,
            totalCount: 0,
            limit: 20,
            isPrintView: false,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            notificationTotal: 0,
            notifications: [],
            error: 'Failed to load class bills: ' + error.message,
            moment: require('moment')
        });
    }
});

// GET route to display class bill form
router.get('/class-bills/create', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';
        const billId = req.query.id; // For editing existing bill

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

        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY className
        `, [schoolId]);

        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT year_name, start_date, end_date 
            FROM academic_years 
            WHERE school_id = ? 
            ORDER BY start_date DESC
        `, [schoolId]);

        // Get current academic year
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name 
            FROM academic_years 
            WHERE is_current = TRUE AND school_id = ? 
            LIMIT 1
        `, [schoolId]);

        // Get terms
        const [terms] = await connection.execute(`
            SELECT term_name, start_date, end_date 
            FROM academic_terms 
            WHERE school_id = ? 
            ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `, [schoolId]);

        let billData = {};
        let isEdit = false;

        // If editing, get existing bill data
        if (billId) {
            const [bills] = await connection.execute(`
                SELECT * FROM class_bills WHERE id = ? AND school_id = ?
            `, [billId, schoolId]);

            if (bills.length > 0) {
                billData = bills[0];
                isEdit = true;
            }
        }

        const feeTypes = ['Tuition', 'Examination', 'Library', 'Sports', 'Transportation', 'Development', 'ICT', 'Science Lab', 'Textbooks', 'Uniform', 'Other'];

        res.render('class-bills-form', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0] : null,
            billData: billData,
            isEdit: isEdit,
            feeTypes: feeTypes,
            username: username,
            unreadCount: unreadCount,
            totalCount: notificationTotal,
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading class bill form:', error);

        // Get fallback data for error rendering
        let classes = [];
        let academicYears = [];
        let terms = [];
        let feeTypes = ['Tuition', 'Examination', 'Library', 'Sports', 'Transportation', 'Development', 'ICT', 'Science Lab', 'Textbooks', 'Uniform', 'Other'];

        try {
            const connection = await getConnection();
            const schoolId = req.session.schoolId || null;
            [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ?
                ORDER BY className
            `, [schoolId]);
            [academicYears] = await connection.execute(`
                SELECT year_name, start_date, end_date 
                FROM academic_years 
                WHERE school_id = ?
                ORDER BY start_date DESC
            `, [schoolId]);
            [terms] = await connection.execute(`
                SELECT term_name, start_date, end_date 
                FROM academic_terms 
                WHERE school_id = ?
                ORDER BY start_date DESC
            `, [schoolId]);
            releaseConnection(connection);
        } catch (dbError) {
            console.error('Error fetching fallback data:', dbError);
        }

        res.render('class-bills-form', {
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            currentAcademicYear: null,
            billData: {},
            isEdit: false,
            feeTypes: feeTypes,
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load form: ' + error.message
        });
    }
});

// POST route to add/update class bill
router.post('/save-class-bill', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const { billId, classId, feeType, amount, academicYear, term, description, dueDate } = req.body;
    
    try {
        const connection = await getConnection();
        
        // Validate required fields
        if (!classId || !feeType || !amount || !academicYear || !term) {
            return res.status(400).json({
                success: false,
                error: 'Class, Fee Type, Amount, Academic Year, and Term are required fields'
            });
        }
        
        // Validate amount
        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid amount in Naira'
            });
        }
        
        // Get class details
        const [classDetails] = await connection.execute(`
            SELECT className, level, department FROM classes WHERE id = ?
        `, [classId]);
        
        if (classDetails.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Class not found'
            });
        }
        
        const classInfo = classDetails[0];
        const isEdit = !!billId;
        
        if (isEdit) {
            // Update existing bill
            await connection.execute(`
                UPDATE class_bills SET
                    class_id = ?, class_name = ?, level = ?, department = ?, 
                    fee_type = ?, amount = ?, academic_year = ?, term = ?, 
                    description = ?, due_date = ?
                WHERE id = ?
            `, [
                classId,
                classInfo.className,
                classInfo.level,
                classInfo.department,
                feeType,
                amountValue,
                academicYear,
                term,
                description || null,
                dueDate || null,
                billId
            ]);
            
            res.json({
                success: true,
                message: 'Class bill updated successfully'
            });
        } else {
            // Check if bill already exists
            const [existingBills] = await connection.execute(`
                SELECT id FROM class_bills 
                WHERE class_id = ? AND fee_type = ? AND academic_year = ? AND term = ?
            `, [classId, feeType, academicYear, term]);
            
            if (existingBills.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'A bill for this fee type already exists for the selected class, academic year, and term'
                });
            }
            
            // Insert new class bill
            await connection.execute(`
                INSERT INTO class_bills (
                    class_id, class_name, level, department, fee_type, amount, 
                    academic_year, term, description, due_date, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                classId,
                classInfo.className,
                classInfo.level,
                classInfo.department,
                feeType,
                amountValue,
                academicYear,
                term,
                description || null,
                dueDate || null,
                req.session.userId || 1
            ]);
            
            res.json({
                success: true,
                message: 'Class bill created successfully'
            });
        }
        
    } catch (error) {
        console.error('Error saving class bill:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save class bill: ' + error.message
        });
    }
});

// GET route to delete class bill
// GET route to delete class bill - FIXED
router.get('/delete-class-bill/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const billId = req.params.id;
        
        // First get the bill details to check against
        const [billDetails] = await connection.execute(
            'SELECT class_id, fee_type, academic_year, term FROM class_bills WHERE id = ?',
            [billId]
        );
        
        if (billDetails.length === 0) {
            req.session.error = 'Bill not found';
            return res.redirect('/class-bills');
        }
        
        const bill = billDetails[0];
        
        // Check if there are any fees linked to this bill by joining through students table
        const [linkedFees] = await connection.execute(`
            SELECT COUNT(*) as count 
            FROM fees f
            JOIN students s ON f.studentId = s.id
            WHERE s.classId = ?
            AND f.feeType = ?
            AND f.academicYear = ?
            AND f.term = ?
        `, [bill.class_id, bill.fee_type, bill.academic_year, bill.term]);
        
        if (linkedFees[0].count > 0) {
            req.session.error = 'Cannot delete bill. There are fees linked to this bill.';
            return res.redirect('/class-bills');
        }
        
        // If no linked fees, delete the bill
        await connection.execute(
            'DELETE FROM class_bills WHERE id = ?',
            [billId]
        );
        
        req.session.success = 'Class bill deleted successfully';
        res.redirect('/class-bills');
        
    } catch (error) {
        console.error('Error deleting class bill:', error);
        req.session.error = 'Failed to delete class bill';
        res.redirect('/class-bills');
    }
});

// GET route to display attendance marking page

// GET route to display attendance marking page
router.get('/mark-attendance', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const userRole = req.session.role;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');  // ADD THIS LINE

        const { academicYear, term, week, day, session, classId } = req.query;

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

        // Get teacher information (if teacher role)
        let teacherData = null;
        let myClassesCount = 0;
        let totalStudents = 0;

        if (userRole === 'teacher') {
            try {
                // Check if teacher_notifications table exists
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [unreadResult] = await connection.execute(`
                        SELECT COUNT(*) as count 
                        FROM teacher_notifications 
                        WHERE teacher_id = ? AND is_read = 0
                    `, [teacherId]);
                    unreadCount = unreadResult[0]?.count || 0;

                    // Get total count for notification dropdown
                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total 
                        FROM teacher_notifications 
                        WHERE teacher_id = ?
                    `, [teacherId]);
                    totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                    const [notificationList] = await connection.execute(`
                        SELECT * FROM teacher_notifications 
                        WHERE teacher_id = ? 
                        ORDER BY created_at DESC 
                        LIMIT 5
                    `, [teacherId]);
                    notifications = notificationList;
                }
            } catch (err) {
                console.error('Error fetching notifications:', err.message);
                unreadCount = 0;
                totalCount = 0;
                notifications = [];
            }

            const [teachers] = await connection.execute(`
                SELECT id, firstName, lastName, email, designation, department 
                FROM teachers 
                WHERE id = ? AND school_id = ?
            `, [teacherId, schoolId]);

            if (teachers.length > 0) {
                const teacher = teachers[0];
                teacherData = {
                    id: teacher.id,
                    firstName: teacher.firstName,
                    lastName: teacher.lastName,
                    email: teacher.email,
                    designation: teacher.designation,
                    department: teacher.department
                };
            }
        } else {
            // For admin users, get admin notifications
            const adminId = req.session.userId;
            try {
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
                `);

                if (tableCheck[0].count > 0) {
                    const [unreadResult] = await connection.execute(`
                        SELECT COUNT(*) as count FROM admin_notifications 
                        WHERE admin_id = ? AND is_read = 0
                    `, [adminId]);
                    unreadCount = unreadResult[0]?.count || 0;

                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total FROM admin_notifications 
                        WHERE admin_id = ?
                    `, [adminId]);
                    totalCount = totalResult[0]?.total || 0;

                    const [notificationList] = await connection.execute(`
                        SELECT id, message, is_read, 
                               DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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
                totalCount = 0;
                notifications = [];
            }
        }

        // Get current academic year and term if not specified
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        // Get classes - filter by teacher if teacher role
        let classes = [];
        if (userRole === 'teacher') {
            // Get ONLY classes assigned to this teacher
            [classes] = await connection.execute(`
                SELECT c.id, c.className, c.level, c.department 
                FROM classes c
                WHERE c.professorId = ? AND c.school_id = ?
                ORDER BY 
                    CASE c.level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    c.className
            `, [teacherId, schoolId]);

            myClassesCount = classes.length;

            // Calculate total students across all teacher's classes
            for (const cls of classes) {
                const [studentCount] = await connection.execute(`
                    SELECT COUNT(*) as count FROM students WHERE classId = ? AND school_id = ?
                `, [cls.id, schoolId]);
                totalStudents += studentCount[0]?.count || 0;
            }
        } else {
            // Admin sees all classes
            [classes] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ?
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `, [schoolId]);
        }

        // Get academic years and terms for dropdowns
        const [academicYears] = await connection.execute(`
            SELECT year_name, start_date, end_date 
            FROM academic_years 
            WHERE school_id = ? 
            ORDER BY start_date DESC
        `, [schoolId]);

        const [terms] = await connection.execute(`
            SELECT term_name, start_date, end_date 
            FROM academic_terms 
            WHERE school_id = ? 
            ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `, [schoolId]);

        let students = [];
        let selectedDate = null;
        let weekDays = [];
        let weeksInTerm = [];
        let selectedClassId = classId || '';

        // If academic year and term are selected, calculate weeks and days
        if (academicYear && term) {
            // Get term details
            const [termDetails] = await connection.execute(`
                SELECT at.start_date, at.end_date
                FROM academic_terms at
                JOIN academic_years ay ON at.academic_year_id = ay.id
                WHERE ay.year_name = ? AND at.term_name = ? AND ay.school_id = ?
            `, [academicYear, term, schoolId]);

            if (termDetails.length > 0) {
                const termStart = moment(termDetails[0].start_date);
                const termEnd = moment(termDetails[0].end_date);

                // Calculate all weeks in the term
                let currentWeek = termStart.clone();
                let weekNumber = 1;

                while (currentWeek.isSameOrBefore(termEnd)) {
                    weeksInTerm.push(weekNumber);
                    currentWeek.add(1, 'week');
                    weekNumber++;
                }

                // Calculate days for selected week
                if (week) {
                    const weekStart = termStart.clone().add((parseInt(week) - 1), 'weeks');
                    const weekEnd = weekStart.clone().add(6, 'days');

                    // Get all school days (Monday-Friday) for the week
                    let currentDay = weekStart.clone();
                    while (currentDay.isSameOrBefore(weekEnd)) {
                        if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                            weekDays.push({
                                date: currentDay.format('YYYY-MM-DD'),
                                dayName: currentDay.format('dddd'),
                                formatted: currentDay.format('ddd, MMM D, YYYY'),
                                dayNumber: weekDays.length + 1
                            });
                        }
                        currentDay.add(1, 'day');
                    }

                    // Set selected date based on day parameter
                    if (day && weekDays[parseInt(day) - 1]) {
                        selectedDate = weekDays[parseInt(day) - 1].date;
                    } else if (weekDays.length > 0) {
                        selectedDate = weekDays[0].date;
                    }
                }
            }

            // Get students for the selected class if class is selected
            if (selectedClassId) {
                // Verify teacher has access to this class (if teacher)
                if (userRole === 'teacher') {
                    const [classAccess] = await connection.execute(`
                        SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
                    `, [selectedClassId, teacherId, schoolId]);

                    if (classAccess.length === 0) {
                        return res.render('mark-attendance', {
                            teacherData: teacherData,
                            myClassesCount: myClassesCount,
                            totalStudents: totalStudents,
                            classes: classes,
                            academicYears: academicYears,
                            terms: terms,
                            weeks: weeksInTerm,
                            weekDays: weekDays,
                            students: [],
                            selectedAcademicYear: academicYear,
                            selectedTerm: term,
                            selectedWeek: week || '',
                            selectedDay: day || '',
                            selectedSession: session || 'morning',
                            selectedClassId: selectedClassId,
                            selectedDate: null,
                            unreadCount: unreadCount,
                            totalCount: totalCount,  // ADD THIS LINE
                            notifications: notifications,
                            username: username,  // ADD THIS LINE
                            moment: require('moment'),
                            error: 'You do not have permission to access this class'
                        });
                    }
                }

                [students] = await connection.execute(`
                    SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number
                    FROM students s 
                    WHERE s.classId = ? AND s.school_id = ?
                    ORDER BY s.lastName, s.firstName
                `, [selectedClassId, schoolId]);

                // Get existing attendance records for the selected date
                if (selectedDate) {
                    const [attendance] = await connection.execute(`
                        SELECT student_id, morning_status, afternoon_status, notes
                        FROM attendance_records 
                        WHERE class_id = ? AND date = ? AND academic_year = ? AND term = ? AND school_id = ?
                    `, [selectedClassId, selectedDate, academicYear, term, schoolId]);

                    // Create a map of student attendance for easy lookup
                    const attendanceMap = {};
                    for (const record of attendance) {
                        attendanceMap[record.student_id] = record;
                    }

                    // Prepare attendance data with all students
                    students = students.map(student => {
                        const attendanceRecord = attendanceMap[student.id];
                        return {
                            studentId: student.id,
                            firstName: student.firstName,
                            middleName: student.middleName,
                            lastName: student.lastName,
                            admissionNumber: student.admission_number,
                            morningStatus: attendanceRecord ? attendanceRecord.morning_status : null,
                            afternoonStatus: attendanceRecord ? attendanceRecord.afternoon_status : null,
                            notes: attendanceRecord ? attendanceRecord.notes : ''
                        };
                    });
                } else {
                    // Format students without attendance records
                    students = students.map(student => ({
                        studentId: student.id,
                        firstName: student.firstName,
                        middleName: student.middleName,
                        lastName: student.lastName,
                        admissionNumber: student.admission_number,
                        morningStatus: null,
                        afternoonStatus: null,
                        notes: ''
                    }));
                }
            }
        }

        res.render('mark-attendance', {
            teacherData: teacherData,
            myClassesCount: myClassesCount,
            totalStudents: totalStudents,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            classes: classes,
            academicYears: academicYears,
            terms: terms,
            weeks: weeksInTerm,
            weekDays: weekDays,
            students: students,
            selectedAcademicYear: academicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : ''),
            selectedTerm: term || (currentTerm.length > 0 ? currentTerm[0].term_name : ''),
            selectedWeek: week || '',
            selectedDay: day || '',
            selectedSession: session || 'morning',
            selectedClassId: selectedClassId,
            selectedDate: selectedDate,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading attendance marking page:', error);
        res.render('mark-attendance', {
            teacherData: null,
            myClassesCount: 0,
            totalStudents: 0,
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            classes: [],
            academicYears: [],
            terms: [],
            weeks: [],
            weekDays: [],
            students: [],
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedWeek: '',
            selectedDay: '',
            selectedSession: 'morning',
            selectedClassId: '',
            selectedDate: null,
            username: req.session.username || (req.session.role === 'teacher' ? 'Teacher' : 'Admin'),  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load attendance data: ' + error.message
        });
    }
});
// POST route to record attendance (Consolidated)
router.post('/record-attendance', authenticate, uploadNoFile.none(), async (req, res) => {
    let connection = null;
    try {
        connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const userRole = req.session.role;
        const { classId, date, academicYear, term, session, attendance } = req.body;
        
        // Validate required fields
        if (!classId || !date || !academicYear || !term || !session) {
            return res.status(400).json({
                success: false,
                error: 'Class, date, academic year, term, and session are required'
            });
        }
        
        // Validate session
        if (session !== 'morning' && session !== 'afternoon') {
            return res.status(400).json({
                success: false,
                error: 'Session must be either "morning" or "afternoon"'
            });
        }
        
        // Validate attendance data
        if (!attendance || typeof attendance !== 'object' || Object.keys(attendance).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Attendance data is required'
            });
        }
        
        // Validate date format
        const parsedDate = moment(date, 'YYYY-MM-DD', true);
        if (!parsedDate.isValid()) {
            return res.status(400).json({
                success: false,
                error: 'Invalid date format. Please use YYYY-MM-DD'
            });
        }
        
        // Verify teacher has access to this class (if teacher role)
        if (userRole === 'teacher') {
            const [classAccess] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [classId, teacherId, schoolId]);
            
            if (classAccess.length === 0) {
                return res.status(403).json({
                    success: false,
                    error: 'You do not have permission to mark attendance for this class'
                });
            }
        }
        
        // Verify the class exists
        const [classExists] = await connection.execute(`
            SELECT id, className FROM classes WHERE id = ? AND school_id = ?
        `, [classId, schoolId]);
        
        if (classExists.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Class not found'
            });
        }
        
        // Get user info from session
        const recordedByUserId = req.session.userId || null;
        const recordedByName = req.session.username || 'System Administrator';
        
        // Start transaction
        await connection.beginTransaction();
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        try {
            // Process each student's attendance
            const studentIds = Object.keys(attendance);
            
            // Verify all students belong to the class
            if (studentIds.length > 0) {
                const placeholders = studentIds.map(() => '?').join(',');
                const [validStudents] = await connection.execute(`
                    SELECT id FROM students WHERE id IN (${placeholders}) AND classId = ? AND school_id = ?
                `, [...studentIds, classId, schoolId]);
                
                const validStudentIds = validStudents.map(s => s.id);
                const invalidStudents = studentIds.filter(id => !validStudentIds.includes(parseInt(id)));
                
                if (invalidStudents.length > 0) {
                    // Log warning but continue with valid students
                    console.warn(`Warning: ${invalidStudents.length} student(s) not found in class ${classId}`);
                }
            }
            
            for (const studentId of studentIds) {
                const { status, notes } = attendance[studentId];
                
                // Skip if no status provided
                if (!status) {
                    errorCount++;
                    errors.push(`No status provided for student ID ${studentId}`);
                    continue;
                }
                
                // Validate status value
                const validStatuses = ['present', 'absent', 'late', 'excused'];
                if (!validStatuses.includes(status)) {
                    errorCount++;
                    errors.push(`Invalid status "${status}" for student ID ${studentId}`);
                    continue;
                }
                
                try {
                    // Check if attendance record already exists
                    const [existingRecords] = await connection.execute(`
                        SELECT id FROM attendance_records 
                        WHERE student_id = ? AND date = ? AND academic_year = ? AND term = ? AND class_id = ? AND school_id = ?
                    `, [studentId, parsedDate.format('YYYY-MM-DD'), academicYear, term, classId, schoolId]);
                    
                    // Prepare notes (sanitize)
                    const sanitizedNotes = notes ? notes.trim().substring(0, 500) : null;
                    
                    if (existingRecords.length > 0) {
                        // Update existing record - using parameterized column name (safe because session is validated)
                        const updateQuery = `
                            UPDATE attendance_records 
                            SET ${session}_status = ?, 
                                notes = COALESCE(?, notes), 
                                recorded_by_user_id = ?, 
                                recorded_by_name = ?, 
                                updated_at = NOW()
                            WHERE student_id = ? 
                                AND date = ? 
                                AND academic_year = ? 
                                AND term = ? 
                                AND class_id = ? 
                                AND school_id = ?
                        `;
                        
                        await connection.execute(updateQuery, [
                            status, 
                            sanitizedNotes, 
                            recordedByUserId, 
                            recordedByName, 
                            studentId, 
                            parsedDate.format('YYYY-MM-DD'), 
                            academicYear, 
                            term, 
                            classId, 
                            schoolId
                        ]);
                    } else {
                        // Insert new record - using parameterized column name (safe because session is validated)
                        const insertQuery = `
                            INSERT INTO attendance_records 
                            (student_id, class_id, date, academic_year, term, ${session}_status, 
                             recorded_by_user_id, recorded_by_name, notes, school_id, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                        `;
                        
                        await connection.execute(insertQuery, [
                            studentId, 
                            classId, 
                            parsedDate.format('YYYY-MM-DD'), 
                            academicYear, 
                            term, 
                            status,
                            recordedByUserId, 
                            recordedByName, 
                            sanitizedNotes, 
                            schoolId
                        ]);
                    }
                    
                    successCount++;
                    
                } catch (studentError) {
                    errorCount++;
                    errors.push(`Error for student ${studentId}: ${studentError.message}`);
                    console.error(`Error processing attendance for student ${studentId}:`, studentError);
                }
            }
            
            // Commit transaction if at least one record was successfully processed
            if (successCount > 0) {
                await connection.commit();
                
                // Create notification for admin if attendance is marked by teacher
                if (userRole === 'teacher') {
                    try {
                        // Notify admin about attendance marking
                        const [adminUsers] = await connection.execute(`
                            SELECT id FROM users WHERE role = 'admin' AND school_id = ?
                        `, [schoolId]);
                        
                        for (const admin of adminUsers) {
                            await connection.execute(`
                                INSERT INTO admin_notifications 
                                (admin_id, title, message, type, reference_id, created_at)
                                VALUES (?, ?, ?, 'attendance', ?, NOW())
                            `, [
                                admin.id,
                                'Attendance Marked',
                                `Teacher ${recordedByName} marked attendance for ${classExists[0].className} (${session} session) - ${successCount} students`,
                                classId
                            ]);
                        }
                    } catch (notifError) {
                        // Don't fail the request if notification fails
                        console.error('Error creating admin notification:', notifError.message);
                    }
                }
                
                const responseMessage = `${session.charAt(0).toUpperCase() + session.slice(1)} attendance recorded successfully for ${successCount} student(s)`;
                
                // If there were errors but also successes, include warning
                if (errorCount > 0) {
                    return res.status(207).json({
                        success: true,
                        partial: true,
                        message: responseMessage + ` (${errorCount} errors occurred)`,
                        successCount,
                        errorCount,
                        errors: errors.slice(0, 10) // Limit errors to avoid huge response
                    });
                }
                
                return res.json({
                    success: true,
                    message: responseMessage,
                    successCount,
                    totalProcessed: successCount + errorCount
                });
                
            } else {
                // No successful records - rollback and return error
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    error: 'No attendance records were saved',
                    details: errors
                });
            }
            
        } catch (error) {
            await connection.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('Error recording attendance:', error);
        
        // Close connection on error
        if (connection) {
            try {
                releaseConnection(connection);
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }
        
        res.status(500).json({
            success: false,
            error: 'Failed to record attendance: ' + error.message
        });
    }
});

// GET route to view attendance reports
router.get('/attendance-reports', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';  // ADD THIS LINE
        const { classId, month, studentId, academicYear, term, viewType, weekStart, weekEnd } = req.query;

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
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
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

        // Get current academic year and term if not specified
        let targetAcademicYear = academicYear;
        let targetTerm = term;

        if (!targetAcademicYear || !targetTerm) {
            const [currentAcademicYear] = await connection.execute(`
                SELECT * FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
            `, [schoolId]);

            const [currentTerm] = await connection.execute(`
                SELECT * FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
            `, [schoolId]);

            if (currentAcademicYear.length > 0) targetAcademicYear = currentAcademicYear[0].year_name;
            if (currentTerm.length > 0) targetTerm = currentTerm[0].term_name;
        }

        // Get all classes
        const [classes] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes 
            WHERE school_id = ?
            ORDER BY className
        `, [schoolId]);

        let reportData = [];
        let students = [];
        let selectedMonth = month || moment().format('YYYY-MM');
        let selectedViewType = viewType || 'summary';
        let selectedWeekStart = weekStart;
        let selectedWeekEnd = weekEnd;

        // Calculate attendance percentages
        let weeklyPercentage = null;
        let termlyPercentage = null;
        let yearlyPercentage = null;

        if (classId && targetAcademicYear && targetTerm) {
            // Get students for the selected class
            [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number
                FROM students s 
                WHERE s.classId = ? AND s.school_id = ?
                ORDER BY s.firstName, s.lastName
            `, [classId, schoolId]);

            // Get term dates for the selected term
            const [termDates] = await connection.execute(`
                SELECT start_date, end_date 
                FROM academic_terms 
                WHERE term_name = ? AND academic_year_id = (
                    SELECT id FROM academic_years WHERE year_name = ? AND school_id = ?
                )
            `, [targetTerm, targetAcademicYear, schoolId]);

            if (termDates.length > 0 && termDates[0].start_date && termDates[0].end_date) {
                const termStart = moment(termDates[0].start_date);
                const termEnd = moment(termDates[0].end_date);

                // Calculate weekly percentage
                let weekStartDate, weekEndDate;

                if (weekStart && weekEnd) {
                    // Use provided week dates
                    weekStartDate = moment(weekStart);
                    weekEndDate = moment(weekEnd);
                    selectedWeekStart = weekStart;
                    selectedWeekEnd = weekEnd;

                    // Ensure proper date order
                    if (weekStartDate.isAfter(weekEndDate)) {
                        // Swap dates if they're in wrong order
                        [weekStartDate, weekEndDate] = [weekEndDate, weekStartDate];
                        [selectedWeekStart, selectedWeekEnd] = [selectedWeekEnd, selectedWeekStart];
                    }
                } else {
                    // Calculate current week (or use the selected month if provided)
                    if (month) {
                        // Use the month to get the first complete week
                        const monthStart = moment(month + '-01');
                        weekStartDate = monthStart.startOf('week');
                        weekEndDate = weekStartDate.clone().add(6, 'days');
                    } else {
                        // Use current week
                        weekStartDate = moment().startOf('week');
                        weekEndDate = moment().endOf('week');
                    }

                    // Ensure week is within term dates
                    if (weekStartDate.isBefore(termStart)) weekStartDate = termStart.clone();
                    if (weekEndDate.isAfter(termEnd)) weekEndDate = termEnd.clone();

                    selectedWeekStart = weekStartDate.format('YYYY-MM-DD');
                    selectedWeekEnd = weekEndDate.format('YYYY-MM-DD');
                }
                // Calculate weekly attendance percentage
                const [weeklyAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND date BETWEEN ? AND ?
                    AND academic_year = ? 
                    AND term = ?
                    AND school_id = ?
                `, [classId, selectedWeekStart, selectedWeekEnd, targetAcademicYear, targetTerm, schoolId]);

                if (weeklyAttendance.length > 0 && weeklyAttendance[0].total_sessions > 0) {
                    weeklyPercentage = {
                        weekStart: selectedWeekStart,
                        weekEnd: selectedWeekEnd,
                        presentCount: weeklyAttendance[0].present_count,
                        totalSessions: weeklyAttendance[0].total_sessions,
                        percentage: ((weeklyAttendance[0].present_count / weeklyAttendance[0].total_sessions) * 100).toFixed(2)
                    };
                } else {
                    weeklyPercentage = null;
                }

                // Calculate termly attendance percentage
                // Calculate school days in term (Monday-Friday)
                let schoolDays = 0;
                let currentDay = termStart.clone();

                while (currentDay.isSameOrBefore(termEnd)) {
                    // Count only weekdays (Monday-Friday)
                    if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                        schoolDays++;
                    }
                    currentDay.add(1, 'day');
                }

                // Calculate maximum possible attendance (school days × number of students)
                const maxTermAttendance = students.length * schoolDays;

                // Get actual attendance for the term
                const [termAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND date BETWEEN ? AND ?
                    AND academic_year = ? 
                    AND term = ?
                    AND school_id = ?
                `, [classId, termStart.format('YYYY-MM-DD'), termEnd.format('YYYY-MM-DD'), targetAcademicYear, targetTerm, schoolId]);

                if (termAttendance.length > 0 && maxTermAttendance > 0) {
                    termlyPercentage = {
                        termStart: termStart.format('YYYY-MM-DD'),
                        termEnd: termEnd.format('YYYY-MM-DD'),
                        presentCount: termAttendance[0].present_count,
                        totalSessions: termAttendance[0].total_sessions,
                        schoolDays: schoolDays,
                        maxPossibleAttendance: maxTermAttendance,
                        percentage: ((termAttendance[0].present_count / maxTermAttendance) * 100).toFixed(2),
                        studentCount: students.length
                    };
                }
            }

            // Calculate academic year attendance percentage
            // Get all terms in the academic year
            const [academicYearTerms] = await connection.execute(`
                SELECT term_name, start_date, end_date 
                FROM academic_terms 
                WHERE academic_year_id = (
                    SELECT id FROM academic_years WHERE year_name = ? AND school_id = ?
                )
                ORDER BY 
                    CASE term_name
                        WHEN 'First Term' THEN 1
                        WHEN 'Second Term' THEN 2
                        WHEN 'Third Term' THEN 3
                    END
            `, [targetAcademicYear, schoolId]);

            if (academicYearTerms.length > 0) {
                // Calculate school days across all terms
                let totalSchoolDays = 0;
                let yearlyStartDate = null;
                let yearlyEndDate = null;

                for (const term of academicYearTerms) {
                    if (term.start_date && term.end_date) {
                        const termStart = moment(term.start_date);
                        const termEnd = moment(term.end_date);

                        // Set yearly date range
                        if (!yearlyStartDate || termStart.isBefore(yearlyStartDate)) {
                            yearlyStartDate = termStart.clone();
                        }
                        if (!yearlyEndDate || termEnd.isAfter(yearlyEndDate)) {
                            yearlyEndDate = termEnd.clone();
                        }

                        // Count school days in this term (Monday-Friday)
                        let currentDay = termStart.clone();
                        while (currentDay.isSameOrBefore(termEnd)) {
                            if (currentDay.isoWeekday() >= 1 && currentDay.isoWeekday() <= 5) {
                                totalSchoolDays++;
                            }
                            currentDay.add(1, 'day');
                        }
                    }
                }

                // Calculate maximum possible attendance for the year
                const maxYearlyAttendance = students.length * totalSchoolDays;

                // Get actual attendance for the entire academic year
                const [yearlyAttendance] = await connection.execute(`
                    SELECT 
                        COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                        COUNT(*) as total_sessions
                    FROM attendance_records 
                    WHERE class_id = ? 
                    AND academic_year = ?
                    AND school_id = ?
                `, [classId, targetAcademicYear, schoolId]);

                if (yearlyAttendance.length > 0 && maxYearlyAttendance > 0) {
                    yearlyPercentage = {
                        academicYear: targetAcademicYear,
                        startDate: yearlyStartDate.format('YYYY-MM-DD'),
                        endDate: yearlyEndDate.format('YYYY-MM-DD'),
                        presentCount: yearlyAttendance[0].present_count,
                        totalSessions: yearlyAttendance[0].total_sessions,
                        schoolDays: totalSchoolDays,
                        maxPossibleAttendance: maxYearlyAttendance,
                        percentage: ((yearlyAttendance[0].present_count / maxYearlyAttendance) * 100).toFixed(2),
                        studentCount: students.length,
                        termCount: academicYearTerms.length
                    };
                }
            }

            if (studentId || selectedViewType === 'detailed') {
                // Get detailed attendance records
                let query = `
                    SELECT a.*, c.className, 
                           ${SQL_STUDENT_FULLNAME} as student_name,
                           s.admission_number
                    FROM attendance_records a
                    JOIN classes c ON a.class_id = c.id
                    JOIN students s ON a.student_id = s.id
                    WHERE a.class_id = ? AND a.academic_year = ? AND a.term = ? AND a.school_id = ?
                `;

                let params = [classId, targetAcademicYear, targetTerm, schoolId];

                if (studentId) {
                    query += ' AND a.student_id = ?';
                    params.push(studentId);
                }

                if (month) {
                    query += ' AND DATE_FORMAT(a.date, "%Y-%m") = ?';
                    params.push(selectedMonth);
                }

                query += ' ORDER BY a.date DESC, s.firstName, s.lastName';

                const [detailedAttendance] = await connection.execute(query, params);
                reportData = detailedAttendance;
            } else {
                // Get class summary for the selected period
                let summaryQuery = `
                    SELECT 
                        s.id as student_id,
                        ${SQL_STUDENT_FULLNAME} as student_name,
                        s.admission_number,
                        COUNT(CASE WHEN a.morning_status = 'present' THEN 1 END) as morning_present,
                        COUNT(CASE WHEN a.morning_status = 'absent' THEN 1 END) as morning_absent,
                        COUNT(CASE WHEN a.morning_status = 'late' THEN 1 END) as morning_late,
                        COUNT(CASE WHEN a.morning_status = 'excused' THEN 1 END) as morning_excused,
                        COUNT(CASE WHEN a.afternoon_status = 'present' THEN 1 END) as afternoon_present,
                        COUNT(CASE WHEN a.afternoon_status = 'absent' THEN 1 END) as afternoon_absent,
                        COUNT(CASE WHEN a.afternoon_status = 'late' THEN 1 END) as afternoon_late,
                        COUNT(CASE WHEN a.afternoon_status = 'excused' THEN 1 END) as afternoon_excused,
                        COUNT(*) as total_sessions,
                        ROUND((COUNT(CASE WHEN a.morning_status = 'present' OR a.afternoon_status = 'present' THEN 1 END) * 100.0 / COUNT(*)), 2) as attendance_percentage
                    FROM students s
                    LEFT JOIN attendance_records a ON s.id = a.student_id 
                        AND a.class_id = ? 
                        AND a.academic_year = ?
                        AND a.term = ?
                        AND a.school_id = ?
                `;

                let summaryParams = [classId, targetAcademicYear, targetTerm, schoolId];

                if (month) {
                    summaryQuery += ' AND DATE_FORMAT(a.date, "%Y-%m") = ?';
                    summaryParams.push(selectedMonth);
                }

                summaryQuery += ' WHERE s.classId = ? GROUP BY s.id ORDER BY s.firstName, s.lastName';
                summaryParams.push(classId);

                const [classSummary] = await connection.execute(summaryQuery, summaryParams);
                reportData = classSummary;
            }
        }

        // Get available academic years and terms
        const [academicYears] = await connection.execute(`
            SELECT * FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        const [terms] = await connection.execute(`
            SELECT * FROM academic_terms WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Calculate overall statistics
        let overallStats = {
            totalStudents: reportData.length,
            avgAttendance: 0,
            totalPresent: 0,
            totalSessions: 0
        };

        if (reportData.length > 0 && !studentId && selectedViewType !== 'detailed') {
            const totalPresent = reportData.reduce((sum, student) => {
                return sum + (student.morning_present || 0) + (student.afternoon_present || 0);
            }, 0);

            const totalSessions = reportData.reduce((sum, student) => {
                return sum + (student.total_sessions || 0);
            }, 0);

            overallStats.totalPresent = totalPresent;
            overallStats.totalSessions = totalSessions;
            overallStats.avgAttendance = totalSessions > 0 ? Math.round((totalPresent / totalSessions) * 100) : 0;
        }

        res.render('attendance-reports', {
            classes: classes,
            students: students,
            reportData: reportData,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: classId || '',
            selectedMonth: selectedMonth,
            selectedStudentId: studentId || '',
            selectedAcademicYear: targetAcademicYear || '',
            selectedTerm: targetTerm || '',
            selectedViewType: selectedViewType,
            selectedWeekStart: selectedWeekStart || '',
            selectedWeekEnd: selectedWeekEnd || '',
            weeklyPercentage: weeklyPercentage,
            termlyPercentage: termlyPercentage,
            yearlyPercentage: yearlyPercentage,
            overallStats: overallStats,
            username: username,              // ADD THIS LINE
            unreadCount: unreadCount,        // ADD THIS LINE
            totalCount: notificationTotal,   // ADD THIS LINE
            notifications: notifications,    // ADD THIS LINE
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading attendance reports:', error);
        res.render('attendance-reports', {
            classes: [],
            students: [],
            reportData: [],
            academicYears: [],
            terms: [],
            selectedClassId: '',
            selectedMonth: moment().format('YYYY-MM'),
            selectedStudentId: '',
            selectedAcademicYear: '',
            selectedTerm: '',
            selectedViewType: 'summary',
            selectedWeekStart: '',
            selectedWeekEnd: '',
            weeklyPercentage: null,
            termlyPercentage: null,
            yearlyPercentage: null,
            overallStats: {},
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: [],                          // ADD THIS LINE
            error: 'Failed to load attendance reports: ' + error.message
        });
    }
});


// report card - legacy route (redirects directly to report card)
router.get('/report-cards', authenticate, requireRole('admin'), (req, res) => {
    const { studentId, term, academicYear } = req.query;

    // If we have the required params, go straight to the report card
    if (studentId && term && academicYear) {
        return res.redirect(
            `/report-card?studentId=${encodeURIComponent(studentId)}&term=${encodeURIComponent(term)}&academicYear=${encodeURIComponent(academicYear)}`
        );
    }

    // Otherwise, show alert and go back
    return showAlertAndBack(res, 'Student, Term, and Academic Year are required to view a report card.');
});

// GET route to generate and display report card
router.get('/report-card', authenticate, requireRole('admin'), async (req, res) => {
    let { studentId, term, academicYear } = req.query;
    
    try {
        const connection = await getConnection();

        // Student ID is always required
        if (!studentId) {
            return showAlertAndBack(res, 'Student is required to view a report card.');
        }

        // If term or academic year is missing, fall back to current ones
        if (!term || !academicYear) {
            const [currentAcademicYear] = await connection.execute(`
                SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
            `);
            
            const [currentTerm] = await connection.execute(`
                SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
            `);

            academicYear = academicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : null);
            term = term || (currentTerm.length > 0 ? currentTerm[0].term_name : null);

            if (!term || !academicYear) {
                return showAlertAndBack(res, 'Current Term or Academic Year is not set. Please contact administration.');
            }
        }
        
        // Get student information
        const [studentResults] = await connection.execute(`
            SELECT s.*, c.className, c.level, c.department as classDepartment
            FROM students s 
            JOIN classes c ON s.classId = c.id 
            WHERE s.id = ?
        `, [studentId]);
        
        if (studentResults.length === 0) {
            return showAlertAndBack(res, 'Student not found.');
        }
        
        const student = studentResults[0];
        
        // Get school information
        const resolvedSchoolId = student.school_id || req.session.schoolId || null;
        const [schoolInfo] = resolvedSchoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [resolvedSchoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        
        const school = schoolInfo.length > 0 ? schoolInfo[0] : {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789",
            logo: "/images/school-logo.png",
            website: "www.excelcollege.edu.ng",
            motto: "Excellence in Education"
        };
        
        if (term === 'Session') {
            // Generate session report card
            await generateSessionReportCard(student, academicYear, school, res);
        } else {
            // Generate term report card
            await generateTermReportCard(student, term, academicYear, school, res);
        }
        
    } catch (error) {
        console.error('Error generating report card:', error);
        return showAlertAndBack(res, 'Failed to generate report card: ' + error.message);
    }
});

// Generate term report card
async function generateTermReportCard(student, term, academicYear, school, res) {
    try {
        const connection = await getConnection();
        
        // Get scores for the selected term
        const [scores] = await connection.execute(`
            SELECT 
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
        `, [student.id, term, academicYear]);
        
        // Calculate term statistics
        let termTotal = 0;
        let termAverage = 0;
        let subjectCount = scores.length;
        
        if (scores.length > 0) {
            termTotal = scores.reduce((sum, score) => sum + parseFloat(score.total_score || 0), 0);
            termAverage = termTotal / scores.length;
        }
        
        const termPercentage = ((termAverage / 100) * 100).toFixed(2);
        
        // Determine grade for the term
        let termGrade = 'F';
        let gradeRemark = 'Fail';
        
        if (termAverage >= 80) {
            termGrade = 'A';
            gradeRemark = 'Excellent';
        } else if (termAverage >= 70) {
            termGrade = 'B';
            gradeRemark = 'Very Good';
        } else if (termAverage >= 60) {
            termGrade = 'C';
            gradeRemark = 'Good';
        } else if (termAverage >= 50) {
            termGrade = 'D';
            gradeRemark = 'Fair';
        } else if (termAverage >= 40) {
            termGrade = 'E';
            gradeRemark = 'Pass';
        }
        
        // Get term dates for attendance calculation
        const [termDates] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_terms 
            WHERE term_name = ? AND academic_year_id = (
                SELECT id FROM academic_years WHERE year_name = ?
            )
        `, [term, academicYear]);
        
        let attendance = {
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            excused_days: 0,
            total_days: 0
        };
        
        if (termDates.length > 0 && termDates[0].start_date && termDates[0].end_date) {
            // FIXED: Use the correct column names from your attendance_records table
            const [attendanceSummary] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? 
                AND date BETWEEN ? AND ?
            `, [student.id, termDates[0].start_date, termDates[0].end_date]);
            
            if (attendanceSummary.length > 0) {
                attendance = attendanceSummary[0];
            }
        }
        
        // Prefer the class where scores were recorded (important after promotion)
        let reportClassId = student.classId || null;
        try {
            const [scoreClassRows] = await connection.execute(`
                SELECT class_id FROM student_scores
                WHERE student_id = ? AND term = ? AND academic_year = ? AND class_id IS NOT NULL AND class_id != 0
                ORDER BY updated_at DESC LIMIT 1
            `, [student.id, term, academicYear]);
            if (scoreClassRows.length > 0) reportClassId = scoreClassRows[0].class_id;
        } catch (_) { /* ignore */ }

        // Get teacher's comments
        const teacherComment = await getReportCardComment(
            connection, student.id, term, academicYear, 'teacher', reportClassId
        ) || {
            comment: 'No comment available',
            comment_by: 'Class Teacher',
            comment_date: new Date()
        };
        
        // Get management / principal comments
        const principalComment = await getReportCardComment(
            connection, student.id, term, academicYear, 'management', reportClassId
        ) || {
            comment: 'Keep up the good work!',
            comment_by: 'Management',
            comment_date: new Date()
        };
        
        // Format scores with grades
        const formattedScores = scores.map(score => {
            const total = parseFloat(score.total_score) || 0;
            let grade = 'F';
            let remark = 'Fail';
            
            if (total >= 80) {
                grade = 'A';
                remark = 'Excellent';
            } else if (total >= 70) {
                grade = 'B';
                remark = 'Very Good';
            } else if (total >= 60) {
                grade = 'C';
                remark = 'Good';
            } else if (total >= 50) {
                grade = 'D';
                remark = 'Fair';
            } else if (total >= 40) {
                grade = 'E';
                remark = 'Pass';
            }
            
            return {
                ...score,
                grade: grade,
                remark: remark,
                formattedTotal: total.toFixed(1)
            };
        });
        
        res.render('report-card-term', {
            student: student,
            school: school,
            term: term,
            academicYear: academicYear,
            scores: formattedScores,
            termTotal: termTotal.toFixed(2),
            termAverage: termAverage.toFixed(2),
            termPercentage: termPercentage,
            termGrade: termGrade,
            gradeRemark: gradeRemark,
            subjectCount: subjectCount,
            attendance: attendance,
            teacherComment: teacherComment,
            principalComment: principalComment,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error generating term report card:', error);
        res.redirect(
            `/student-profile/${encodeURIComponent(student.id)}?error=` +
            encodeURIComponent('Failed to generate term report card.')
        );
    }
}

// Generate session report card
async function generateSessionReportCard(student, academicYear, school, res) {
    try {
        const connection = await getConnection();
        
        // Get scores for all terms in the academic year
        const [scores] = await connection.execute(`
            SELECT 
                s.name as subject_name,
                s.subject_code,
                sc.term,
                sc.test_score,
                sc.exam_score,
                COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
            FROM student_scores sc
            JOIN subjects s ON sc.subject_id = s.id
            WHERE sc.student_id = ? AND sc.academic_year = ?
            ORDER BY s.name, sc.term
        `, [student.id, academicYear]);
        
        // Organize scores by subject
        const subjectMap = {};
        scores.forEach(score => {
            if (!subjectMap[score.subject_name]) {
                subjectMap[score.subject_name] = {
                    subject_code: score.subject_code,
                    terms: {}
                };
            }
            subjectMap[score.subject_name].terms[score.term] = {
                test_score: score.test_score,
                exam_score: score.exam_score,
                total_score: score.total_score
            };
        });
        
        // Calculate subject averages and overall statistics
        let sessionTotal = 0;
        let subjectCount = 0;
        const subjectAverages = [];
        
        Object.keys(subjectMap).forEach(subjectName => {
            const subject = subjectMap[subjectName];
            let subjectTotal = 0;
            let termCount = 0;
            
            // Calculate average for each subject across all terms
            ['First Term', 'Second Term', 'Third Term'].forEach(term => {
                if (subject.terms[term]) {
                    subjectTotal += parseFloat(subject.terms[term].total_score || 0);
                    termCount++;
                }
            });
            
            const subjectAverage = termCount > 0 ? subjectTotal / termCount : 0;
            
            if (termCount > 0) {
                sessionTotal += subjectAverage;
                subjectCount++;
            }
            
            // Determine subject grade
            let subjectGrade = 'F';
            let subjectRemark = 'Fail';
            
            if (subjectAverage >= 80) {
                subjectGrade = 'A';
                subjectRemark = 'Excellent';
            } else if (subjectAverage >= 70) {
                subjectGrade = 'B';
                subjectRemark = 'Very Good';
            } else if (subjectAverage >= 60) {
                subjectGrade = 'C';
                subjectRemark = 'Good';
            } else if (subjectAverage >= 50) {
                subjectGrade = 'D';
                subjectRemark = 'Fair';
            } else if (subjectAverage >= 40) {
                subjectGrade = 'E';
                subjectRemark = 'Pass';
            }
            
            subjectAverages.push({
                subject_name: subjectName,
                subject_code: subject.subject_code,
                first_term: subject.terms['First Term'] ? parseFloat(subject.terms['First Term'].total_score).toFixed(1) : '-',
                second_term: subject.terms['Second Term'] ? parseFloat(subject.terms['Second Term'].total_score).toFixed(1) : '-',
                third_term: subject.terms['Third Term'] ? parseFloat(subject.terms['Third Term'].total_score).toFixed(1) : '-',
                average: subjectAverage.toFixed(1),
                grade: subjectGrade,
                remark: subjectRemark
            });
        });
        
        // Calculate overall session average
        const sessionAverage = subjectCount > 0 ? sessionTotal / subjectCount : 0;
        const sessionPercentage = ((sessionAverage / 100) * 100).toFixed(2);
        
        // Determine overall grade
        let sessionGrade = 'F';
        let sessionRemark = 'Fail';
        
        if (sessionAverage >= 80) {
            sessionGrade = 'A';
            sessionRemark = 'Excellent';
        } else if (sessionAverage >= 70) {
            sessionGrade = 'B';
            sessionRemark = 'Very Good';
        } else if (sessionAverage >= 60) {
            sessionGrade = 'C';
            sessionRemark = 'Good';
        } else if (sessionAverage >= 50) {
            sessionGrade = 'D';
            sessionRemark = 'Fair';
        } else if (sessionAverage >= 40) {
            sessionGrade = 'E';
            sessionRemark = 'Pass';
        }
        
        // Determine promotion status
        let promotionStatus = 'Repeat';
        let promotionAction = 'repeat';
        let promotionClass = 'danger';
        
        if (sessionAverage >= 45) {
            promotionStatus = 'Promote';
            promotionAction = 'promote';
            promotionClass = 'success';
        }
        
        // Get academic year dates for attendance calculation
        const [yearDates] = await connection.execute(`
            SELECT start_date, end_date 
            FROM academic_years 
            WHERE year_name = ?
        `, [academicYear]);
        
        let attendance = {
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            excused_days: 0,
            total_days: 0
        };
        
        if (yearDates.length > 0 && yearDates[0].start_date && yearDates[0].end_date) {
            // FIXED: Use the correct column names from your attendance_records table
            const [attendanceSummary] = await connection.execute(`
                SELECT 
                    COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_days,
                    COUNT(CASE WHEN (morning_status = 'absent' OR afternoon_status = 'absent') THEN 1 END) as absent_days,
                    COUNT(CASE WHEN (morning_status = 'late' OR afternoon_status = 'late') THEN 1 END) as late_days,
                    COUNT(CASE WHEN (morning_status = 'excused' OR afternoon_status = 'excused') THEN 1 END) as excused_days,
                    COUNT(*) as total_days
                FROM attendance_records 
                WHERE student_id = ? 
                AND date BETWEEN ? AND ?
            `, [student.id, yearDates[0].start_date, yearDates[0].end_date]);
            
            if (attendanceSummary.length > 0) {
                attendance = attendanceSummary[0];
            }
        }
        
        // Prefer the class where scores were recorded for this session (important after promotion)
        let reportClassId = student.classId || null;
        try {
            const [scoreClassRows] = await connection.execute(`
                SELECT class_id FROM student_scores
                WHERE student_id = ? AND academic_year = ? AND class_id IS NOT NULL AND class_id != 0
                ORDER BY updated_at DESC LIMIT 1
            `, [student.id, academicYear]);
            if (scoreClassRows.length > 0) reportClassId = scoreClassRows[0].class_id;
        } catch (_) { /* ignore */ }

        // Get teacher's comments for the session
        const teacherComment = await getReportCardComment(
            connection, student.id, 'Session', academicYear, 'teacher', reportClassId
        ) || {
            comment: 'No comment available',
            comment_by: 'Class Teacher',
            comment_date: new Date()
        };
        
        // Get management / principal comments for the session
        const principalComment = await getReportCardComment(
            connection, student.id, 'Session', academicYear, 'management', reportClassId
        ) || {
            comment: promotionStatus === 'Promote' ? 'Congratulations on your promotion!' : 'Please work harder next session.',
            comment_by: 'Management',
            comment_date: new Date()
        };
        
        res.render('report-card-session', {
            student: student,
            school: school,
            academicYear: academicYear,
            subjects: subjectAverages,
            sessionAverage: sessionAverage.toFixed(2),
            sessionPercentage: sessionPercentage,
            sessionGrade: sessionGrade,
            sessionRemark: sessionRemark,
            promotionStatus: promotionStatus,
            promotionAction: promotionAction,
            promotionClass: promotionClass,
            subjectCount: subjectCount,
            attendance: attendance,
            teacherComment: teacherComment,
            principalComment: principalComment,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error generating session report card:', error);
        res.redirect(
            `/student-profile/${encodeURIComponent(student.id)}?error=` +
            encodeURIComponent('Failed to generate session report card.')
        );
    }
}

// POST route to save teacher and management comments (term + session)
router.post('/api/save-student-comments', authenticate, async (req, res) => {
    const {
        studentId,
        classId,
        term,
        academicYear,
        teacherComment,
        managementComment,
        sessionTeacherComment,
        sessionManagementComment
    } = req.body;

    try {
        const role = req.session.role;
        if (role !== 'admin' && role !== 'teacher') {
            return res.status(403).json({
                success: false,
                error: 'Only teachers and admins can save comments'
            });
        }

        if (!studentId || !term || !academicYear) {
            return res.status(400).json({
                success: false,
                error: 'Student, Term, and Academic Year are required'
            });
        }

        const connection = await getConnection();
        await ensureStudentCommentsTable(connection);

        const commentBy = req.session.username || (role === 'admin' ? 'Admin' : 'Class Teacher');
        const commentByUserId = req.session.userId || null;
        const resolvedClassId = classId ? Number(classId) : null;

        // Teachers may update teacher comments; admins may update both
        if (role === 'teacher' || role === 'admin') {
            await upsertStudentComment(connection, {
                studentId,
                classId: resolvedClassId,
                term,
                academicYear,
                comment: teacherComment,
                commentBy: role === 'teacher' ? commentBy : (commentBy || 'Class Teacher'),
                commentByUserId,
                commentType: 'teacher'
            });

            await upsertStudentComment(connection, {
                studentId,
                classId: resolvedClassId,
                term: 'Session',
                academicYear,
                comment: sessionTeacherComment,
                commentBy: role === 'teacher' ? commentBy : (commentBy || 'Class Teacher'),
                commentByUserId,
                commentType: 'teacher'
            });
        }

        if (role === 'admin') {
            await upsertStudentComment(connection, {
                studentId,
                classId: resolvedClassId,
                term,
                academicYear,
                comment: managementComment,
                commentBy: commentBy || 'Management',
                commentByUserId,
                commentType: 'management'
            });

            await upsertStudentComment(connection, {
                studentId,
                classId: resolvedClassId,
                term: 'Session',
                academicYear,
                comment: sessionManagementComment,
                commentBy: commentBy || 'Management',
                commentByUserId,
                commentType: 'management'
            });
        } else if (managementComment || sessionManagementComment) {
            // Teachers cannot overwrite management comments; ignore silently if empty / warn if provided
            if ((managementComment && managementComment.trim()) || (sessionManagementComment && sessionManagementComment.trim())) {
                return res.status(403).json({
                    success: false,
                    error: 'Only admin/management can save management comments'
                });
            }
        }

        res.json({
            success: true,
            message: 'Comments saved successfully'
        });
    } catch (error) {
        console.error('Error saving student comments:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save comments: ' + error.message
        });
    }
});

// Keep legacy endpoint for compatibility
router.post('/add-comment', authenticate, async (req, res) => {
    const { studentId, classId, term, academicYear, comment, commentType } = req.body;
    
    try {
        const role = req.session.role;
        if (role !== 'admin' && role !== 'teacher') {
            return res.status(403).json({
                success: false,
                error: 'Only teachers and admins can add comments'
            });
        }

        if (!studentId || !term || !academicYear || !comment) {
            return res.status(400).json({
                success: false,
                error: 'Student, Term, Academic Year, and Comment are required'
            });
        }

        const resolvedType = (commentType === 'management' || commentType === 'principal')
            ? 'management'
            : 'teacher';

        if (resolvedType === 'management' && role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Only admin/management can add management comments'
            });
        }
        
        const connection = await getConnection();
        await ensureStudentCommentsTable(connection);

        const commentBy = req.session.username || (resolvedType === 'management' ? 'Management' : 'Class Teacher');
        const commentByUserId = req.session.userId || null;

        await upsertStudentComment(connection, {
            studentId,
            classId: classId ? Number(classId) : null,
            term,
            academicYear,
            comment,
            commentBy,
            commentByUserId,
            commentType: resolvedType
        });
        
        res.json({
            success: true,
            message: 'Comment added successfully'
        });
        
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add comment: ' + error.message
        });
    }
});

// API to get students for a class (for AJAX loading)
router.get('/api/students-by-class/:classId', authenticate, async (req, res) => {
    const { classId } = req.params;
    
    try {
        const connection = await getConnection();
        
        const [students] = await connection.execute(`
            SELECT id, firstName, middleName, lastName, admission_number
            FROM students 
            WHERE classId = ? 
            ORDER BY firstName, lastName
        `, [classId]);
        
        res.json({
            success: true,
            students: students
        });
        
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch students'
        });
    }
});

router.get('/class-bill/print/:id', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const billId = req.params.id;
        const schoolId = req.session.schoolId || null;
        const classBillsHaveSchoolId = await tableHasColumn(connection, 'class_bills', 'school_id');
        
        // Get the class bill
        const [bills] = classBillsHaveSchoolId
            ? await connection.execute('SELECT * FROM class_bills WHERE id = ? AND school_id = ?', [billId, schoolId])
            : await connection.execute('SELECT * FROM class_bills WHERE id = ?', [billId]);
        
        if (bills.length === 0) {
            return res.status(404).send('Bill not found');
        }
        
        const bill = bills[0];
        
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
        
        res.render('class-bill-print', {
            bill: bill,
            school: school,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading class bill:', error);
        res.status(500).send('Error loading bill');
    }
});


// Route to display printable book list
router.get('/books/print', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const { academicYear, classLevel, department, subject } = req.query;
        const schoolId = req.session.schoolId || null;
        const bookListsHaveSchoolId = await tableHasColumn(connection, 'book_lists', 'school_id');
        
        // Build WHERE clause based on filters
        let whereClause = 'WHERE 1=1';
        let queryParams = [];

        if (bookListsHaveSchoolId) {
            whereClause += ' AND school_id = ?';
            queryParams.push(schoolId);
        }
        
        if (academicYear && academicYear !== 'all') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }
        
        if (classLevel && classLevel !== 'all') {
            whereClause += ' AND class_level = ?';
            queryParams.push(classLevel);
        }
        
        if (department && department !== 'all') {
            whereClause += ' AND department = ?';
            queryParams.push(department);
        }
        
        if (subject && subject !== 'all') {
            whereClause += ' AND subject LIKE ?';
            queryParams.push(`%${subject}%`);
        }
        
        // Get books based on filters
        const [books] = await connection.execute(
            `SELECT * FROM book_lists ${whereClause} ORDER BY subject, title`,
            queryParams
        );
        
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
        
        // Get available academic years for filter
        const [academicYears] = await connection.execute(
            'SELECT DISTINCT academic_year FROM book_lists ORDER BY academic_year DESC'
        );
        
        res.render('book-list-print', {
            books: books,
            school: school,
            academicYears: academicYears,
            filters: {
                academicYear: academicYear || 'all',
                classLevel: classLevel || 'all',
                department: department || 'all',
                subject: subject || 'all'
            },
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error loading book list:', error);
        res.status(500).send('Error loading book list');
    }
});

// ==================== LESSON NOTES ROUTES ====================

// GET route - View lesson notes (Admin view all, Teacher view their own)
router.get('/lesson-notes', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const userId = req.session.userId;
        const userRole = req.session.role;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');

        // Get query parameters
        const classId = req.query.classId || null;
        const subjectId = req.query.subjectId || null;
        const term = req.query.term || null;
        const weekNumber = req.query.weekNumber || null;
        const academicYear = req.query.academicYear || null;
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        // Get unread notifications count
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const notificationTable = userRole === 'admin' ? 'admin_notifications' : 'teacher_notifications';
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = ?
            `, [notificationTable]);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ? AND is_read = 0
                `, [userId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ?
                `, [userId]);
                totalCount = totalResult[0]?.total || 0;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
        }

        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Get current academic year if none selected
        let selectedYear = academicYear;
        if (!selectedYear && academicYears.length > 0) {
            selectedYear = academicYears[0].year_name;
        }

        // Get terms
        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms WHERE school_id = ?
        `, [schoolId]);

        // Get weeks (1-11)
        const weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

        // Build query based on user role
        let whereClause = 'WHERE ln.school_id = ?';
        let queryParams = [schoolId];

        if (userRole === 'teacher') {
            whereClause += ' AND ln.teacher_id = ?';
            queryParams.push(userId);
        }

        if (classId) {
            whereClause += ' AND ln.class_id = ?';
            queryParams.push(classId);
        }

        if (subjectId) {
            whereClause += ' AND ln.subject_id = ?';
            queryParams.push(subjectId);
        }

        if (term) {
            whereClause += ' AND ln.term = ?';
            queryParams.push(term);
        }

        if (weekNumber) {
            whereClause += ' AND ln.week_number = ?';
            queryParams.push(weekNumber);
        }

        if (selectedYear) {
            whereClause += ' AND ln.academic_year = ?';
            queryParams.push(selectedYear);
        }

        // Get total count for pagination
        const [countResult] = await connection.execute(`
            SELECT COUNT(*) as total FROM lesson_notes ln
            ${whereClause}
        `, queryParams);
        const totalRecords = countResult[0]?.total || 0;
        const totalPages = Math.ceil(totalRecords / limit);

        // Get lesson notes
        const [lessonNotes] = await connection.execute(`
            SELECT ln.*, 
                   c.className,
                   s.name as subject_name,
                   CONCAT(t.firstName, ' ', t.lastName) as teacher_name,
                   DATE_FORMAT(ln.created_at, '%W, %M %d, %Y') as formatted_date
            FROM lesson_notes ln
            LEFT JOIN classes c ON ln.class_id = c.id
            LEFT JOIN subjects s ON ln.subject_id = s.id
            LEFT JOIN teachers t ON ln.teacher_id = t.id
            ${whereClause}
            ORDER BY ln.academic_year DESC, 
                     CASE ln.term
                         WHEN 'First Term' THEN 1
                         WHEN 'Second Term' THEN 2
                         WHEN 'Third Term' THEN 3
                     END,
                     ln.week_number ASC
            LIMIT ? OFFSET ?
        `, [...queryParams, limit, offset]);

        // Get classes for filter (admin sees all, teacher sees their classes)
        let classes = [];
        if (userRole === 'admin') {
            [classes] = await connection.execute(`
                SELECT id, className, level, department FROM classes WHERE school_id = ? ORDER BY className
            `, [schoolId]);
        } else {
            [classes] = await connection.execute(`
                SELECT c.id, c.className, c.level, c.department 
                FROM classes c
                WHERE c.professorId = ? AND c.school_id = ?
                ORDER BY c.className
            `, [userId, schoolId]);
        }

        // Get subjects for filter (admin sees all subjects for selected class, teacher sees their subjects)
        let subjects = [];
        if (classId) {
            if (userRole === 'admin') {
                [subjects] = await connection.execute(`
                    SELECT s.id, s.name FROM subjects s
                    JOIN class_subjects cs ON s.id = cs.subject_id
                    WHERE cs.class_id = ?
                    ORDER BY s.name
                `, [classId]);
            } else {
                [subjects] = await connection.execute(`
                    SELECT DISTINCT s.id, s.name FROM subjects s
                    JOIN class_subjects cs ON s.id = cs.subject_id
                    WHERE cs.class_id = ? AND cs.class_id IN (
                        SELECT id FROM classes WHERE professorId = ?
                    )
                    ORDER BY s.name
                `, [classId, userId]);
            }
        }

        res.render('lesson-notes', {
            lessonNotes: lessonNotes,
            classes: classes,
            subjects: subjects,
            academicYears: academicYears,
            terms: terms,
            weeks: weeks,
            selectedClassId: classId,
            selectedSubjectId: subjectId,
            selectedTerm: term,
            selectedWeekNumber: weekNumber,
            selectedAcademicYear: selectedYear,
            currentPage: page,
            totalPages: totalPages,
            totalRecords: totalRecords,
            userRole: userRole,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Lesson Notes',
            currentPage: 'lesson-notes'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading lesson notes:', error);
        res.render('lesson-notes', {
            lessonNotes: [],
            classes: [],
            subjects: [],
            academicYears: [],
            terms: [],
            weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: null,
            selectedWeekNumber: null,
            selectedAcademicYear: null,
            currentPage: 1,
            totalPages: 1,
            totalRecords: 0,
            userRole: req.session.role,
            username: req.session.username || 'User',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load lesson notes: ' + error.message
        });
    }
});

// GET route - Create Lesson Note form
router.get('/lesson-notes/create', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const userId = req.session.userId;
        const userRole = req.session.role;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');

        // Check if user is admin or teacher
        if (userRole !== 'admin' && userRole !== 'teacher') {
            req.session.error = 'Access denied';
            return res.redirect('/dashboard');
        }

        // Get unread notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const notificationTable = userRole === 'admin' ? 'admin_notifications' : 'teacher_notifications';
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = ?
            `, [notificationTable]);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ? AND is_read = 0
                `, [userId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ?
                `, [userId]);
                totalCount = totalResult[0]?.total || 0;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
        }

        // Get all classes with level and department
        let allClasses = [];
        if (userRole === 'admin') {
            [allClasses] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ? 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `, [schoolId]);
        } else {
            [allClasses] = await connection.execute(`
                SELECT c.id, c.className, c.level, c.department 
                FROM classes c
                WHERE c.professorId = ? AND c.school_id = ?
                ORDER BY 
                    CASE c.level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    c.className
            `, [userId, schoolId]);
        }

        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Get terms
        const [terms] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE school_id = ?
        `, [schoolId]);

        // Weeks 1-11
        const weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

        res.render('lesson-notes-form', {
            allClasses: allClasses,
            academicYears: academicYears,
            terms: terms,
            weeks: weeks,
            lessonNote: {},
            isEdit: false,
            userRole: userRole,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            error: null,
            subjects: [] // Empty subjects array, will be loaded via AJAX
        });

    } catch (error) {
        console.error('Error loading create lesson note form:', error);
        res.render('lesson-notes-form', {
            allClasses: [],
            academicYears: [],
            terms: [],
            weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            lessonNote: {},
            isEdit: false,
            userRole: req.session.role,
            username: req.session.username || 'User',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load form: ' + error.message,
            subjects: []
        });
    }
});

// API route - Get subjects by class (for dynamic subject selection)
router.get('/api/subjects-by-class', authenticate, async (req, res) => {
    const { classId } = req.query;
    const userId = req.session.userId;
    const userRole = req.session.role;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        let query = `
            SELECT s.id, s.name, s.subject_code 
            FROM subjects s
            INNER JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
        `;
        let params = [classId];

        if (userRole === 'teacher') {
            query += ` AND cs.class_id IN (SELECT id FROM classes WHERE professorId = ? AND school_id = ?)`;
            params.push(userId, schoolId);
        }

        query += ` ORDER BY s.name`;

        const [subjects] = await connection.execute(query, params);

        res.json({ success: true, subjects: subjects });

    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// POST route - Save Lesson Note
// ==================== LESSON NOTES ROUTES ====================

// Helper function to strip HTML tags
function stripHtml(html) {
    if (!html) return '';
    // Remove HTML tags but keep line breaks
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// POST route - Save Lesson Note
router.post('/lesson-notes/save', authenticate, uploadLessonNote.single('lessonNoteFile'), async (req, res) => {
    const { lessonNoteId, classId, subjectId, academicYear, term, weekNumber, title, content, objectives, materials, reference_materials, status } = req.body;
    const userId = req.session.userId;
    const userRole = req.session.role;
    const schoolId = req.session.schoolId || null;
    let filePath = null;

    try {
        const connection = await getConnection();

        // Handle file upload
        if (req.file) {
            filePath = '/uploads/lesson-notes/' + req.file.filename;
        } else if (req.body.existingFile && req.body.existingFile !== '') {
            filePath = req.body.existingFile;
        }

        // Validate required fields
        if (!classId || !subjectId || !academicYear || !term || !weekNumber || !title || !content) {
            req.session.error = 'Class, Subject, Academic Year, Term, Week, Title, and Content are required';
            return res.redirect('/lesson-notes/create');
        }

        // Strip HTML from content fields
        const plainContent = stripHtml(content);
        const plainObjectives = objectives ? stripHtml(objectives) : null;
        const plainMaterials = materials ? stripHtml(materials) : null;
        const plainReferenceMaterials = reference_materials ? stripHtml(reference_materials) : null;

        // For teachers, verify they teach this class and subject
        if (userRole === 'teacher') {
            const [classCheck] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [classId, userId, schoolId]);

            if (classCheck.length === 0) {
                req.session.error = 'You are not assigned to this class';
                return res.redirect('/lesson-notes/create');
            }

            const [subjectCheck] = await connection.execute(`
                SELECT cs.id FROM class_subjects cs
                WHERE cs.class_id = ? AND cs.subject_id = ?
            `, [classId, subjectId]);

            if (subjectCheck.length === 0) {
                req.session.error = 'This subject is not assigned to the selected class';
                return res.redirect('/lesson-notes/create');
            }
        }

        // Get teacher_id (if admin, need to get teacher assigned to class)
        let teacherId = userId;
        if (userRole === 'admin') {
            const [classInfo] = await connection.execute(`
                SELECT professorId FROM classes WHERE id = ? AND school_id = ?
            `, [classId, schoolId]);
            teacherId = classInfo[0]?.professorId;
            if (!teacherId) {
                req.session.error = 'No teacher assigned to this class';
                return res.redirect('/lesson-notes/create');
            }
        }

        // Check if lesson note already exists for this class, subject, term, week
        if (!lessonNoteId) {
            const [existing] = await connection.execute(`
                SELECT id FROM lesson_notes 
                WHERE class_id = ? AND subject_id = ? AND academic_year = ? AND term = ? AND week_number = ? AND school_id = ?
            `, [classId, subjectId, academicYear, term, weekNumber, schoolId]);

            if (existing.length > 0) {
                req.session.error = `Lesson note already exists for Week ${weekNumber} of ${term} ${academicYear}`;
                return res.redirect('/lesson-notes/create');
            }
        }

        if (lessonNoteId && lessonNoteId !== '') {
            // Update existing lesson note - using plain text versions
            await connection.execute(`
                UPDATE lesson_notes SET
                    class_id = ?, subject_id = ?, academic_year = ?, term = ?, week_number = ?,
                    title = ?, content = ?, objectives = ?, materials = ?, reference_materials = ?, 
                    file_path = ?, status = ?, updated_at = NOW()
                WHERE id = ? AND school_id = ?
            `, [classId, subjectId, academicYear, term, weekNumber, title, plainContent, plainObjectives,
                plainMaterials, plainReferenceMaterials, filePath, status || 'draft', lessonNoteId, schoolId]);

            req.session.success = 'Lesson note updated successfully';
        } else {
            // Insert new lesson note - using plain text versions
            await connection.execute(`
                INSERT INTO lesson_notes 
                (teacher_id, class_id, subject_id, academic_year, term, week_number, 
                 title, content, objectives, materials, reference_materials, file_path, status, school_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [teacherId, classId, subjectId, academicYear, term, weekNumber, title, plainContent,
                plainObjectives, plainMaterials, plainReferenceMaterials, filePath, status || 'draft', schoolId, userId]);

            req.session.success = 'Lesson note created successfully';
        }

        res.redirect('/lesson-notes');

    } catch (error) {
        console.error('Error saving lesson note:', error);
        req.session.error = 'Failed to save lesson note: ' + error.message;
        res.redirect('/lesson-notes/create');
    }
});

// GET route - Edit Lesson Note
router.get('/lesson-notes/edit/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const userId = req.session.userId;
        const userRole = req.session.role;
        const schoolId = req.session.schoolId || null;
        const lessonNoteId = req.params.id;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');

        // Get unread notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const notificationTable = userRole === 'admin' ? 'admin_notifications' : 'teacher_notifications';
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = ?
            `, [notificationTable]);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ? AND is_read = 0
                `, [userId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ?
                `, [userId]);
                totalCount = totalResult[0]?.total || 0;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
        }

        // Get lesson note
        let whereClause = 'id = ? AND school_id = ?';
        let queryParams = [lessonNoteId, schoolId];

        if (userRole === 'teacher') {
            whereClause += ' AND teacher_id = ?';
            queryParams.push(userId);
        }

        const [lessonNotes] = await connection.execute(`
            SELECT ln.*, s.name as subject_name
            FROM lesson_notes ln
            LEFT JOIN subjects s ON ln.subject_id = s.id
            WHERE ${whereClause}
        `, queryParams);

        if (lessonNotes.length === 0) {
            req.session.error = 'Lesson note not found or access denied';
            return res.redirect('/lesson-notes');
        }

        // Get all classes with level and department
        let allClasses = [];
        if (userRole === 'admin') {
            [allClasses] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes 
                WHERE school_id = ? 
                ORDER BY 
                    CASE level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    className
            `, [schoolId]);
        } else {
            [allClasses] = await connection.execute(`
                SELECT c.id, c.className, c.level, c.department 
                FROM classes c
                WHERE c.professorId = ? AND c.school_id = ?
                ORDER BY 
                    CASE c.level
                        WHEN 'KG' THEN 1
                        WHEN 'NURSERY' THEN 2
                        WHEN 'PRIMARY' THEN 3
                        WHEN 'JUNIOR SECONDARY' THEN 4
                        WHEN 'SENIOR SECONDARY' THEN 5
                    END,
                    c.className
            `, [userId, schoolId]);
        }

        // Get academic years
        const [academicYears] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Get terms
        const [terms] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE school_id = ?
        `, [schoolId]);

        // Weeks 1-11
        const weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

        res.render('lesson-notes-form', {
            allClasses: allClasses,
            academicYears: academicYears,
            terms: terms,
            weeks: weeks,
            lessonNote: lessonNotes[0],
            isEdit: true,
            userRole: userRole,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading lesson note for edit:', error);
        req.session.error = 'Failed to load lesson note';
        res.redirect('/lesson-notes');
    }
});

// GET route - View Lesson Note
router.get('/lesson-notes/view/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const userId = req.session.userId;
        const userRole = req.session.role;
        const schoolId = req.session.schoolId || null;
        const lessonNoteId = req.params.id;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');

        // Get unread notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const notificationTable = userRole === 'admin' ? 'admin_notifications' : 'teacher_notifications';
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = ?
            `, [notificationTable]);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ? AND is_read = 0
                `, [userId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM ${notificationTable} 
                    WHERE ${userRole === 'admin' ? 'admin_id' : 'teacher_id'} = ?
                `, [userId]);
                totalCount = totalResult[0]?.total || 0;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
        }

        // Get lesson note with details
        let whereClause = 'ln.id = ? AND ln.school_id = ?';
        let queryParams = [lessonNoteId, schoolId];

        if (userRole === 'teacher') {
            whereClause += ' AND ln.teacher_id = ?';
            queryParams.push(userId);
        }

        const [lessonNotes] = await connection.execute(`
            SELECT ln.*, 
                   c.className,
                   s.name as subject_name,
                   CONCAT(t.firstName, ' ', t.lastName) as teacher_name,
                   DATE_FORMAT(ln.created_at, '%W, %M %d, %Y at %h:%i %p') as created_date,
                   DATE_FORMAT(ln.updated_at, '%W, %M %d, %Y at %h:%i %p') as updated_date
            FROM lesson_notes ln
            LEFT JOIN classes c ON ln.class_id = c.id
            LEFT JOIN subjects s ON ln.subject_id = s.id
            LEFT JOIN teachers t ON ln.teacher_id = t.id
            WHERE ${whereClause}
        `, queryParams);

        if (lessonNotes.length === 0) {
            req.session.error = 'Lesson note not found or access denied';
            return res.redirect('/lesson-notes');
        }

        // Get comments
        const [comments] = await connection.execute(`
            SELECT lc.*, u.username 
            FROM lesson_note_comments lc
            LEFT JOIN users u ON lc.user_id = u.id
            WHERE lc.lesson_note_id = ?
            ORDER BY lc.created_at ASC
        `, [lessonNoteId]);

        res.render('lesson-notes-view', {
            lessonNote: lessonNotes[0],
            comments: comments,
            userRole: userRole,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error viewing lesson note:', error);
        req.session.error = 'Failed to load lesson note';
        res.redirect('/lesson-notes');
    }
});

// GET route - Delete Lesson Note
router.get('/lesson-notes/delete/:id', authenticate, async (req, res) => {
    const lessonNoteId = req.params.id;
    const userId = req.session.userId;
    const userRole = req.session.role;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        let whereClause = 'id = ? AND school_id = ?';
        let queryParams = [lessonNoteId, schoolId];

        if (userRole === 'teacher') {
            whereClause += ' AND teacher_id = ?';
            queryParams.push(userId);
        }

        await connection.execute(`
            DELETE FROM lesson_notes WHERE ${whereClause}
        `, queryParams);

        req.session.success = 'Lesson note deleted successfully';
        res.redirect('/lesson-notes');

    } catch (error) {
        console.error('Error deleting lesson note:', error);
        req.session.error = 'Failed to delete lesson note';
        res.redirect('/lesson-notes');
    }
});

// POST route - Add comment to lesson note
router.post('/lesson-notes/add-comment', authenticate, uploadNoFile.none(), async (req, res) => {
    const { lessonNoteId, comment } = req.body;
    const userId = req.session.userId;
    const userRole = req.session.role;

    try {
        const connection = await getConnection();

        if (!lessonNoteId || !comment) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        await connection.execute(`
            INSERT INTO lesson_note_comments (lesson_note_id, user_id, user_role, comment, created_at)
            VALUES (?, ?, ?, ?, NOW())
        `, [lessonNoteId, userId, userRole, comment]);

        res.json({ success: true, message: 'Comment added successfully' });

    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API route - Get subjects by class (for dynamic subject selection)
router.get('/api/lesson-notes/subjects/:classId', authenticate, async (req, res) => {
    const classId = req.params.classId;
    const userId = req.session.userId;
    const userRole = req.session.role;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        let query = `
            SELECT s.id, s.name FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            WHERE cs.class_id = ?
        `;
        let params = [classId];

        if (userRole === 'teacher') {
            query += ` AND cs.class_id IN (SELECT id FROM classes WHERE professorId = ? AND school_id = ?)`;
            params.push(userId, schoolId);
        }

        query += ` ORDER BY s.name`;

        const [subjects] = await connection.execute(query, params);

        res.json({ success: true, subjects: subjects });

    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API route - Check if lesson note exists for week
router.get('/api/lesson-notes/check', authenticate, async (req, res) => {
    const { classId, subjectId, academicYear, term, weekNumber } = req.query;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        const [existing] = await connection.execute(`
            SELECT id, title, status FROM lesson_notes 
            WHERE class_id = ? AND subject_id = ? AND academic_year = ? AND term = ? AND week_number = ? AND school_id = ?
        `, [classId, subjectId, academicYear, term, weekNumber, schoolId]);

        if (existing.length > 0) {
            res.json({
                success: true,
                exists: true,
                lessonNoteId: existing[0].id,
                title: existing[0].title,
                status: existing[0].status
            });
        } else {
            res.json({ success: true, exists: false });
        }

    } catch (error) {
        console.error('Error checking lesson note:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== BOOK LISTS ROUTES ====================

// Helper function to strip HTML tags (for safety)
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// GET route - Manage Book Lists
router.get('/manage-book-lists', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                totalCount = totalResult[0]?.total || 0;

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
            totalCount = 0;
            notifications = [];
        }

        // Get filter parameters
        const { academicYear, classLevel, department, subject } = req.query;

        // Build WHERE clause for filtering
        let whereClause = 'WHERE school_id = ?';
        let queryParams = [schoolId];

        if (academicYear && academicYear !== 'all') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }

        if (classLevel && classLevel !== 'all') {
            whereClause += ' AND class_level = ?';
            queryParams.push(classLevel);
        }

        if (department && department !== 'all') {
            whereClause += ' AND department = ?';
            queryParams.push(department);
        }

        if (subject && subject !== 'all') {
            whereClause += ' AND subject LIKE ?';
            queryParams.push(`%${subject}%`);
        }

        // Get book lists with filters
        const [bookLists] = await connection.execute(`
            SELECT * FROM book_lists 
            ${whereClause}
            ORDER BY academic_year DESC, class_level, subject, title
        `, queryParams);

        // FIXED: Get distinct values for filter dropdowns with proper column aliases
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT academic_year as year_name 
            FROM book_lists 
            WHERE school_id = ? 
            ORDER BY academic_year DESC
        `, [schoolId]);

        const [classLevels] = await connection.execute(`
            SELECT DISTINCT class_level as level_name 
            FROM book_lists 
            WHERE school_id = ? 
            ORDER BY class_level
        `, [schoolId]);

        const [departments] = await connection.execute(`
            SELECT DISTINCT department as dept_name 
            FROM book_lists 
            WHERE school_id = ? AND department IS NOT NULL 
            ORDER BY department
        `, [schoolId]);

        const [subjects] = await connection.execute(`
            SELECT DISTINCT subject as subject_name 
            FROM book_lists 
            WHERE school_id = ? 
            ORDER BY subject
        `, [schoolId]);

        // Prepare filters object for the view
        const filters = {
            academicYear: academicYear || 'all',
            classLevel: classLevel || 'all',
            department: department || 'all',
            subject: subject || 'all'
        };

        res.render('manage-book-lists', {
            bookLists: bookLists,
            academicYears: academicYears,
            classLevels: classLevels,
            departments: departments,
            subjects: subjects,
            filters: filters,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null
        });

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading book lists:', error);
        res.render('manage-book-lists', {
            bookLists: [],
            academicYears: [],
            classLevels: [],
            departments: [],
            subjects: [],
            filters: {
                academicYear: 'all',
                classLevel: 'all',
                department: 'all',
                subject: 'all'
            },
            username: req.session.username || 'Admin',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load book lists: ' + error.message
        });
    }
});

// GET route - Add/Edit Book List Form
router.get('/manage-book-lists/form', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';
        const id = req.query.id;

        // Get unread notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                totalCount = totalResult[0]?.total || 0;

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
            totalCount = 0;
            notifications = [];
        }

        let bookList = {};
        let isEdit = false;

        // If editing, get existing book list data
        if (id) {
            const [bookLists] = await connection.execute(`
                SELECT * FROM book_lists WHERE id = ? AND school_id = ?
            `, [id, schoolId]);

            if (bookLists.length > 0) {
                bookList = bookLists[0];
                isEdit = true;
            } else {
                req.session.error = 'Book not found';
                return res.redirect('/manage-book-lists');
            }
        }

        // Get academic years for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years WHERE school_id = ? ORDER BY start_date DESC
        `, [schoolId]);

        // Get class levels for dropdown
        const [classLevels] = await connection.execute(`
            SELECT DISTINCT level FROM classes WHERE school_id = ? ORDER BY 
                CASE level
                    WHEN 'KG' THEN 1
                    WHEN 'NURSERY' THEN 2
                    WHEN 'PRIMARY' THEN 3
                    WHEN 'JUNIOR SECONDARY' THEN 4
                    WHEN 'SENIOR SECONDARY' THEN 5
                END
        `, [schoolId]);

        // Get departments for dropdown
        const [departments] = await connection.execute(`
            SELECT DISTINCT department FROM classes WHERE school_id = ? AND department IS NOT NULL ORDER BY department
        `, [schoolId]);

        res.render('book-list-form', {
            bookList: bookList,
            isEdit: isEdit,
            academicYears: academicYears,
            classLevels: classLevels,
            departments: departments,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            error: req.session.error || null,
            success: req.session.success || null
        });

        // Clear session messages
        delete req.session.error;
        delete req.session.success;

    } catch (error) {
        console.error('Error loading book list form:', error);
        req.session.error = 'Failed to load form: ' + error.message;
        res.redirect('/manage-book-lists');
    }
});

// POST route - Save Book List (AJAX)
router.post('/manage-book-lists/save', authenticate, requireRole('admin'), async (req, res) => {
    const { id, academicYear, classLevel, department, subject, title, author, isbn, publisher, edition, quantity, notes } = req.body;
    const schoolId = req.session.schoolId || null;
    const userId = req.session.userId;

    try {
        const connection = await getConnection();

        // Validate required fields
        if (!academicYear || !classLevel || !subject || !title) {
            return res.status(400).json({
                success: false,
                error: 'Academic Year, Class Level, Subject, and Title are required'
            });
        }

        // Sanitize inputs
        const sanitizedTitle = stripHtml(title);
        const sanitizedSubject = stripHtml(subject);
        const sanitizedAuthor = author ? stripHtml(author) : null;
        const sanitizedIsbn = isbn ? stripHtml(isbn) : null;
        const sanitizedPublisher = publisher ? stripHtml(publisher) : null;
        const sanitizedEdition = edition ? stripHtml(edition) : null;
        const sanitizedNotes = notes ? stripHtml(notes) : null;
        const quantityValue = parseInt(quantity) || 0;

        // Check if book list entry already exists (for new entries)
        if (!id || id === '') {
            const [existing] = await connection.execute(`
                SELECT id FROM book_lists 
                WHERE academic_year = ? AND class_level = ? AND subject = ? AND title = ? AND school_id = ?
            `, [academicYear, classLevel, sanitizedSubject, sanitizedTitle, schoolId]);

            if (existing.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'This book already exists for the selected year, class, and subject'
                });
            }
        }

        if (id && id !== '') {
            // Update existing entry
            await connection.execute(`
                UPDATE book_lists SET
                    academic_year = ?,
                    class_level = ?,
                    department = ?,
                    subject = ?,
                    title = ?,
                    author = ?,
                    isbn = ?,
                    publisher = ?,
                    edition = ?,
                    quantity = ?,
                    notes = ?,
                    updated_at = NOW()
                WHERE id = ? AND school_id = ?
            `, [
                academicYear,
                classLevel,
                department || null,
                sanitizedSubject,
                sanitizedTitle,
                sanitizedAuthor,
                sanitizedIsbn,
                sanitizedPublisher,
                sanitizedEdition,
                quantityValue,
                sanitizedNotes,
                id,
                schoolId
            ]);

            return res.json({
                success: true,
                message: 'Book updated successfully'
            });
        } else {
            // Insert new entry
            await connection.execute(`
                INSERT INTO book_lists 
                (academic_year, class_level, department, subject, title, author, isbn, 
                 publisher, edition, quantity, notes, school_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                academicYear,
                classLevel,
                department || null,
                sanitizedSubject,
                sanitizedTitle,
                sanitizedAuthor,
                sanitizedIsbn,
                sanitizedPublisher,
                sanitizedEdition,
                quantityValue,
                sanitizedNotes,
                schoolId,
                userId
            ]);

            return res.json({
                success: true,
                message: 'Book added successfully'
            });
        }

    } catch (error) {
        console.error('Error saving book list:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save book: ' + error.message
        });
    }
});

// GET route - Delete Book List Entry
router.get('/manage-book-lists/delete/:id', authenticate, requireRole('admin'), async (req, res) => {
    const id = req.params.id;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Check if book exists
        const [bookCheck] = await connection.execute(`
            SELECT title FROM book_lists WHERE id = ? AND school_id = ?
        `, [id, schoolId]);

        if (bookCheck.length === 0) {
            req.session.error = 'Book not found';
            return res.redirect('/manage-book-lists');
        }

        const bookTitle = bookCheck[0].title;

        // Delete the book
        await connection.execute(`
            DELETE FROM book_lists WHERE id = ? AND school_id = ?
        `, [id, schoolId]);

        req.session.success = `Book "${bookTitle}" deleted successfully`;
        res.redirect('/manage-book-lists');

    } catch (error) {
        console.error('Error deleting book list entry:', error);
        req.session.error = 'Failed to delete book: ' + error.message;
        res.redirect('/manage-book-lists');
    }
});

// GET route - Export Book List as CSV
router.get('/manage-book-lists/export', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const { academicYear, classLevel, department, subject } = req.query;

        let whereClause = 'WHERE school_id = ?';
        let queryParams = [schoolId];

        if (academicYear && academicYear !== 'all') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }

        if (classLevel && classLevel !== 'all') {
            whereClause += ' AND class_level = ?';
            queryParams.push(classLevel);
        }

        if (department && department !== 'all') {
            whereClause += ' AND department = ?';
            queryParams.push(department);
        }

        if (subject && subject !== 'all') {
            whereClause += ' AND subject LIKE ?';
            queryParams.push(`%${subject}%`);
        }

        const [bookLists] = await connection.execute(`
            SELECT academic_year, class_level, department, subject, title, author, 
                   isbn, publisher, edition, quantity, notes
            FROM book_lists
            ${whereClause}
            ORDER BY academic_year DESC, class_level, subject, title
        `, queryParams);

        // Set CSV headers
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=book_lists_export.csv');

        // CSV Headers
        let csvRows = [];
        csvRows.push([
            'Academic Year',
            'Class Level',
            'Department',
            'Subject',
            'Title',
            'Author',
            'ISBN',
            'Publisher',
            'Edition',
            'Quantity',
            'Notes'
        ]);

        // Add data rows
        bookLists.forEach(book => {
            csvRows.push([
                book.academic_year || '',
                book.class_level || '',
                book.department || '',
                book.subject || '',
                book.title || '',
                book.author || '',
                book.isbn || '',
                book.publisher || '',
                book.edition || '',
                book.quantity || 0,
                book.notes || ''
            ]);
        });

        const csvContent = csvRows.map(row => row.join(',')).join('\n');
        res.send(csvContent);

    } catch (error) {
        console.error('Error exporting book lists:', error);
        res.status(500).send('Failed to export book lists');
    }
});

// GET route - Print Book List
router.get('/books/print', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const { academicYear, classLevel, department, subject } = req.query;

        let whereClause = 'WHERE school_id = ?';
        let queryParams = [schoolId];

        if (academicYear && academicYear !== 'all') {
            whereClause += ' AND academic_year = ?';
            queryParams.push(academicYear);
        }

        if (classLevel && classLevel !== 'all') {
            whereClause += ' AND class_level = ?';
            queryParams.push(classLevel);
        }

        if (department && department !== 'all') {
            whereClause += ' AND department = ?';
            queryParams.push(department);
        }

        if (subject && subject !== 'all') {
            whereClause += ' AND subject LIKE ?';
            queryParams.push(`%${subject}%`);
        }

        const [bookLists] = await connection.execute(`
            SELECT * FROM book_lists
            ${whereClause}
            ORDER BY academic_year DESC, class_level, subject, title
        `, queryParams);

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

        res.render('book-list-print', {
            books: bookLists,
            school: school,
            filters: {
                academicYear: academicYear || 'all',
                classLevel: classLevel || 'all',
                department: department || 'all',
                subject: subject || 'all'
            },
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading book list for print:', error);
        res.status(500).send('Error loading book list');
    }
});

// GET route - Admin Profile
router.get('/admin/profile', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const schoolId = req.session.schoolId;
        const username = req.session.username || 'Admin';

        // Get admin user data
        const [users] = await connection.execute(
            `SELECT id, username, email, role, school_id, created_at 
             FROM users WHERE id = ?`,
            [adminId]
        );

        if (users.length === 0) {
            req.session.error = 'Admin not found';
            return res.redirect('/');
        }

        const admin = users[0];

        // Get school info
        const [schoolInfo] = await connection.execute(
            'SELECT * FROM school_info WHERE id = ?',
            [schoolId]
        );
        const school = schoolInfo.length > 0 ? schoolInfo[0] : null;

        // Get statistics
        const [studentCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM students WHERE school_id = ?',
            [schoolId]
        );
        const [teacherCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM teachers WHERE school_id = ?',
            [schoolId]
        );
        const [classCount] = await connection.execute(
            'SELECT COUNT(*) as count FROM classes WHERE school_id = ?',
            [schoolId]
        );

        const stats = {
            studentCount: studentCount[0]?.count || 0,
            teacherCount: teacherCount[0]?.count || 0,
            classCount: classCount[0]?.count || 0
        };

        // Get recent activities - check if activities table exists
        let activities = [];
        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'activities'
            `);

            if (tableCheck[0].count > 0) {
                const [activityData] = await connection.execute(`
                    SELECT * FROM activities 
                    WHERE school_id = ? 
                    ORDER BY created_at DESC 
                    LIMIT 10
                `, [schoolId]);
                activities = activityData;
            }
        } catch (err) {
            console.error('Error fetching activities:', err.message);
            activities = [];
        }

        // Get notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                totalCount = totalResult[0]?.total || 0;

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
            totalCount = 0;
            notifications = [];
        }

        res.render('admin-profile', {
            admin: admin,
            school: school,
            stats: stats,
            activities: activities,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading admin profile:', error);
        res.status(500).render('error', {
            message: 'Error loading admin profile',
            error: { status: 500, message: error.message },
            username: req.session.username || 'Admin'
        });
    }
});

// ==================== ADMIN PROFILE MANAGEMENT ROUTES ====================

// GET route - Edit Admin Profile Form
router.get('/admin/profile/edit', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const schoolId = req.session.schoolId;
        const username = req.session.username || 'Admin';

        // Get admin user data
        const [users] = await connection.execute(
            `SELECT id, username, email, role, school_id, created_at 
             FROM users WHERE id = ?`,
            [adminId]
        );

        if (users.length === 0) {
            req.session.error = 'Admin not found';
            return res.redirect('/');
        }

        const admin = users[0];

        // Get school info
        const [schoolInfo] = await connection.execute(
            'SELECT * FROM school_info WHERE id = ?',
            [schoolId]
        );
        const school = schoolInfo.length > 0 ? schoolInfo[0] : null;

        // Get notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total FROM admin_notifications 
                    WHERE admin_id = ?
                `, [adminId]);
                totalCount = totalResult[0]?.total || 0;

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
        }

        res.render('admin-profile-edit', {
            admin: admin,
            school: school,
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            error: req.session.error || null,
            success: req.session.success || null,
            moment: require('moment')
        });

        // Clear session messages
        delete req.session.error;
        delete req.session.success;

    } catch (error) {
        console.error('Error loading edit profile form:', error);
        res.status(500).render('error', {
            message: 'Error loading edit profile form',
            error: { status: 500, message: error.message },
            username: req.session.username || 'Admin'
        });
    }
});

// POST route - Update Admin Profile
router.post('/admin/profile/edit', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const schoolId = req.session.schoolId;
        const { username, email, schoolName, schoolEmail, schoolPhone, schoolWebsite, schoolAddress } = req.body;

        // Validate required fields
        if (!username || !email) {
            req.session.error = 'Username and Email are required';
            return res.redirect('/admin/profile/edit');
        }

        // Check if username already exists (excluding current admin)
        const [existingUsers] = await connection.execute(
            'SELECT id FROM users WHERE username = ? AND id != ?',
            [username, adminId]
        );

        if (existingUsers.length > 0) {
            req.session.error = 'Username already taken';
            return res.redirect('/admin/profile/edit');
        }

        // Check if email already exists (excluding current admin)
        const [existingEmails] = await connection.execute(
            'SELECT id FROM users WHERE email = ? AND id != ?',
            [email, adminId]
        );

        if (existingEmails.length > 0) {
            req.session.error = 'Email already in use';
            return res.redirect('/admin/profile/edit');
        }

        // Start transaction
        await connection.beginTransaction();

        try {
            // Update admin user
            await connection.execute(
                'UPDATE users SET username = ?, email = ? WHERE id = ?',
                [username, email, adminId]
            );

            // Update school info if school exists
            if (schoolId) {
                await connection.execute(
                    `UPDATE school_info SET 
                        name = ?, 
                        email = ?, 
                        phone = ?, 
                        website = ?, 
                        address = ? 
                     WHERE id = ?`,
                    [
                        schoolName || null,
                        schoolEmail || null,
                        schoolPhone || null,
                        schoolWebsite || null,
                        schoolAddress || null,
                        schoolId
                    ]
                );
            }

            await connection.commit();

            // Update session data
            req.session.username = username;
            req.session.email = email;

            req.session.success = 'Profile updated successfully!';
            res.redirect('/admin/profile');

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error updating admin profile:', error);
        req.session.error = 'Failed to update profile: ' + error.message;
        res.redirect('/admin/profile/edit');
    }
});


// GET route - Change Password Form


// GET route - Admin Notifications
router.get('/admin/notifications', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';
        const { filter = 'all', page = 1 } = req.query;
        const limit = 20;
        const offset = (parseInt(page) - 1) * limit;

        // Get unread count for badge
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];
        let totalRecords = 0;
        let totalPages = 1;

        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'admin_notifications'
            `);

            if (tableCheck[0].count > 0) {
                // Get unread count
                const [unreadResult] = await connection.execute(`
                    SELECT COUNT(*) as count FROM admin_notifications 
                    WHERE admin_id = ? AND is_read = 0
                `, [adminId]);
                unreadCount = unreadResult[0]?.count || 0;

                // Build where clause for filtering
                let whereClause = 'WHERE admin_id = ?';
                let queryParams = [adminId];

                if (filter === 'unread') {
                    whereClause += ' AND is_read = 0';
                } else if (filter === 'read') {
                    whereClause += ' AND is_read = 1';
                }

                // Get total count for pagination
                const [totalResult] = await connection.execute(
                    `SELECT COUNT(*) as total FROM admin_notifications ${whereClause}`,
                    queryParams
                );
                totalRecords = totalResult[0]?.total || 0;
                totalPages = Math.ceil(totalRecords / limit);

                // Get notifications with pagination
                const [notificationList] = await connection.execute(`
                    SELECT id, title, message, is_read, type, created_at,
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date,
                           DATE_FORMAT(read_at, '%W, %M %d, %Y at %h:%i %p') as read_date
                    FROM admin_notifications 
                    ${whereClause}
                    ORDER BY created_at DESC 
                    LIMIT ? OFFSET ?
                `, [...queryParams, limit, offset]);

                notifications = notificationList;
                totalCount = totalRecords;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
        }

        res.render('admin-notifications', {
            notifications: notifications,
            unreadCount: unreadCount,
            totalCount: totalCount,
            currentFilter: filter,
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalRecords: totalRecords,
            username: username,
            error: req.session.error || null,
            success: req.session.success || null,
            moment: require('moment')
        });

        // Clear session messages
        delete req.session.error;
        delete req.session.success;

    } catch (error) {
        console.error('Error loading admin notifications:', error);
        res.status(500).render('error', {
            message: 'Error loading notifications',
            error: { status: 500, message: error.message },
            username: req.session.username || 'Admin'
        });
    }
});

// POST route - Mark notification as read (AJAX)
router.post('/api/admin/notifications/mark-read', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.body;
    const adminId = req.session.userId;

    try {
        const connection = await getConnection();

        // Verify notification belongs to this admin
        const [check] = await connection.execute(
            'SELECT id FROM admin_notifications WHERE id = ? AND admin_id = ?',
            [id, adminId]
        );

        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }

        await connection.execute(
            'UPDATE admin_notifications SET is_read = 1, read_at = NOW() WHERE id = ?',
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Mark all notifications as read (AJAX)
router.post('/api/admin/notifications/mark-all-read', authenticate, requireRole('admin'), async (req, res) => {
    const adminId = req.session.userId;

    try {
        const connection = await getConnection();

        await connection.execute(
            'UPDATE admin_notifications SET is_read = 1, read_at = NOW() WHERE admin_id = ? AND is_read = 0',
            [adminId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete notification (AJAX)
router.post('/api/admin/notifications/delete', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.body;
    const adminId = req.session.userId;

    try {
        const connection = await getConnection();

        // Verify notification belongs to this admin
        const [check] = await connection.execute(
            'SELECT id FROM admin_notifications WHERE id = ? AND admin_id = ?',
            [id, adminId]
        );

        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }

        await connection.execute(
            'DELETE FROM admin_notifications WHERE id = ?',
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete all read notifications (AJAX)
router.post('/api/admin/notifications/delete-all-read', authenticate, requireRole('admin'), async (req, res) => {
    const adminId = req.session.userId;

    try {
        const connection = await getConnection();

        await connection.execute(
            'DELETE FROM admin_notifications WHERE admin_id = ? AND is_read = 1',
            [adminId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error deleting read notifications:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Get unread notification count (AJAX)
router.get('/api/admin/notifications/unread-count', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;

        const [result] = await connection.execute(
            'SELECT COUNT(*) as count FROM admin_notifications WHERE admin_id = ? AND is_read = 0',
            [adminId]
        );

        res.json({ success: true, count: result[0]?.count || 0 });

    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.json({ success: false, count: 0 });
    }
});



// ==================== PAYMENT SETTINGS & APPROVAL ROUTES ====================

// GET: Admin Payment Settings
router.get('/admin/payment-settings', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        // Fetch school info
        const [schools] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        const school = schools.length > 0 ? schools[0] : { name: 'School', bank_name: '', account_name: '', account_number: '', payment_instructions: '' };

        // Fetch payment accounts
        const [accounts] = await connection.execute(
            'SELECT * FROM payment_accounts WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL) ORDER BY is_active DESC, id DESC',
            [schoolId, schoolId]
        );

        const activeAccount = accounts.find(a => a.is_active) || {
            bank_name: school.bank_name || '',
            account_name: school.account_name || '',
            account_number: school.account_number || '',
            instructions: school.payment_instructions || ''
        };

        const success = req.query.success === '1' ? 'School payment details have been saved successfully!' : null;
        const error = req.query.error ? decodeURIComponent(req.query.error) : null;

        res.render('admin-payment-settings', {
            school,
            activeAccount,
            accounts,
            success,
            error,
            moment
        });
    } catch (error) {
        console.error('Error loading payment settings:', error);
        res.status(500).render('error', { message: 'Failed to load payment settings', error });
    }
});

// POST: Save Admin Payment Settings
router.post('/admin/payment-settings', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const { bank_name, account_name, account_number, instructions } = req.body;

        if (!bank_name || !account_name || !account_number) {
            return res.redirect('/admin/payment-settings?error=' + encodeURIComponent('Please provide Bank Name, Account Name, and Account Number.'));
        }

        const trimmedBank = bank_name.trim();
        const trimmedName = account_name.trim();
        const trimmedNumber = account_number.trim();
        const trimmedInstructions = (instructions || '').trim();

        // Update school_info
        if (schoolId) {
            await connection.execute(`
                UPDATE school_info 
                SET bank_name = ?, account_name = ?, account_number = ?, payment_instructions = ?
                WHERE id = ?
            `, [trimmedBank, trimmedName, trimmedNumber, trimmedInstructions, schoolId]);
        } else {
            await connection.execute(`
                UPDATE school_info 
                SET bank_name = ?, account_name = ?, account_number = ?, payment_instructions = ?
                LIMIT 1
            `, [trimmedBank, trimmedName, trimmedNumber, trimmedInstructions]);
        }

        // Upsert into payment_accounts
        const [existing] = await connection.execute(
            'SELECT id FROM payment_accounts WHERE (school_id = ? OR ? IS NULL) LIMIT 1',
            [schoolId, schoolId]
        );

        if (existing.length > 0) {
            await connection.execute(`
                UPDATE payment_accounts 
                SET bank_name = ?, account_name = ?, account_number = ?, instructions = ?, is_active = 1
                WHERE id = ?
            `, [trimmedBank, trimmedName, trimmedNumber, trimmedInstructions, existing[0].id]);
        } else {
            await connection.execute(`
                INSERT INTO payment_accounts (school_id, bank_name, account_name, account_number, instructions, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
            `, [schoolId, trimmedBank, trimmedName, trimmedNumber, trimmedInstructions]);
        }

        res.redirect('/admin/payment-settings?success=1');
    } catch (error) {
        console.error('Error saving payment settings:', error);
        res.redirect('/admin/payment-settings?error=' + encodeURIComponent('Failed to save settings: ' + error.message));
    }
});

// GET: Admin Pending & Parent Payments Approval
router.get('/admin/pending-payments', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;

        const statusFilter = req.query.status || 'all';
        const academicYearFilter = req.query.academicYear || '';
        const termFilter = req.query.term || '';
        const search = req.query.search ? req.query.search.trim() : '';

        let query = `
            SELECT 
                pp.*,
                s.firstName, s.middleName, s.lastName, s.admission_number,
                c.className,
                p.first_name as parent_first, p.last_name as parent_last, p.phone as parent_phone, p.email as parent_email,
                f.receiptNumber as fee_receipt_number
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            LEFT JOIN parents p ON pp.parent_id = p.id
            LEFT JOIN fees f ON pp.fee_id = f.id
            WHERE (pp.school_id = ? OR ? IS NULL OR pp.school_id IS NULL)
        `;
        const queryParams = [schoolId, schoolId];

        if (statusFilter && statusFilter !== 'all') {
            query += ' AND pp.status = ?';
            queryParams.push(statusFilter);
        }

        if (academicYearFilter) {
            query += ' AND pp.academic_year = ?';
            queryParams.push(academicYearFilter);
        }

        if (termFilter) {
            query += ' AND pp.term = ?';
            queryParams.push(termFilter);
        }

        if (search) {
            query += ` AND (
                s.firstName LIKE ? OR s.lastName LIKE ? OR s.admission_number LIKE ? 
                OR pp.transaction_reference LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?
            )`;
            const sParam = `%${search}%`;
            queryParams.push(sParam, sParam, sParam, sParam, sParam, sParam);
        }

        query += ' ORDER BY CASE WHEN pp.status = "pending" THEN 1 ELSE 2 END, pp.created_at DESC';

        const [payments] = await connection.execute(query, queryParams);

        // Calculate summary counters
        const [stats] = await connection.execute(`
            SELECT 
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pendingCount,
                COUNT(CASE WHEN status = 'approved' THEN 1 END) as approvedCount,
                COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejectedCount,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pendingAmount,
                COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) as approvedAmount
            FROM parent_payments
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
        `, [schoolId, schoolId]);

        // Academic years and terms for filter dropdowns
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
            ORDER BY year_name DESC
        `, [schoolId, schoolId]);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms 
            WHERE (school_id = ? OR ? IS NULL OR school_id IS NULL)
        `, [schoolId, schoolId]);

        let successMessage = null;
        if (req.query.success === 'approved') successMessage = 'Payment approved successfully! Fee record and receipt generated.';
        if (req.query.success === 'rejected') successMessage = 'Payment declined. Parent has been notified with the reason.';

        res.render('admin-pending-payments', {
            payments,
            stats: stats[0] || { pendingCount: 0, approvedCount: 0, rejectedCount: 0, pendingAmount: 0, approvedAmount: 0 },
            academicYears,
            terms,
            filters: {
                status: statusFilter,
                academicYear: academicYearFilter,
                term: termFilter,
                search
            },
            success: successMessage,
            error: req.query.error ? decodeURIComponent(req.query.error) : null,
            moment
        });

    } catch (error) {
        console.error('Error loading pending payments:', error);
        res.status(500).render('error', { message: 'Failed to load payments', error });
    }
});

// POST: Approve Parent Payment
router.post('/admin/pending-payments/:id/approve', authenticate, requireRole('admin'), async (req, res) => {
    const paymentId = req.params.id;
    let connection;
    try {
        connection = await getConnection();
        await connection.beginTransaction();

        const [paymentRows] = await connection.execute(`
            SELECT pp.*, s.firstName, s.middleName, s.lastName, s.admission_number, s.email as studentEmail,
                   s.classId, c.className, c.department
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            LEFT JOIN classes c ON s.classId = c.id
            WHERE pp.id = ? FOR UPDATE
        `, [paymentId]);

        if (paymentRows.length === 0) {
            await connection.rollback();
            return res.redirect('/admin/pending-payments?error=' + encodeURIComponent('Payment submission not found.'));
        }

        const payment = paymentRows[0];
        if (payment.status !== 'pending') {
            await connection.rollback();
            return res.redirect('/admin/pending-payments?error=' + encodeURIComponent(`This payment has already been ${payment.status}.`));
        }

        const studentName = studentDisplayName(payment);
        const amountValue = parseFloat(payment.amount) || 0;

        // 1. Calculate student's total bill from class_bills first, then fees
        let billAmount = 0;
        if (payment.classId) {
            const [classBills] = await connection.execute(`
                SELECT SUM(amount) as total_amount 
                FROM class_bills
                WHERE class_id = ? AND academic_year = ? AND term = ? AND is_active = 1
            `, [payment.classId, payment.academic_year, payment.term]);

            if (classBills.length > 0 && classBills[0].total_amount) {
                billAmount = parseFloat(classBills[0].total_amount) || 0;
            }
        }

        // 2. Check previous fee records for this student, term, and academic year
        const [prevFees] = await connection.execute(`
            SELECT SUM(amountPaid) as totalPaid, MAX(billAmount) as feeBillAmount
            FROM fees
            WHERE studentId = ? AND academicYear = ? AND term = ?
        `, [payment.student_id, payment.academic_year, payment.term]);

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
        const [existingPendingFees] = await connection.execute(`
            SELECT id, billAmount FROM fees 
            WHERE studentId = ? AND academicYear = ? AND term = ?
            ORDER BY id ASC LIMIT 1
        `, [payment.student_id, payment.academic_year, payment.term]);

        let feeId;
        const paymentNotes = payment.notes 
            ? `Approved Portal Payment (Ref: ${payment.transaction_reference || 'N/A'}). Note: ${payment.notes}`
            : `Approved Portal Payment (Ref: ${payment.transaction_reference || 'N/A'})`;

        if (existingPendingFees.length > 0) {
            feeId = existingPendingFees[0].id;
            await connection.execute(`
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
            `, [
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
            const [feeResult] = await connection.execute(`
                INSERT INTO fees (
                    studentId, admission_number, studentName, email,
                    className, department, feeType, paymentType,
                    amount, billAmount, amountPaid, balance,
                    paymentDate, receiptNumber, academicYear, term,
                    notes, status, school_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
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

        // Update parent_payments
        await connection.execute(`
            UPDATE parent_payments 
            SET status = 'approved', approved_by = ?, approved_at = NOW(), fee_id = ?
            WHERE id = ?
        `, [req.session.userId || null, feeId, paymentId]);

        // Send notification to parent
        try {
            await connection.execute(`
                INSERT INTO parent_notifications (
                    parent_id, school_id, title, message, type, reference_id, is_read, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, NOW())
            `, [
                payment.parent_id,
                payment.school_id,
                'Fee Payment Approved',
                `Your payment of ₦${amountValue.toLocaleString()} for ${studentName} (${payment.term}, ${payment.academic_year}) has been approved! Official Receipt: ${receiptNumber}.`,
                'fee_payment',
                feeId
            ]);
        } catch (notifErr) {
            console.warn('Failed to insert parent notification on approve:', notifErr.message);
        }

        await connection.commit();
        res.redirect('/admin/pending-payments?success=approved');
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error approving payment:', error);
        res.redirect('/admin/pending-payments?error=' + encodeURIComponent('Failed to approve payment: ' + error.message));
    }
});

// POST: Reject Parent Payment
router.post('/admin/pending-payments/:id/reject', authenticate, requireRole('admin'), uploadNoFile.none(), async (req, res) => {
    const paymentId = req.params.id;
    try {
        const connection = await getConnection();
        const reason = (req.body.rejection_reason || 'Payment could not be verified. Please check transfer details and resubmit.').trim();

        const [paymentRows] = await connection.execute(`
            SELECT pp.*, s.firstName, s.middleName, s.lastName
            FROM parent_payments pp
            JOIN students s ON pp.student_id = s.id
            WHERE pp.id = ?
        `, [paymentId]);

        if (paymentRows.length === 0) {
            return res.redirect('/admin/pending-payments?error=' + encodeURIComponent('Payment submission not found.'));
        }

        const payment = paymentRows[0];
        const studentName = studentDisplayName(payment);

        await connection.execute(`
            UPDATE parent_payments 
            SET status = 'rejected', rejection_reason = ?, approved_by = ?, approved_at = NOW()
            WHERE id = ?
        `, [reason, req.session.userId || null, paymentId]);

        // Send notification to parent
        try {
            await connection.execute(`
                INSERT INTO parent_notifications (
                    parent_id, school_id, title, message, type, reference_id, is_read, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, NOW())
            `, [
                payment.parent_id,
                payment.school_id,
                'Fee Payment Declined',
                `Your payment of ₦${parseFloat(payment.amount).toLocaleString()} for ${studentName} (${payment.term}, ${payment.academic_year}) was declined. Reason: ${reason}. You may review and submit again.`,
                'fee_payment_rejected',
                paymentId
            ]);
        } catch (notifErr) {
            console.warn('Failed to insert parent notification on reject:', notifErr.message);
        }

        res.redirect('/admin/pending-payments?success=rejected');
    } catch (error) {
        console.error('Error rejecting payment:', error);
        res.redirect('/admin/pending-payments?error=' + encodeURIComponent('Failed to decline payment: ' + error.message));
    }
});

module.exports = router;

