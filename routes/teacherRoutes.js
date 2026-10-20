const express = require('express');
const router = express.Router();
const moment = require('moment');
const { getConnection, releaseConnection } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadNoFile } = require('../middleware/upload');
const { getGrade, getGradeColor, getGradeClass, getGradeRemark, getPosition, getGradePoint } = require('../utils/grading');
const { studentDisplayName, getCurrentTermAndWeek } = require('../utils/helpers');

// Helper to redirect /teacher-profile to current user's profile
router.get('/teacher-profile', authenticate, (req, res) => {
    if (req.session.role === 'teacher' && req.session.userId) {
        return res.redirect('/teacher-profile/' + req.session.userId);
    }
    res.redirect('/');
});

// Teacher Dashboard
router.get('/teacher-dashboard', authenticate, async (req, res) => {
    if (req.session.role !== 'teacher') {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: { status: 403, message: 'You do not have permission to access this page.' }
        });
    }

    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';
        const welcomeMessage = req.session.welcomeMessage || null;
        delete req.session.welcomeMessage;

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

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
            console.error('Error calculating school week for teacher dashboard:', weekErr.message);
        }

        // Get teacher data with counts
        const [teachers] = await connection.execute(`
            SELECT t.*, 
                   COUNT(DISTINCT c.id) as class_count,
                   COUNT(DISTINCT s.id) as student_count
            FROM teachers t
            LEFT JOIN classes c ON c.professorId = t.id AND c.school_id = t.school_id
            LEFT JOIN students s ON s.classId = c.id AND s.school_id = t.school_id
            WHERE t.id = ? AND t.school_id = ?
            GROUP BY t.id
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            return res.redirect('/login');
        }

        const teacherData = teachers[0];

        // Get teacher's classes with student counts
        const [classes] = await connection.execute(`
            SELECT DISTINCT 
                c.id as classId, 
                c.className, 
                c.level,
                c.department,
                c.classCode,
                COUNT(DISTINCT s.id) as studentCount,
                GROUP_CONCAT(DISTINCT sub.name SEPARATOR ', ') as subjectNames
            FROM classes c
            LEFT JOIN students s ON s.classId = c.id AND s.school_id = c.school_id
            LEFT JOIN class_subjects cs ON c.id = cs.class_id
            LEFT JOIN subjects sub ON cs.subject_id = sub.id
            WHERE c.professorId = ? AND c.school_id = ?
            GROUP BY c.id
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

        // Get total students count
        let totalStudents = 0;
        classes.forEach(cls => {
            totalStudents += parseInt(cls.studentCount) || 0;
        });

        // Get total subjects count
        const [subjectResult] = await connection.execute(`
            SELECT COUNT(DISTINCT cs.subject_id) as total
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
        `, [teacherId, schoolId]);
        const totalSubjects = subjectResult[0]?.total || 0;

        // Get scores entered this term
        const [scoresResult] = await connection.execute(`
            SELECT COUNT(*) as total
            FROM student_scores sc
            JOIN students s ON sc.student_id = s.id
            JOIN classes c ON s.classId = c.id
            WHERE c.professorId = ? 
            AND sc.academic_year = ? 
            AND sc.term = ?
            AND c.school_id = ?
        `, [
            teacherId,
            currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2024-2025',
            currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',
            schoolId
        ]);
        const scoresEntered = scoresResult[0]?.total || 0;

        // Get today's schedule
        const today = new Date().toISOString().split('T')[0];
        let todaysSchedule = [];
        let nextClass = null;

        try {
            // Check what columns exist in calendar_events
            const [columns] = await connection.execute(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = DATABASE() 
                AND TABLE_NAME = 'calendar_events'
            `);

            const columnNames = columns.map(col => col.COLUMN_NAME);

            // Build query based on available columns
            let query = `
                SELECT 
                    ce.*,
                    c.className,
                    sub.name as subjectName
                FROM calendar_events ce
            `;

            // Check if class_id exists
            if (columnNames.includes('class_id')) {
                query += ` LEFT JOIN classes c ON ce.class_id = c.id`;
            } else if (columnNames.includes('classId')) {
                query += ` LEFT JOIN classes c ON ce.classId = c.id`;
            } else {
                query += ` LEFT JOIN classes c ON 1=0`;
            }

            // Check if subject_id exists
            if (columnNames.includes('subject_id')) {
                query += ` LEFT JOIN subjects sub ON ce.subject_id = sub.id`;
            } else if (columnNames.includes('subjectId')) {
                query += ` LEFT JOIN subjects sub ON ce.subjectId = sub.id`;
            } else {
                query += ` LEFT JOIN subjects sub ON 1=0`;
            }

            // Build WHERE clause
            query += ` WHERE ce.eventDate = ? AND ce.school_id = ?`;
            let queryParams = [today, schoolId];

            // If class_id exists, filter by teacher's classes
            if (columnNames.includes('class_id') || columnNames.includes('classId')) {
                const classIdColumn = columnNames.includes('class_id') ? 'ce.class_id' : 'ce.classId';
                query += ` AND ${classIdColumn} IN (SELECT id FROM classes WHERE professorId = ? AND school_id = ?)`;
                queryParams.push(teacherId, schoolId);
            } else {
                // Try to match by title containing class name
                const classNames = classes.map(c => c.className);
                if (classNames.length > 0) {
                    const titleConditions = classNames.map(() => 'ce.title LIKE ?').join(' OR ');
                    query += ` AND (${titleConditions})`;
                    classNames.forEach(name => {
                        queryParams.push(`%${name}%`);
                    });
                }
            }

            query += ` ORDER BY ce.startTime LIMIT 5`;

            const [schedule] = await connection.execute(query, queryParams);
            todaysSchedule = schedule;

            if (todaysSchedule.length > 0) {
                nextClass = todaysSchedule[0];
            }

        } catch (err) {
            console.error('Error fetching schedule:', err.message);
            // Fallback: try a simpler query
            try {
                const [schedule] = await connection.execute(`
                    SELECT * FROM calendar_events 
                    WHERE eventDate = ? AND school_id = ?
                    ORDER BY startTime 
                    LIMIT 5
                `, [today, schoolId]);
                todaysSchedule = schedule;
                if (todaysSchedule.length > 0) {
                    nextClass = todaysSchedule[0];
                }
            } catch (fallbackErr) {
                console.error('Fallback schedule query also failed:', fallbackErr.message);
                todaysSchedule = [];
                nextClass = null;
            }
        }

        // Get attendance statistics for today
        let todayAttendance = 0;
        try {
            const [attendanceStats] = await connection.execute(`
                SELECT 
                    COUNT(DISTINCT student_id) as total_present
                FROM attendance_records
                WHERE date = ? 
                AND class_id IN (
                    SELECT id FROM classes WHERE professorId = ? AND school_id = ?
                )
                AND (morning_status = 'present' OR afternoon_status = 'present')
            `, [today, teacherId, schoolId]);
            todayAttendance = attendanceStats[0]?.total_present || 0;
        } catch (err) {
            console.error('Error fetching attendance stats:', err.message);
            todayAttendance = 0;
        }

        // Get unread notifications count
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
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

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;

                const [notificationList] = await connection.execute(`
                    SELECT id, title, message, is_read, type, created_at,
                           DATE_FORMAT(created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                    FROM teacher_notifications 
                    WHERE teacher_id = ? 
                    ORDER BY created_at DESC 
                    LIMIT 10
                `, [teacherId]);
                notifications = notificationList;
            }
        } catch (err) {
            console.error('Error fetching notifications:', err.message);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get recent activities
        let recentActivities = [];
        try {
            const [activities] = await connection.execute(`
                SELECT 
                    'Scores entered' as activity_type,
                    COUNT(*) as count,
                    MAX(sc.created_at) as activity_date
                FROM student_scores sc
                JOIN students s ON sc.student_id = s.id
                JOIN classes c ON s.classId = c.id
                WHERE c.professorId = ? AND c.school_id = ?
                AND sc.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY DATE(sc.created_at)
                ORDER BY activity_date DESC
                LIMIT 5
            `, [teacherId, schoolId]);
            recentActivities = activities;
        } catch (err) {
            console.error('Error fetching recent activities:', err.message);
            recentActivities = [];
        }

        // Get upcoming deadlines - Cleaned up version
        let upcomingDeadlines = [];
        try {
            // Check if assignments table exists
            const [tableCheck] = await connection.execute(`
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = 'assignments'
    `);

            if (tableCheck[0].count > 0) {
                // Assignments table exists - get deadlines
                const [deadlines] = await connection.execute(`
            SELECT 
                'Assignment' as type,
                title,
                due_date as deadline
            FROM assignments
            WHERE teacher_id = ? AND due_date >= CURDATE()
            ORDER BY due_date ASC
            LIMIT 3
        `, [teacherId]);
                upcomingDeadlines = deadlines;
            } else {
                // Assignments table doesn't exist - try other sources
                // Try to get from class_bills
                try {
                    const [bills] = await connection.execute(`
                SELECT 
                    'Fee Deadline' as type,
                    CONCAT(fee_type, ' - ', class_name) as title,
                    due_date as deadline
                FROM class_bills
                WHERE due_date >= CURDATE() 
                AND due_date IS NOT NULL
                AND school_id = ?
                ORDER BY due_date ASC
                LIMIT 3
            `, [schoolId]);

                    if (bills.length > 0) {
                        upcomingDeadlines = bills;
                    }
                } catch (billErr) {
                    // Class_bills table might not have due_date column or doesn't exist
                    console.log('No deadlines found from class_bills');
                }

                // If still no deadlines, try academic terms
                if (upcomingDeadlines.length === 0) {
                    try {
                        const [terms] = await connection.execute(`
                    SELECT 
                        'Term End' as type,
                        CONCAT(term_name, ' ends') as title,
                        end_date as deadline
                    FROM academic_terms
                    WHERE end_date >= CURDATE() 
                    AND end_date IS NOT NULL
                    AND school_id = ?
                    ORDER BY end_date ASC
                    LIMIT 3
                `, [schoolId]);

                        if (terms.length > 0) {
                            upcomingDeadlines = terms;
                        }
                    } catch (termErr) {
                        console.log('No deadlines found from academic_terms');
                    }
                }

                // If still no deadlines, show a friendly message
                if (upcomingDeadlines.length === 0) {
                    upcomingDeadlines = [
                        {
                            type: 'Info',
                            title: 'No upcoming deadlines',
                            deadline: null
                        }
                    ];
                }
            }
        } catch (err) {
            console.error('Error fetching deadlines:', err.message);
            // Show a friendly message instead of error
            upcomingDeadlines = [
                {
                    type: 'Info',
                    title: 'Deadlines feature coming soon',
                    deadline: null
                }
            ];
        }
        // Render the dashboard with all data
        res.render('teacher-dashboard', {
            // Teacher data
            teacherData: teacherData,
            teacherName: `${teacherData.firstName} ${teacherData.lastName}`,
            teacherEmail: teacherData.email,
            teacherDesignation: teacherData.designation || 'Teacher',

            // Statistics
            totalStudents: totalStudents,
            totalSubjects: totalSubjects,
            scoresEntered: scoresEntered,
            classesCount: classes.length,
            todayAttendance: todayAttendance,

            // Academic data
            currentAcademicYear: currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2024-2025',
            currentTerm: currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term',

            // Schedule data
            todaysSchedule: todaysSchedule,
            nextClass: nextClass,

            // Notifications
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,

            // Activities
            recentActivities: recentActivities,

            // Deadlines
            upcomingDeadlines: upcomingDeadlines,

            // Helper
            moment: require('moment'),
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

            // Page info
            title: 'Teacher Dashboard',
            currentPage: 'teacher-dashboard',
            role: req.session.role,
            username: username,
            userId: req.session.userId
        });

    } catch (error) {
        console.error('Error loading teacher dashboard:', error);

        // Render error page with default values
        res.render('teacher-dashboard', {
            error: 'Failed to load dashboard data. Please try again later.',
            teacherData: {
                firstName: 'Teacher',
                lastName: '',
                email: '',
                designation: 'Teacher'
            },
            teacherName: 'Teacher',
            teacherEmail: '',
            teacherDesignation: 'Teacher',
            totalStudents: 0,
            totalSubjects: 0,
            scoresEntered: 0,
            classesCount: 0,
            todayAttendance: 0,
            currentAcademicYear: '2024-2025',
            currentTerm: 'First Term',
            todaysSchedule: [],
            nextClass: null,
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            schoolWeek: {
                academicYear: '2026/2027',
                currentTerm: 'First Term',
                termName: 'First Term',
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
            weekStartDate: '',
            weekEndDate: '',
            termStartDate: null,
            termEndDate: null,
            termProgress: 0,
            daysRemaining: 0,
            daysPassed: 0,
            totalDays: 0,
            welcomeMessage: null,
            recentActivities: [],
            upcomingDeadlines: [],
            moment: require('moment'),
            title: 'Teacher Dashboard',
            currentPage: 'teacher-dashboard',
            role: req.session.role,
            username: req.session.username || 'Teacher',
            userId: req.session.userId
        });
    }
});


// ==================== TEACHER MY CLASSES ROUTES ====================

// GET route - Teacher My Classes View
// GET route - Teacher My Classes View (with error handling for missing tables)
router.get('/teacher/my-classes', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

        try {
            // Check if table exists first
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

                // Get total count for notification badge
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
            console.error('Error fetching notifications (table may not exist):', err.message);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all classes assigned to this teacher
        const [classes] = await connection.execute(`
            SELECT 
                c.id,
                c.className,
                c.classCode,
                c.level,
                c.department,
                c.maximumStudents,
                c.professorName,
                COUNT(DISTINCT s.id) as enrolled_students,
                COUNT(DISTINCT sub.id) as subject_count,
                COUNT(DISTINCT CASE WHEN sc.id IS NOT NULL THEN sc.id END) as scores_entered
            FROM classes c
            LEFT JOIN students s ON s.classId = c.id AND s.school_id = c.school_id
            LEFT JOIN class_subjects cs ON cs.class_id = c.id
            LEFT JOIN subjects sub ON cs.subject_id = sub.id
            LEFT JOIN student_scores sc ON sc.subject_id = sub.id AND sc.student_id = s.id
            WHERE c.professorId = ? AND c.school_id = ?
            GROUP BY c.id
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

        // Get subjects taught by teacher for each class
        const [subjectsByClass] = await connection.execute(`
            SELECT 
                cs.class_id,
                s.id as subject_id,
                s.name as subject_name,
                s.subject_code,
                COUNT(DISTINCT ss.student_id) as students_count,
                COUNT(DISTINCT sc.id) as scores_count
            FROM class_subjects cs
            JOIN subjects s ON cs.subject_id = s.id
            LEFT JOIN student_subjects ss ON ss.subject_id = s.id
            LEFT JOIN student_scores sc ON sc.subject_id = s.id
            WHERE cs.class_id IN (
                SELECT id FROM classes WHERE professorId = ? AND school_id = ?
            )
            GROUP BY cs.class_id, s.id
            ORDER BY s.name
        `, [teacherId, schoolId]);

        // Organize subjects by class
        const subjectsMap = {};
        for (var i = 0; i < subjectsByClass.length; i++) {
            var item = subjectsByClass[i];
            if (!subjectsMap[item.class_id]) {
                subjectsMap[item.class_id] = [];
            }
            subjectsMap[item.class_id].push({
                id: item.subject_id,
                name: item.subject_name,
                code: item.subject_code,
                studentsCount: item.students_count,
                scoresCount: item.scores_count
            });
        }

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        const academicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024';
        const term = currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term';

        // Calculate total students and scores for progress
        let totalStudents = 0;
        let totalSubjectsCount = 0;
        let totalScoresEntered = 0;

        for (var i = 0; i < classes.length; i++) {
            var cls = classes[i];
            totalStudents += cls.enrolled_students || 0;
            totalSubjectsCount += cls.subject_count || 0;
            totalScoresEntered += cls.scores_entered || 0;
        }

        var expectedTotalScores = totalStudents * totalSubjectsCount;
        var overallProgress = expectedTotalScores > 0 ? Math.round((totalScoresEntered / expectedTotalScores) * 100) : 0;

        res.render('teacher-my-classes', {
            teacher: teacher,
            teacherName: teacherName,
            classes: classes,
            subjectsMap: subjectsMap,
            academicYear: academicYear,
            term: term,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            overallProgress: overallProgress,
            totalStudents: totalStudents,
            totalScoresEntered: totalScoresEntered,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'My Classes',
            currentPage: 'teacher-my-classes'
        });

        // Clear session messages
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading teacher classes:', error);
        res.render('teacher-my-classes', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            classes: [],
            subjectsMap: {},
            academicYear: '2023-2024',
            term: 'First Term',
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            overallProgress: 0,
            totalStudents: 0,
            totalScoresEntered: 0,
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load classes: ' + error.message,
            title: 'My Classes',
            currentPage: 'teacher-my-classes'
        });
    }
});

// GET route - View class details (students, subjects, etc.)
router.get('/teacher/class/:id', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const classId = req.params.id;
        const schoolId = req.session.schoolId || null;

        // Verify this class belongs to the teacher
        const [classCheck] = await connection.execute(`
            SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
        `, [classId, teacherId, schoolId]);

        if (classCheck.length === 0) {
            req.session.error = 'You do not have permission to view this class';
            return res.redirect('/teacher/my-classes');
        }

        // Get class information
        const [classes] = await connection.execute(`
            SELECT c.*, 
                   COUNT(DISTINCT s.id) as student_count,
                   COUNT(DISTINCT sub.id) as subject_count
            FROM classes c
            LEFT JOIN students s ON s.classId = c.id
            LEFT JOIN class_subjects cs ON cs.class_id = c.id
            LEFT JOIN subjects sub ON cs.subject_id = sub.id
            WHERE c.id = ?
            GROUP BY c.id
        `, [classId]);

        const classData = classes[0];

        // Get students in this class
        const [students] = await connection.execute(`
            SELECT s.*, 
                   COUNT(DISTINCT sc.subject_id) as scores_count
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id
            WHERE s.classId = ?
            GROUP BY s.id
            ORDER BY s.firstName, s.lastName
        `, [classId]);

        // Get subjects taught in this class
        const [subjects] = await connection.execute(`
            SELECT s.id, s.name, s.subject_code,
                   COUNT(DISTINCT sc.id) as scores_count
            FROM subjects s
            JOIN class_subjects cs ON cs.subject_id = s.id
            LEFT JOIN student_scores sc ON sc.subject_id = s.id
            WHERE cs.class_id = ?
            GROUP BY s.id
            ORDER BY s.name
        `, [classId]);

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        const academicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024';
        const term = currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term';

        // Get unread notifications count
        let unreadCount = 0;
        try {
            const [notifications] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM teacher_notifications 
                WHERE teacher_id = ? AND is_read = 0
            `, [teacherId]);
            unreadCount = notifications[0]?.count || 0;
        } catch (err) {
            unreadCount = 0;
        }

        res.render('teacher-class-detail', {
            classData: classData,
            students: students,
            subjects: subjects,
            academicYear: academicYear,
            term: term,
            unreadCount: unreadCount,
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading class details:', error);
        req.session.error = 'Failed to load class details';
        res.redirect('/teacher/my-classes');
    }
});

// GET route - Enter scores for a specific class and subject
router.get('/teacher/enter-scores/:classId/:subjectId', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const classId = req.params.classId;
        const subjectId = req.params.subjectId;
        const schoolId = req.session.schoolId || null;

        // Verify teacher has access to this class and subject
        const [accessCheck] = await connection.execute(`
            SELECT cs.id FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            WHERE c.id = ? AND c.professorId = ? AND cs.subject_id = ? AND c.school_id = ?
        `, [classId, teacherId, subjectId, schoolId]);

        if (accessCheck.length === 0) {
            req.session.error = 'You do not have permission to enter scores for this class/subject';
            return res.redirect('/teacher/my-classes');
        }

        // Get class information
        const [classes] = await connection.execute(`
            SELECT * FROM classes WHERE id = ?
        `, [classId]);

        // Get subject information
        const [subjects] = await connection.execute(`
            SELECT * FROM subjects WHERE id = ?
        `, [subjectId]);

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);
        
        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        const academicYear = req.query.academicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024');
        const term = req.query.term || (currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term');

        // Get students in this class with their scores (if any) for this specific class
        const [students] = await connection.execute(`
            SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number,
                   sc.id as score_id, sc.test_score, sc.exam_score, sc.term, sc.academic_year
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.subject_id = ? 
                AND sc.term = ? 
                AND sc.academic_year = ? 
                AND sc.class_id = ?
            WHERE s.classId = ?
            ORDER BY s.firstName, s.lastName
        `, [subjectId, term, academicYear, classId, classId]);

        // Get available academic years and terms for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years ORDER BY year_name DESC
        `);
        
        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `);

        res.render('teacher-enter-scores', {
            classData: classes[0],
            subjectData: subjects[0],
            students: students,
            academicYear: academicYear,
            term: term,
            academicYears: academicYears,
            terms: terms,
            moment: require('moment'),
            error: null,
            success: req.session.success || null
        });

    } catch (error) {
        console.error('Error loading score entry page:', error);
        req.session.error = 'Failed to load score entry page';
        res.redirect('/teacher/my-classes');
    }
});

// POST route - Save scores for a class and subject
router.post('/teacher/save-scores', authenticate, requireRole('teacher'), uploadNoFile.none(), async (req, res) => {
    const { classId, subjectId, academicYear, term, scores } = req.body;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access
        const [accessCheck] = await connection.execute(`
            SELECT cs.id FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            WHERE c.id = ? AND c.professorId = ? AND cs.subject_id = ? AND c.school_id = ?
        `, [classId, teacherId, subjectId, schoolId]);

        if (accessCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // Parse scores - scores is a JSON string from the form
        let scoresArray = [];
        if (typeof scores === 'string') {
            try {
                scoresArray = JSON.parse(scores);
            } catch (e) {
                scoresArray = [];
            }
        } else if (Array.isArray(scores)) {
            scoresArray = scores;
        }

        await connection.beginTransaction();

        for (var i = 0; i < scoresArray.length; i++) {
            var score = scoresArray[i];
            var studentId = score.studentId;
            var testScore = parseFloat(score.testScore) || 0;
            var examScore = parseFloat(score.examScore) || 0;

            // Validate score ranges
            if (testScore < 0 || testScore > 40) {
                throw new Error(`Test score for student must be between 0 and 40`);
            }
            if (examScore < 0 || examScore > 60) {
                throw new Error(`Exam score for student must be between 0 and 60`);
            }

            // Check if score record exists for this class
            const [existing] = await connection.execute(`
                SELECT id FROM student_scores 
                WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?
            `, [studentId, subjectId, term, academicYear, classId]);

            if (existing.length > 0) {
                // Update existing
                await connection.execute(`
                    UPDATE student_scores 
                    SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW()
                    WHERE id = ?
                `, [testScore, examScore, schoolId, existing[0].id]);
            } else {
                // Insert new with class_id and school_id
                await connection.execute(`
                    INSERT INTO student_scores 
                    (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                `, [studentId, subjectId, term, academicYear, classId, schoolId, testScore, examScore]);
            }
        }

        await connection.commit();

        req.session.success = 'Scores saved successfully!';
        res.json({ success: true, message: 'Scores saved successfully' });

    } catch (error) {
        console.error('Error saving scores:', error);
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Teacher My Subjects View (with error handling for missing tables)
// GET route - Teacher My Subjects View (with error handling for missing tables)
router.get('/teacher/my-subjects', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

        try {
            // Check if table exists first
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

                // Get total count for notification badge
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
            console.error('Error fetching notifications (table may not exist):', err.message);
            unreadCount = 0;
            totalCount = 0;
            notifications = [];
        }

        // Get all subjects taught by this teacher through their classes
        const [subjects] = await connection.execute(`
            SELECT DISTINCT 
                s.id,
                s.name as subject_name,
                s.subject_code,
                s.description,
                GROUP_CONCAT(DISTINCT c.className ORDER BY c.className SEPARATOR ', ') as classes,
                GROUP_CONCAT(DISTINCT c.id ORDER BY c.className SEPARATOR ',') as class_ids,
                COUNT(DISTINCT c.id) as class_count,
                COUNT(DISTINCT st.id) as total_students,
                COUNT(DISTINCT sc.id) as scores_entered
            FROM subjects s
            JOIN class_subjects cs ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            LEFT JOIN students st ON st.classId = c.id AND st.school_id = c.school_id
            LEFT JOIN student_scores sc ON sc.subject_id = s.id AND sc.student_id = st.id
            WHERE c.professorId = ? AND c.school_id = ?
            GROUP BY s.id
            ORDER BY s.name
        `, [teacherId, schoolId]);

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1
        `);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1
        `);

        const academicYear = currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024';
        const term = currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term';

        // Calculate overall progress
        let totalStudents = 0;
        let totalExpectedScores = 0;
        let totalEnteredScores = 0;

        for (var i = 0; i < subjects.length; i++) {
            var subj = subjects[i];
            totalStudents += subj.total_students || 0;
            totalExpectedScores += (subj.total_students || 0);
            totalEnteredScores += (subj.scores_entered || 0);
        }

        var overallProgress = totalExpectedScores > 0 ? Math.round((totalEnteredScores / totalExpectedScores) * 100) : 0;

        res.render('teacher-my-subjects', {
            teacher: teacher,
            teacherName: teacherName,
            subjects: subjects,
            academicYear: academicYear,
            term: term,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            overallProgress: overallProgress,
            totalSubjects: subjects.length,
            totalClasses: [...new Set(subjects.map(function (s) { return s.class_ids ? s.class_ids.split(',') : []; }).flat())].length,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'My Subjects',
            currentPage: 'teacher-my-subjects'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading teacher subjects:', error);
        res.render('teacher-my-subjects', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            subjects: [],
            academicYear: '2023-2024',
            term: 'First Term',
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            overallProgress: 0,
            totalSubjects: 0,
            totalClasses: 0,
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load subjects: ' + error.message,
            title: 'My Subjects',
            currentPage: 'teacher-my-subjects'
        });
    }
});

// ==================== TEACHER CLASS SCHEDULE ROUTES ====================

// Helper function to get day name from number
function getDayName(dayNumber) {
    const days = {
        1: 'Monday',
        2: 'Tuesday',
        3: 'Wednesday',
        4: 'Thursday',
        5: 'Friday',
        6: 'Saturday',
        7: 'Sunday'
    };
    return days[dayNumber] || 'Monday';
}

// GET route - Teacher Class Schedule View
// GET route - Teacher Class Schedule View
router.get('/teacher/class-schedule', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get current date and week days
        const today = new Date();
        const currentWeekStart = new Date(today);
        const currentDayOfWeek = today.getDay();
        // Adjust to Monday (0 = Sunday, 1 = Monday, etc.)
        const daysToMonday = currentDayOfWeek === 0 ? 6 : currentDayOfWeek - 1;
        currentWeekStart.setDate(today.getDate() - daysToMonday);
        currentWeekStart.setHours(0, 0, 0, 0);

        const currentWeekEnd = new Date(currentWeekStart);
        currentWeekEnd.setDate(currentWeekStart.getDate() + 4); // Friday

        const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

        // Get week parameter from query
        const weekOffset = parseInt(req.query.week) || 0;

        let startDate = new Date(currentWeekStart);
        startDate.setDate(startDate.getDate() + (weekOffset * 7));
        let endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 4);

        const weekStartFormatted = startDate.toISOString().split('T')[0];
        const weekEndFormatted = endDate.toISOString().split('T')[0];

        // Get all classes assigned to this teacher
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department, c.classCode
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        const classIds = teacherClasses.map(function (cls) { return cls.id; });

        // Get schedule/calendar events for teacher's classes
        let scheduleEvents = [];
        let timetableEntries = [];

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

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

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
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

        if (classIds.length > 0) {
            // Get calendar events for teacher's classes
            try {
                const [events] = await connection.execute(`
                    SELECT 
                        ce.*,
                        DATE_FORMAT(ce.eventDate, '%Y-%m-%d') as event_date,
                        DAYNAME(ce.eventDate) as day_name,
                        WEEK(ce.eventDate) as week_number
                    FROM calendar_events ce
                    WHERE (ce.title LIKE ? OR ce.description LIKE ?)
                        AND ce.eventDate BETWEEN ? AND ?
                    ORDER BY ce.eventDate, ce.startTime
                `, [`%${teacher.className || teacherName}%`, `%${teacher.className || teacherName}%`, weekStartFormatted, weekEndFormatted]);
                scheduleEvents = events;
            } catch (err) {
                console.log('Calendar events error:', err.message);
                scheduleEvents = [];
            }

            // Check if teacher_timetable table exists
            try {
                const [tableCheck] = await connection.execute(`
                    SELECT COUNT(*) as count FROM information_schema.tables 
                    WHERE table_schema = DATABASE() AND table_name = 'teacher_timetable'
                `);

                if (tableCheck[0].count > 0) {
                    const [timetable] = await connection.execute(`
                        SELECT 
                            tt.*, 
                            c.className, 
                            s.name as subject_name
                        FROM teacher_timetable tt
                        JOIN classes c ON tt.class_id = c.id
                        JOIN subjects s ON tt.subject_id = s.id
                        WHERE tt.teacher_id = ? 
                            AND (tt.week_start IS NULL OR tt.week_start <= ?)
                            AND (tt.week_end IS NULL OR tt.week_end >= ?)
                            AND tt.school_id = ?
                        ORDER BY tt.day_of_week, tt.start_time
                    `, [teacherId, weekStartFormatted, weekStartFormatted, schoolId]);
                    timetableEntries = timetable;
                } else {
                    console.log('Timetable table not found, using calendar events only');
                    timetableEntries = [];
                }
            } catch (err) {
                console.log('Error checking timetable table:', err.message);
                timetableEntries = [];
            }
        }

        // Organize schedule by day
        const scheduleByDay = {
            'Monday': [],
            'Tuesday': [],
            'Wednesday': [],
            'Thursday': [],
            'Friday': []
        };

        // Add calendar events to schedule
        for (var i = 0; i < scheduleEvents.length; i++) {
            var event = scheduleEvents[i];
            var dayName = event.day_name;
            if (scheduleByDay[dayName]) {
                scheduleByDay[dayName].push({
                    id: event.id,
                    title: event.title,
                    description: event.description,
                    startTime: event.startTime,
                    endTime: event.endTime,
                    type: 'event',
                    className: 'School Event',
                    subject: null,
                    room: null
                });
            }
        }

        // Add timetable entries to schedule
        for (var i = 0; i < timetableEntries.length; i++) {
            var entry = timetableEntries[i];
            var dayName = getDayName(entry.day_of_week);
            if (scheduleByDay[dayName]) {
                scheduleByDay[dayName].push({
                    id: entry.id,
                    title: `${entry.subject_name} - ${entry.className}`,
                    description: entry.notes || '',
                    startTime: entry.start_time,
                    endTime: entry.end_time,
                    type: 'class',
                    className: entry.className,
                    subject: entry.subject_name,
                    room: entry.room
                });
            }
        }

        // Sort each day's schedule by start time
        for (var day in scheduleByDay) {
            scheduleByDay[day].sort(function (a, b) {
                var timeA = a.startTime || '00:00:00';
                var timeB = b.startTime || '00:00:00';
                return timeA.localeCompare(timeB);
            });
        }

        // Format dates for display
        const weekStartDisplay = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const weekEndDisplay = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        res.render('teacher-class-schedule', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            scheduleByDay: scheduleByDay,
            weekDays: weekDays,
            weekStart: startDate,
            weekEnd: endDate,
            weekStartDisplay: weekStartDisplay,
            weekEndDisplay: weekEndDisplay,
            weekOffset: weekOffset,
            currentWeekStart: currentWeekStart,
            currentWeekEnd: currentWeekEnd,
            upcomingSchedule: scheduleEvents.slice(0, 5),
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Class Schedule',
            currentPage: 'teacher-class-schedule'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading teacher schedule:', error);
        res.render('teacher-class-schedule', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            scheduleByDay: {
                'Monday': [],
                'Tuesday': [],
                'Wednesday': [],
                'Thursday': [],
                'Friday': []
            },
            weekDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            weekStart: new Date(),
            weekEnd: new Date(),
            weekStartDisplay: '',
            weekEndDisplay: '',
            weekOffset: 0,
            currentWeekStart: new Date(),
            currentWeekEnd: new Date(),
            upcomingSchedule: [],
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load schedule: ' + error.message,
            title: 'Class Schedule',
            currentPage: 'teacher-class-schedule'
        });
    }
});

// Helper function to get day name from number
function getDayName(dayNumber) {
    const days = {
        1: 'Monday',
        2: 'Tuesday',
        3: 'Wednesday',
        4: 'Thursday',
        5: 'Friday',
        6: 'Saturday',
        7: 'Sunday'
    };
    return days[dayNumber] || 'Monday';
}
// GET route - Teacher Weekly Timetable (Alternative View)
router.get('/teacher/weekly-timetable', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);
        
        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }
        
        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;
        
        // Get classes taught by teacher
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);
        
        // Get subjects taught by teacher
        const [subjects] = await connection.execute(`
            SELECT DISTINCT s.id, s.name, s.subject_code
            FROM subjects s
            JOIN class_subjects cs ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY s.name
        `, [teacherId, schoolId]);
        
        // Check if teacher_timetable exists and get entries
        let timetableEntries = [];
        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'teacher_timetable'
            `);
            
            if (tableCheck[0].count > 0) {
                const [entries] = await connection.execute(`
                    SELECT tt.*, c.className, s.name as subject_name
                    FROM teacher_timetable tt
                    JOIN classes c ON tt.class_id = c.id
                    JOIN subjects s ON tt.subject_id = s.id
                    WHERE tt.teacher_id = ? AND tt.school_id = ?
                    ORDER BY tt.day_of_week, tt.start_time
                `, [teacherId, schoolId]);
                timetableEntries = entries;
            }
        } catch (err) {
            console.log('Timetable table not found:', err.message);
        }
        
        // Group timetable by day
        const timetableByDay = {
            1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: []
        };
        
        for (var i = 0; i < timetableEntries.length; i++) {
            var entry = timetableEntries[i];
            if (timetableByDay[entry.day_of_week]) {
                timetableByDay[entry.day_of_week].push(entry);
            }
        }
        
        const days = {
            1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 
            5: 'Friday', 6: 'Saturday', 7: 'Sunday'
        };
        
        // Get unread notifications
        let unreadCount = 0;
        let notifications = [];
        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
            `);
            
            if (tableCheck[0].count > 0) {
                const [notificationCount] = await connection.execute(`
                    SELECT COUNT(*) as count 
                    FROM teacher_notifications 
                    WHERE teacher_id = ? AND is_read = 0
                `, [teacherId]);
                unreadCount = notificationCount[0]?.count || 0;
                
                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
                    WHERE teacher_id = ? 
                    ORDER BY created_at DESC 
                    LIMIT 5
                `, [teacherId]);
                notifications = notificationList;
            }
        } catch (err) {
            unreadCount = 0;
            notifications = [];
        }
        
        res.render('teacher-weekly-timetable', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            subjects: subjects,
            timetableByDay: timetableByDay,
            days: days,
            unreadCount: unreadCount,
            notifications: notifications,
            moment: require('moment'),
            error: null
        });
        
    } catch (error) {
        console.error('Error loading weekly timetable:', error);
        res.render('teacher-weekly-timetable', {
            teacher: { firstName: 'Teacher', lastName: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            subjects: [],
            timetableByDay: {},
            days: {1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',5:'Friday',6:'Saturday',7:'Sunday'},
            unreadCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load timetable: ' + error.message
        });
    }
});

// GET route - Teacher API endpoint to get schedule as JSON
router.get('/api/teacher/schedule', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const weekOffset = parseInt(req.query.week) || 0;
        
        // Calculate week dates
        const today = new Date();
        const currentWeekStart = new Date(today);
        const daysToMonday = today.getDay() === 0 ? 6 : today.getDay() - 1;
        currentWeekStart.setDate(today.getDate() - daysToMonday);
        
        let startDate = new Date(currentWeekStart);
        startDate.setDate(startDate.getDate() + (weekOffset * 7));
        let endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        
        const weekStartFormatted = startDate.toISOString().split('T')[0];
        const weekEndFormatted = endDate.toISOString().split('T')[0];
        
        // Get teacher's classes
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
        `, [teacherId, schoolId]);
        
        // Get timetable entries
        let timetableEntries = [];
        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'teacher_timetable'
            `);
            
            if (tableCheck[0].count > 0) {
                const [entries] = await connection.execute(`
                    SELECT 
                        tt.day_of_week,
                        tt.start_time,
                        tt.end_time,
                        c.className,
                        s.name as subject_name,
                        tt.room
                    FROM teacher_timetable tt
                    JOIN classes c ON tt.class_id = c.id
                    JOIN subjects s ON tt.subject_id = s.id
                    WHERE tt.teacher_id = ? 
                        AND (tt.week_start IS NULL OR tt.week_start <= ?)
                        AND (tt.week_end IS NULL OR tt.week_end >= ?)
                        AND tt.school_id = ?
                    ORDER BY tt.day_of_week, tt.start_time
                `, [teacherId, weekStartFormatted, weekStartFormatted, schoolId]);
                timetableEntries = entries;
            }
        } catch (err) {
            timetableEntries = [];
        }
        
        res.json({
            success: true,
            weekStart: weekStartFormatted,
            weekEnd: weekEndFormatted,
            schedule: timetableEntries
        });
        
    } catch (error) {
        console.error('Error fetching schedule API:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==================== TIMETABLE MANAGEMENT ROUTES ====================

// GET route - Manage Timetable (for admin/teacher)
router.get('/teacher/manage-timetable', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get teacher's classes
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        // Get teacher's subjects
        const [teacherSubjects] = await connection.execute(`
            SELECT DISTINCT s.id, s.name, s.subject_code
            FROM subjects s
            JOIN class_subjects cs ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY s.name
        `, [teacherId, schoolId]);

        // Get existing timetable entries
        const [timetableEntries] = await connection.execute(`
            SELECT tt.*, c.className, s.name as subject_name
            FROM teacher_timetable tt
            JOIN classes c ON tt.class_id = c.id
            JOIN subjects s ON tt.subject_id = s.id
            WHERE tt.teacher_id = ? AND tt.school_id = ?
            ORDER BY tt.day_of_week, tt.start_time
        `, [teacherId, schoolId]);

        // Group by day
        const timetableByDay = {
            1: [], // Monday
            2: [], // Tuesday
            3: [], // Wednesday
            4: [], // Thursday
            5: [], // Friday
            6: [], // Saturday
            7: []  // Sunday
        };
        
        for (var i = 0; i < timetableEntries.length; i++) {
            var entry = timetableEntries[i];
            if (timetableByDay[entry.day_of_week]) {
                timetableByDay[entry.day_of_week].push(entry);
            }
        }

        const days = {
            1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 
            5: 'Friday', 6: 'Saturday', 7: 'Sunday'
        };

        // Get unread notifications
        let unreadCount = 0;
        let notifications = [];
        try {
            const [tableCheck] = await connection.execute(`
                SELECT COUNT(*) as count FROM information_schema.tables 
                WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
            `);
            
            if (tableCheck[0].count > 0) {
                const [notificationCount] = await connection.execute(`
                    SELECT COUNT(*) as count 
                    FROM teacher_notifications 
                    WHERE teacher_id = ? AND is_read = 0
                `, [teacherId]);
                unreadCount = notificationCount[0]?.count || 0;
                
                const [notificationList] = await connection.execute(`
                    SELECT * FROM teacher_notifications 
                    WHERE teacher_id = ? 
                    ORDER BY created_at DESC 
                    LIMIT 5
                `, [teacherId]);
                notifications = notificationList;
            }
        } catch (err) {
            unreadCount = 0;
            notifications = [];
        }

        res.render('teacher-manage-timetable', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            teacherSubjects: teacherSubjects,
            timetableByDay: timetableByDay,
            days: days,
            unreadCount: unreadCount,
            notifications: notifications,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null
        });
        
        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading timetable management:', error);
        res.render('teacher-manage-timetable', {
            teacher: { firstName: 'Teacher', lastName: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            teacherSubjects: [],
            timetableByDay: {},
            days: {1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',5:'Friday',6:'Saturday',7:'Sunday'},
            unreadCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load timetable: ' + error.message
        });
    }
});

// POST route - Add/Update timetable entry
router.post('/teacher/timetable/add', authenticate, requireRole('teacher'), uploadNoFile.none(), async (req, res) => {
    const { timetableId, classId, subjectId, dayOfWeek, startTime, endTime, room, notes, weekStart, weekEnd, isRecurring } = req.body;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Validate required fields
        if (!classId || !subjectId || !dayOfWeek || !startTime || !endTime) {
            req.session.error = 'Please fill in all required fields';
            return res.redirect('/teacher/manage-timetable');
        }

        // Verify teacher teaches this class and subject
        const [classCheck] = await connection.execute(`
            SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
        `, [classId, teacherId, schoolId]);
        
        if (classCheck.length === 0) {
            req.session.error = 'You do not have permission to add timetable for this class';
            return res.redirect('/teacher/manage-timetable');
        }

        if (timetableId && timetableId !== '') {
            // Update existing entry
            await connection.execute(`
                UPDATE teacher_timetable SET
                    class_id = ?, subject_id = ?, day_of_week = ?,
                    start_time = ?, end_time = ?, room = ?, notes = ?,
                    week_start = ?, week_end = ?, is_recurring = ?, updated_at = NOW()
                WHERE id = ? AND teacher_id = ? AND school_id = ?
            `, [classId, subjectId, dayOfWeek, startTime, endTime, room || null, notes || null, 
                weekStart || null, weekEnd || null, isRecurring === 'on' ? 1 : 0, timetableId, teacherId, schoolId]);
            req.session.success = 'Timetable entry updated successfully';
        } else {
            // Insert new entry
            await connection.execute(`
                INSERT INTO teacher_timetable 
                (teacher_id, class_id, subject_id, day_of_week, start_time, end_time, room, notes, week_start, week_end, is_recurring, school_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [teacherId, classId, subjectId, dayOfWeek, startTime, endTime, room || null, notes || null, 
                weekStart || null, weekEnd || null, isRecurring === 'on' ? 1 : 0, schoolId]);
            req.session.success = 'Timetable entry added successfully';
        }

        res.redirect('/teacher/manage-timetable');

    } catch (error) {
        console.error('Error adding timetable entry:', error);
        req.session.error = 'Failed to add timetable entry: ' + error.message;
        res.redirect('/teacher/manage-timetable');
    }
});

// GET route - Delete timetable entry
router.get('/teacher/timetable/delete/:id', authenticate, requireRole('teacher'), async (req, res) => {
    const entryId = req.params.id;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        await connection.execute(`
            DELETE FROM teacher_timetable 
            WHERE id = ? AND teacher_id = ? AND school_id = ?
        `, [entryId, teacherId, schoolId]);

        req.session.success = 'Timetable entry deleted successfully';
        res.redirect('/teacher/manage-timetable');

    } catch (error) {
        console.error('Error deleting timetable entry:', error);
        req.session.error = 'Failed to delete timetable entry';
        res.redirect('/teacher/manage-timetable');
    }
});

router.get('/add-class', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const connection = await getConnection();
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
        
        const [teachers] = await connection.execute('SELECT id, firstName, lastName FROM teachers WHERE school_id = ? ORDER BY lastName', [req.session.schoolId || null]);
        
        res.render('add-class', {
            teachers: teachers,
            formData: {
                level: '',
                department: ''
            },
            error: null,
            success: null,
            username: username,           // ADD THIS LINE
            unreadCount: unreadCount,     // ADD THIS LINE
            totalCount: totalCount,       // ADD THIS LINE
            notifications: notifications  // ADD THIS LINE
        });
    } catch (error) {
        console.error('Error loading add class form:', error);
        res.render('add-class', {
            teachers: [],
            formData: {
                level: '',
                department: ''
            },
            error: 'Failed to load teacher data',
            success: null,
            username: req.session.username || 'Admin',  // ADD THIS LINE
            unreadCount: 0,                             // ADD THIS LINE
            totalCount: 0,                              // ADD THIS LINE
            notifications: []                           // ADD THIS LINE
        });
    }
});

// ==================== TEACHER MANAGE SCORES ROUTES ====================
// GET route - Teacher Manage Scores View
router.get('/teacher/manage-scores', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get query parameters
        const selectedClassId = req.query.classId || null;
        const selectedSubjectId = req.query.subjectId || null;
        const selectedTerm = req.query.term || null;
        const selectedAcademicYear = req.query.academicYear || null;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

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

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
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

        // Get ONLY classes assigned to this teacher
        const [teacherClasses] = await connection.execute(`
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

        // Get subjects for selected class
        let classSubjects = [];
        if (selectedClassId) {
            // Verify teacher has access to this class
            const [classAccess] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [selectedClassId, teacherId, schoolId]);

            if (classAccess.length > 0) {
                const [subjects] = await connection.execute(`
                    SELECT s.id, s.name, s.subject_code, s.description
                    FROM subjects s
                    JOIN class_subjects cs ON cs.subject_id = s.id
                    WHERE cs.class_id = ?
                    ORDER BY s.name
                `, [selectedClassId]);
                classSubjects = subjects;
            }
        }

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const academicYear = selectedAcademicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024');
        const term = selectedTerm || (currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term');

        // Get available academic years and terms for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years ORDER BY year_name DESC
        `);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `);

        // Get students with scores if class and subject are selected
        let students = [];
        let subjectInfo = null;
        let classInfo = null;
        let scoreStats = {
            totalStudents: 0,
            scoresEntered: 0,
            averageScore: 0,
            highestScore: 0,
            lowestScore: 100,
            completionRate: 0
        };

        if (selectedClassId && selectedSubjectId) {
            // Verify teacher has access to this class
            const [classAccess] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [selectedClassId, teacherId, schoolId]);

            if (classAccess.length === 0) {
                return res.render('teacher-manage-scores', {
                    teacher: teacher,
                    teacherName: teacherName,
                    teacherClasses: teacherClasses,
                    classSubjects: [],
                    subjectInfo: null,
                    classInfo: null,
                    students: [],
                    scoreStats: scoreStats,
                    academicYears: academicYears,
                    terms: terms,
                    selectedClassId: selectedClassId,
                    selectedSubjectId: null,
                    selectedTerm: term,
                    selectedAcademicYear: academicYear,
                    unreadCount: unreadCount,
                    totalCount: totalCount,  // ADD THIS LINE
                    notifications: notifications,
                    username: username,  // ADD THIS LINE
                    moment: require('moment'),
                    error: 'You do not have permission to access this class',
                    success: null,
                    title: 'Manage Scores',
                    currentPage: 'teacher-manage-scores'
                });
            }

            // Get class info
            const [classData] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes WHERE id = ?
            `, [selectedClassId]);
            classInfo = classData[0] || null;

            // Get subject info
            const [subjectData] = await connection.execute(`
                SELECT id, name, subject_code, description FROM subjects WHERE id = ?
            `, [selectedSubjectId]);
            subjectInfo = subjectData[0] || null;

            // Get students in the class with their scores
            const [studentData] = await connection.execute(`
                SELECT 
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.admission_number,
                    sc.id as score_id,
                    sc.test_score,
                    sc.exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                    sc.term,
                    sc.academic_year,
                    CASE 
                        WHEN COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) >= 80 THEN 'A'
                        WHEN COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) >= 70 THEN 'B'
                        WHEN COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) >= 60 THEN 'C'
                        WHEN COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) >= 50 THEN 'D'
                        WHEN COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) >= 40 THEN 'E'
                        ELSE 'F'
                    END as grade
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.subject_id = ? 
                    AND sc.term = ? 
                    AND sc.academic_year = ?
                    AND sc.class_id = ?
                WHERE s.classId = ? AND s.school_id = ?
                ORDER BY s.lastName, s.firstName
            `, [selectedSubjectId, term, academicYear, selectedClassId, selectedClassId, schoolId]);

            students = studentData;

            // Calculate statistics
            let totalStudents = students.length;
            let scoresEntered = 0;
            let totalScoreSum = 0;
            let highestScore = 0;
            let lowestScore = 100;

            for (var i = 0; i < students.length; i++) {
                var student = students[i];
                var totalScore = parseFloat(student.total_score) || 0;
                if (totalScore > 0) {
                    scoresEntered++;
                    totalScoreSum += totalScore;
                    if (totalScore > highestScore) highestScore = totalScore;
                    if (totalScore < lowestScore) lowestScore = totalScore;
                }
            }

            var averageScore = scoresEntered > 0 ? (totalScoreSum / scoresEntered).toFixed(1) : 0;
            var completionRate = totalStudents > 0 ? ((scoresEntered / totalStudents) * 100).toFixed(1) : 0;

            scoreStats = {
                totalStudents: totalStudents,
                scoresEntered: scoresEntered,
                averageScore: averageScore,
                highestScore: highestScore,
                lowestScore: lowestScore === 100 ? 0 : lowestScore,
                completionRate: completionRate
            };
        }

        res.render('teacher-manage-scores', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            classSubjects: classSubjects,
            subjectInfo: subjectInfo,
            classInfo: classInfo,
            students: students,
            scoreStats: scoreStats,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: selectedClassId,
            selectedSubjectId: selectedSubjectId,
            selectedTerm: term,
            selectedAcademicYear: academicYear,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Manage Scores',
            currentPage: 'teacher-manage-scores'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading manage scores page:', error);
        res.render('teacher-manage-scores', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            classSubjects: [],
            subjectInfo: null,
            classInfo: null,
            students: [],
            scoreStats: {
                totalStudents: 0,
                scoresEntered: 0,
                averageScore: 0,
                highestScore: 0,
                lowestScore: 0,
                completionRate: 0
            },
            academicYears: [],
            terms: [],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: '',
            selectedAcademicYear: '',
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load page: ' + error.message,
            title: 'Manage Scores',
            currentPage: 'teacher-manage-scores'
        });
    }
});

// POST route - Save scores for students (bulk save)
router.post('/teacher/save-scores-bulk', authenticate, requireRole('teacher'), uploadNoFile.none(), async (req, res) => {
    const { classId, subjectId, term, academicYear, scores } = req.body;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access to this class and subject
        const [accessCheck] = await connection.execute(`
            SELECT c.id FROM classes c
            JOIN class_subjects cs ON cs.class_id = c.id
            WHERE c.id = ? AND c.professorId = ? AND cs.subject_id = ? AND c.school_id = ?
        `, [classId, teacherId, subjectId, schoolId]);

        if (accessCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // Parse scores
        let scoresArray = [];
        if (typeof scores === 'string') {
            try {
                scoresArray = JSON.parse(scores);
            } catch (e) {
                scoresArray = [];
            }
        } else if (Array.isArray(scores)) {
            scoresArray = scores;
        }

        let savedCount = 0;
        let errors = [];

        await connection.beginTransaction();

        for (var i = 0; i < scoresArray.length; i++) {
            var score = scoresArray[i];
            var studentId = score.studentId;
            var testScore = parseFloat(score.testScore) || 0;
            var examScore = parseFloat(score.examScore) || 0;

            // Validate score ranges
            if (testScore < 0 || testScore > 40) {
                errors.push(`Test score for ${score.studentName || 'student'} must be between 0 and 40`);
                continue;
            }
            if (examScore < 0 || examScore > 60) {
                errors.push(`Exam score for ${score.studentName || 'student'} must be between 0 and 60`);
                continue;
            }

            // Check if score record exists for this class
            const [existing] = await connection.execute(`
                SELECT id FROM student_scores 
                WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?
            `, [studentId, subjectId, term, academicYear, classId]);

            if (existing.length > 0) {
                await connection.execute(`
                    UPDATE student_scores 
                    SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW()
                    WHERE id = ?
                `, [testScore, examScore, schoolId, existing[0].id]);
            } else {
                await connection.execute(`
                    INSERT INTO student_scores 
                    (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                `, [studentId, subjectId, term, academicYear, classId, schoolId, testScore, examScore]);
            }
            savedCount++;
        }

        await connection.commit();

        if (errors.length > 0) {
            return res.json({ success: true, savedCount: savedCount, errors: errors, message: `${savedCount} score(s) saved with warnings: ${errors.join('; ')}` });
        }
        
        res.json({ success: true, savedCount: savedCount, message: `${savedCount} score(s) saved successfully!` });

    } catch (error) {
        console.error('Error saving scores:', error);
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Get subjects for a class (AJAX)
router.get('/api/teacher/class-subjects/:classId', authenticate, requireRole('teacher'), async (req, res) => {
    const classId = req.params.classId;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access to this class
        const [classCheck] = await connection.execute(`
            SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
        `, [classId, teacherId, schoolId]);

        if (classCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const [subjects] = await connection.execute(`
            SELECT s.id, s.name, s.subject_code
            FROM subjects s
            JOIN class_subjects cs ON cs.subject_id = s.id
            WHERE cs.class_id = ?
            ORDER BY s.name
        `, [classId]);

        res.json({ success: true, subjects: subjects });

    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Save scores for students
router.post('/teacher/save-scores-bulk', authenticate, requireRole('teacher'), uploadNoFile.none(), async (req, res) => {
    const { classId, subjectId, term, academicYear, scores } = req.body;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access to this class and subject
        const [accessCheck] = await connection.execute(`
            SELECT c.id FROM classes c
            JOIN class_subjects cs ON cs.class_id = c.id
            WHERE c.id = ? AND c.professorId = ? AND cs.subject_id = ? AND c.school_id = ?
        `, [classId, teacherId, subjectId, schoolId]);

        if (accessCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // Parse scores
        let scoresArray = [];
        if (typeof scores === 'string') {
            try {
                scoresArray = JSON.parse(scores);
            } catch (e) {
                scoresArray = [];
            }
        } else if (Array.isArray(scores)) {
            scoresArray = scores;
        }

        let savedCount = 0;
        let errors = [];

        await connection.beginTransaction();

        for (var i = 0; i < scoresArray.length; i++) {
            var score = scoresArray[i];
            var studentId = score.studentId;
            var testScore = parseFloat(score.testScore) || 0;
            var examScore = parseFloat(score.examScore) || 0;

            // Validate score ranges
            if (testScore < 0 || testScore > 40) {
                errors.push(`Test score for ${score.studentName || 'student'} must be between 0 and 40`);
                continue;
            }
            if (examScore < 0 || examScore > 60) {
                errors.push(`Exam score for ${score.studentName || 'student'} must be between 0 and 60`);
                continue;
            }

            // Check if score record exists for this class
            const [existing] = await connection.execute(`
                SELECT id FROM student_scores 
                WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ? AND class_id = ?
            `, [studentId, subjectId, term, academicYear, classId]);

            if (existing.length > 0) {
                await connection.execute(`
                    UPDATE student_scores 
                    SET test_score = ?, exam_score = ?, school_id = COALESCE(school_id, ?), updated_at = NOW()
                    WHERE id = ?
                `, [testScore, examScore, schoolId, existing[0].id]);
            } else {
                await connection.execute(`
                    INSERT INTO student_scores 
                    (student_id, subject_id, term, academic_year, class_id, school_id, test_score, exam_score, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                `, [studentId, subjectId, term, academicYear, classId, schoolId, testScore, examScore]);
            }
            savedCount++;
        }

        await connection.commit();

        req.session.success = `${savedCount} score(s) saved successfully!`;
        if (errors.length > 0) {
            req.session.error = errors.join('; ');
        }
        
        res.json({ success: true, savedCount: savedCount, errors: errors });

    } catch (error) {
        console.error('Error saving scores:', error);
        if (connection) await connection.rollback();
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Get student list for a class (AJAX)
router.get('/api/teacher/class-students/:classId', authenticate, requireRole('teacher'), async (req, res) => {
    const classId = req.params.classId;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access to this class
        const [classCheck] = await connection.execute(`
            SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
        `, [classId, teacherId, schoolId]);

        if (classCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const [students] = await connection.execute(`
            SELECT id, firstName, middleName, lastName, admission_number
            FROM students 
            WHERE classId = ?
            ORDER BY lastName, firstName
        `, [classId]);

        const formattedStudents = students.map(function(s) {
            var fullName = s.firstName;
            if (s.middleName) fullName += ' ' + s.middleName;
            fullName += ' ' + s.lastName;
            return {
                id: s.id,
                name: fullName,
                admissionNumber: s.admission_number
            };
        });

        res.json({ success: true, students: formattedStudents });

    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET route - Get student scores for a subject (AJAX)
router.get('/api/teacher/student-scores', authenticate, requireRole('teacher'), async (req, res) => {
    const { studentId, subjectId, term, academicYear } = req.query;
    const teacherId = req.session.userId;
    const schoolId = req.session.schoolId || null;

    try {
        const connection = await getConnection();

        // Verify teacher has access to this subject through their classes
        const [accessCheck] = await connection.execute(`
            SELECT cs.id FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND cs.subject_id = ? AND c.school_id = ?
        `, [teacherId, subjectId, schoolId]);

        if (accessCheck.length === 0) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const [scores] = await connection.execute(`
            SELECT test_score, exam_score 
            FROM student_scores 
            WHERE student_id = ? AND subject_id = ? AND term = ? AND academic_year = ?
        `, [studentId, subjectId, term, academicYear]);

        if (scores.length > 0) {
            res.json({ 
                success: true, 
                testScore: scores[0].test_score || 0, 
                examScore: scores[0].exam_score || 0 
            });
        } else {
            res.json({ success: true, testScore: 0, examScore: 0 });
        }

    } catch (error) {
        console.error('Error fetching student scores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== TEACHER GRADE BOOKS ROUTES ====================

// GET route - Teacher Grade Books View
// GET route - Teacher Grade Books View
router.get('/teacher/grade-books', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get query parameters
        const selectedClassId = req.query.classId || null;
        const selectedSubjectId = req.query.subjectId || null;
        const selectedTerm = req.query.term || null;
        const selectedAcademicYear = req.query.academicYear || null;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

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

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
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

        // Get all classes assigned to this teacher
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department, c.classCode
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        // Get subjects for selected class
        let classSubjects = [];
        if (selectedClassId) {
            const [subjects] = await connection.execute(`
                SELECT s.id, s.name, s.subject_code, s.description
                FROM subjects s
                JOIN class_subjects cs ON cs.subject_id = s.id
                WHERE cs.class_id = ?
                ORDER BY s.name
            `, [selectedClassId]);
            classSubjects = subjects;
        }

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const academicYear = selectedAcademicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024');
        const term = selectedTerm || (currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term');

        // Get available academic years and terms for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years ORDER BY year_name DESC
        `);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `);

        // Get grade book data if class and subject are selected
        let gradeBookData = [];
        let subjectInfo = null;
        let classInfo = null;
        let statistics = {
            totalStudents: 0,
            averageScore: 0,
            highestScore: 0,
            lowestScore: 100,
            passCount: 0,
            failCount: 0,
            passRate: 0,
            gradeDistribution: {
                A: 0, B: 0, C: 0, D: 0, E: 0, F: 0
            }
        };

        if (selectedClassId && selectedSubjectId) {
            // Get class info
            const [classData] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes WHERE id = ?
            `, [selectedClassId]);
            classInfo = classData[0] || null;

            // Get subject info
            const [subjectData] = await connection.execute(`
                SELECT id, name, subject_code, description FROM subjects WHERE id = ?
            `, [selectedSubjectId]);
            subjectInfo = subjectData[0] || null;

            // Get all students with their scores
            const [students] = await connection.execute(`
                SELECT 
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.admission_number,
                    s.gender,
                    COALESCE(sc.test_score, 0) as test_score,
                    COALESCE(sc.exam_score, 0) as exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                    sc.term,
                    sc.academic_year,
                    sc.updated_at as score_updated_at
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.subject_id = ? 
                    AND sc.term = ? 
                    AND sc.academic_year = ?
                    AND sc.class_id = ?
                WHERE s.classId = ? AND s.school_id = ?
                ORDER BY s.lastName, s.firstName
            `, [selectedSubjectId, term, academicYear, selectedClassId, selectedClassId, schoolId]);

            // Calculate statistics and add grade information
            let totalScoreSum = 0;
            let scoreCount = 0;

            for (var i = 0; i < students.length; i++) {
                var student = students[i];
                var totalScore = parseFloat(student.total_score) || 0;
                var grade = getGrade(totalScore);
                var gradeClass = getGradeClass(grade);
                var performance = getPerformanceRemark(totalScore);

                if (totalScore > 0) {
                    totalScoreSum += totalScore;
                    scoreCount++;
                    if (totalScore > statistics.highestScore) statistics.highestScore = totalScore;
                    if (totalScore < statistics.lowestScore) statistics.lowestScore = totalScore;

                    if (totalScore >= 50) {
                        statistics.passCount++;
                    } else {
                        statistics.failCount++;
                    }

                    // Count grade distribution
                    if (grade === 'A') statistics.gradeDistribution.A++;
                    else if (grade === 'B') statistics.gradeDistribution.B++;
                    else if (grade === 'C') statistics.gradeDistribution.C++;
                    else if (grade === 'D') statistics.gradeDistribution.D++;
                    else if (grade === 'E') statistics.gradeDistribution.E++;
                    else if (grade === 'F') statistics.gradeDistribution.F++;
                }

                gradeBookData.push({
                    id: student.id,
                    firstName: student.firstName,
                    middleName: student.middleName,
                    lastName: student.lastName,
                    fullName: studentDisplayName(student),
                    admissionNumber: student.admission_number,
                    gender: student.gender,
                    testScore: student.test_score || 0,
                    examScore: student.exam_score || 0,
                    totalScore: totalScore.toFixed(1),
                    grade: grade,
                    gradeClass: gradeClass,
                    performance: performance,
                    updatedAt: student.score_updated_at
                });
            }

            statistics.totalStudents = students.length;
            statistics.averageScore = scoreCount > 0 ? (totalScoreSum / scoreCount).toFixed(1) : 0;
            statistics.lowestScore = statistics.lowestScore === 100 ? 0 : statistics.lowestScore;
            statistics.passRate = students.length > 0 ? ((statistics.passCount / students.length) * 100).toFixed(1) : 0;

            // Sort grade book by total score descending
            gradeBookData.sort(function (a, b) {
                return parseFloat(b.totalScore) - parseFloat(a.totalScore);
            });

            // Add rank
            for (var i = 0; i < gradeBookData.length; i++) {
                gradeBookData[i].rank = i + 1;
                if (i > 0 && gradeBookData[i].totalScore === gradeBookData[i - 1].totalScore) {
                    gradeBookData[i].rank = gradeBookData[i - 1].rank;
                }
            }
        }

        res.render('teacher-grade-books', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            classSubjects: classSubjects,
            classInfo: classInfo,
            subjectInfo: subjectInfo,
            gradeBookData: gradeBookData,
            statistics: statistics,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: selectedClassId,
            selectedSubjectId: selectedSubjectId,
            selectedTerm: term,
            selectedAcademicYear: academicYear,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Grade Books',
            currentPage: 'teacher-grade-books'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading grade books:', error);
        res.render('teacher-grade-books', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            classSubjects: [],
            classInfo: null,
            subjectInfo: null,
            gradeBookData: [],
            statistics: {
                totalStudents: 0,
                averageScore: 0,
                highestScore: 0,
                lowestScore: 0,
                passCount: 0,
                failCount: 0,
                passRate: 0,
                gradeDistribution: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 }
            },
            academicYears: [],
            terms: [],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: '',
            selectedAcademicYear: '',
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load grade books: ' + error.message,
            title: 'Grade Books',
            currentPage: 'teacher-grade-books'
        });
    }
});

// Helper functions for grade



// GET route - Export grade book as CSV/PDF
router.get('/teacher/grade-books/export', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        
        const { classId, subjectId, term, academicYear, format } = req.query;
        
        if (!classId || !subjectId) {
            req.session.error = 'Class and Subject are required for export';
            return res.redirect('/teacher/grade-books');
        }
        
        // Get class info
        const [classData] = await connection.execute(`
            SELECT className, level, department FROM classes WHERE id = ?
        `, [classId]);
        
        // Get subject info
        const [subjectData] = await connection.execute(`
            SELECT name, subject_code FROM subjects WHERE id = ?
        `, [subjectId]);
        
        // Get students with scores
        const [students] = await connection.execute(`
            SELECT 
                s.firstName,
                s.middleName,
                s.lastName,
                s.admission_number,
                COALESCE(sc.test_score, 0) as test_score,
                COALESCE(sc.exam_score, 0) as exam_score,
                COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.subject_id = ? 
                AND sc.term = ? 
                AND sc.academic_year = ?
                AND sc.class_id = ?
            WHERE s.classId = ?
            ORDER BY s.lastName, s.firstName
        `, [subjectId, term, academicYear, classId, classId]);
        
        if (format === 'csv') {
            // Export as CSV
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=grade_book_${classData[0].className}_${subjectData[0].name}_${term}_${academicYear}.csv`);
            
            // CSV Headers
            let csvRows = [];
            csvRows.push(['S/N', 'Admission Number', 'Student Name', 'Test Score (40)', 'Exam Score (60)', 'Total Score (100)', 'Grade']);
            
            // Add data rows
            for (var i = 0; i < students.length; i++) {
                var s = students[i];
                var total = parseFloat(s.total_score) || 0;
                var grade = getGrade(total);
                csvRows.push([
                    i + 1,
                    s.admission_number || 'N/A',
                    `${s.firstName} ${s.middleName || ''} ${s.lastName}`.trim(),
                    s.test_score || 0,
                    s.exam_score || 0,
                    total.toFixed(1),
                    grade
                ]);
            }
            
            // Add summary rows
            csvRows.push([]);
            csvRows.push(['Summary', '', '', '', '', '', '']);
            csvRows.push(['Class:', classData[0].className, '', '', '', '', '']);
            csvRows.push(['Subject:', subjectData[0].name, '', '', '', '', '']);
            csvRows.push(['Term:', term, '', '', '', '', '']);
            csvRows.push(['Academic Year:', academicYear, '', '', '', '', '']);
            csvRows.push(['Export Date:', new Date().toLocaleString(), '', '', '', '', '']);
            
            const csvContent = csvRows.map(row => row.join(',')).join('\n');
            res.send(csvContent);
        } else {
            // Default to HTML view for print/PDF
            res.render('teacher-grade-book-print', {
                classInfo: classData[0],
                subjectInfo: subjectData[0],
                students: students,
                term: term,
                academicYear: academicYear,
                schoolName: 'EduSuite School',
                getGrade: getGrade,
                moment: require('moment')
            });
        }
        
    } catch (error) {
        console.error('Error exporting grade book:', error);
        req.session.error = 'Failed to export grade book';
        res.redirect('/teacher/grade-books');
    }
});

// ==================== TEACHER ATTENDANCE SUMMARY ROUTES ====================
// GET route - Teacher Attendance Summary
router.get('/teacher/attendance-summary', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get query parameters
        const selectedClassId = req.query.classId || null;
        const selectedTerm = req.query.term || null;
        const selectedAcademicYear = req.query.academicYear || null;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

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

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
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

        // Get ONLY classes assigned to this teacher
        const [teacherClasses] = await connection.execute(`
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

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const academicYear = selectedAcademicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024');
        const term = selectedTerm || (currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term');

        // Get available academic years and terms for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years ORDER BY year_name DESC
        `);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `);

        // Get term dates
        let termStartDate = null;
        let termEndDate = null;
        if (academicYear && term) {
            const [termDates] = await connection.execute(`
                SELECT at.start_date, at.end_date
                FROM academic_terms at
                JOIN academic_years ay ON at.academic_year_id = ay.id
                WHERE ay.year_name = ? AND at.term_name = ? AND ay.school_id = ?
            `, [academicYear, term, schoolId]);

            if (termDates.length > 0) {
                termStartDate = termDates[0].start_date;
                termEndDate = termDates[0].end_date;
            }
        }

        // Get attendance summary data
        let classAttendanceSummary = [];
        let overallSummary = {
            totalStudents: 0,
            totalPresent: 0,
            totalAbsent: 0,
            totalLate: 0,
            totalExcused: 0,
            overallPercentage: 0,
            bestClass: null,
            bestAttendance: 0,
            worstClass: null,
            worstAttendance: 100
        };

        if (selectedClassId) {
            // Verify teacher has access to this class
            const [classAccess] = await connection.execute(`
                SELECT id FROM classes WHERE id = ? AND professorId = ? AND school_id = ?
            `, [selectedClassId, teacherId, schoolId]);

            if (classAccess.length === 0) {
                return res.render('teacher-attendance-summary', {
                    teacher: teacher,
                    teacherName: teacherName,
                    teacherClasses: teacherClasses,
                    academicYears: academicYears,
                    terms: terms,
                    selectedClassId: null,
                    selectedTerm: term,
                    selectedAcademicYear: academicYear,
                    classAttendanceSummary: [],
                    overallSummary: overallSummary,
                    unreadCount: unreadCount,
                    totalCount: totalCount,  // ADD THIS LINE
                    notifications: notifications,
                    username: username,  // ADD THIS LINE
                    moment: require('moment'),
                    error: 'You do not have permission to view attendance for this class'
                });
            }

            // Get students in the class
            const [students] = await connection.execute(`
                SELECT s.id, s.firstName, s.middleName, s.lastName, s.admission_number, s.gender
                FROM students s
                WHERE s.classId = ? AND s.school_id = ?
                ORDER BY s.lastName, s.firstName
            `, [selectedClassId, schoolId]);

            // Get attendance records for the class
            let attendanceRecords = [];
            if (termStartDate && termEndDate) {
                const [records] = await connection.execute(`
                    SELECT 
                        ar.student_id,
                        ar.morning_status,
                        ar.afternoon_status,
                        ar.date,
                        ar.notes
                    FROM attendance_records ar
                    WHERE ar.class_id = ? 
                        AND ar.academic_year = ? 
                        AND ar.term = ?
                        AND ar.date BETWEEN ? AND ?
                        AND ar.school_id = ?
                `, [selectedClassId, academicYear, term, termStartDate, termEndDate, schoolId]);
                attendanceRecords = records;
            }

            // Calculate attendance for each student
            const studentAttendance = [];
            let totalPresentCount = 0;
            let totalAbsentCount = 0;
            let totalLateCount = 0;
            let totalExcusedCount = 0;
            let totalDaysCount = 0;

            // Get unique dates from attendance records
            const uniqueDates = [...new Set(attendanceRecords.map(r => r.date))];
            totalDaysCount = uniqueDates.length;

            for (const student of students) {
                const studentRecords = attendanceRecords.filter(r => r.student_id === student.id);

                let presentCount = 0;
                let absentCount = 0;
                let lateCount = 0;
                let excusedCount = 0;

                for (const record of studentRecords) {
                    const isPresent = (record.morning_status === 'present' || record.afternoon_status === 'present');
                    const isAbsent = (record.morning_status === 'absent' && record.afternoon_status === 'absent');
                    const isLate = (record.morning_status === 'late' || record.afternoon_status === 'late');
                    const isExcused = (record.morning_status === 'excused' || record.afternoon_status === 'excused');

                    if (isPresent) {
                        presentCount++;
                        totalPresentCount++;
                    } else if (isAbsent) {
                        absentCount++;
                        totalAbsentCount++;
                    } else if (isLate) {
                        lateCount++;
                        totalLateCount++;
                    } else if (isExcused) {
                        excusedCount++;
                        totalExcusedCount++;
                    }
                }

                const attendancePercentage = totalDaysCount > 0 ? ((presentCount / totalDaysCount) * 100).toFixed(1) : 0;

                studentAttendance.push({
                    id: student.id,
                    fullName: studentDisplayName(student),
                    admissionNumber: student.admission_number,
                    gender: student.gender,
                    present: presentCount,
                    absent: absentCount,
                    late: lateCount,
                    excused: excusedCount,
                    totalDays: totalDaysCount,
                    percentage: attendancePercentage
                });
            }

            // Sort by attendance percentage
            studentAttendance.sort((a, b) => b.percentage - a.percentage);

            // Get class info
            const [classInfo] = await connection.execute(`
                SELECT className, level, department FROM classes WHERE id = ?
            `, [selectedClassId]);

            const overallPercentage = (totalPresentCount / (totalDaysCount * students.length) * 100).toFixed(1) || 0;

            classAttendanceSummary = [{
                classInfo: classInfo[0],
                students: studentAttendance,
                summary: {
                    totalStudents: students.length,
                    totalDays: totalDaysCount,
                    totalPresent: totalPresentCount,
                    totalAbsent: totalAbsentCount,
                    totalLate: totalLateCount,
                    totalExcused: totalExcusedCount,
                    overallPercentage: overallPercentage
                }
            }];
        } else if (teacherClasses.length > 0 && academicYear && term) {
            // Get summary for all teacher's classes
            for (const cls of teacherClasses) {
                // Get students in the class
                const [students] = await connection.execute(`
                    SELECT s.id
                    FROM students s
                    WHERE s.classId = ? AND s.school_id = ?
                `, [cls.id, schoolId]);

                // Get attendance records for the class
                let attendanceRecords = [];
                if (termStartDate && termEndDate) {
                    const [records] = await connection.execute(`
                        SELECT 
                            ar.student_id,
                            ar.morning_status,
                            ar.afternoon_status
                        FROM attendance_records ar
                        WHERE ar.class_id = ? 
                            AND ar.academic_year = ? 
                            AND ar.term = ?
                            AND ar.date BETWEEN ? AND ?
                            AND ar.school_id = ?
                    `, [cls.id, academicYear, term, termStartDate, termEndDate, schoolId]);
                    attendanceRecords = records;
                }

                // Get unique dates
                const uniqueDates = [...new Set(attendanceRecords.map(r => r.date))];
                const totalDays = uniqueDates.length;

                let presentCount = 0;
                for (const record of attendanceRecords) {
                    if (record.morning_status === 'present' || record.afternoon_status === 'present') {
                        presentCount++;
                    }
                }

                const expectedTotal = students.length * totalDays;
                const percentage = expectedTotal > 0 ? ((presentCount / expectedTotal) * 100).toFixed(1) : 0;

                classAttendanceSummary.push({
                    classId: cls.id,
                    className: cls.className,
                    level: cls.level,
                    department: cls.department,
                    totalStudents: students.length,
                    totalDays: totalDays,
                    presentCount: presentCount,
                    percentage: percentage
                });

                // Update overall summary
                overallSummary.totalStudents += students.length;
                overallSummary.totalPresent += presentCount;

                if (parseFloat(percentage) > parseFloat(overallSummary.bestAttendance)) {
                    overallSummary.bestAttendance = percentage;
                    overallSummary.bestClass = cls.className;
                }
                if (parseFloat(percentage) < parseFloat(overallSummary.worstAttendance)) {
                    overallSummary.worstAttendance = percentage;
                    overallSummary.worstClass = cls.className;
                }
            }

            overallSummary.overallPercentage = (overallSummary.totalPresent / (overallSummary.totalStudents * (overallSummary.totalDays || 1)) * 100).toFixed(1) || 0;

            // Sort by percentage
            classAttendanceSummary.sort((a, b) => b.percentage - a.percentage);
        }

        res.render('teacher-attendance-summary', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: selectedClassId,
            selectedTerm: term,
            selectedAcademicYear: academicYear,
            termStartDate: termStartDate,
            termEndDate: termEndDate,
            classAttendanceSummary: classAttendanceSummary,
            overallSummary: overallSummary,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            error: null
        });

    } catch (error) {
        console.error('Error loading teacher attendance summary:', error);
        res.render('teacher-attendance-summary', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            academicYears: [],
            terms: [],
            selectedClassId: null,
            selectedTerm: '',
            selectedAcademicYear: '',
            termStartDate: null,
            termEndDate: null,
            classAttendanceSummary: [],
            overallSummary: {
                totalStudents: 0,
                totalPresent: 0,
                totalAbsent: 0,
                totalLate: 0,
                totalExcused: 0,
                overallPercentage: 0,
                bestClass: null,
                bestAttendance: 0,
                worstClass: null,
                worstAttendance: 100
            },
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load attendance summary: ' + error.message
        });
    }
});

// ==================== TEACHER RESULT SHEETS ROUTES ====================
// GET route - Teacher Result Sheets View
router.get('/teacher/result-sheets', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';  // ADD THIS LINE

        // Get query parameters
        const selectedClassId = req.query.classId || null;
        const selectedSubjectId = req.query.subjectId || null;
        const selectedTerm = req.query.term || null;
        const selectedAcademicYear = req.query.academicYear || null;
        const layout = req.query.layout || 'detailed'; // detailed or summary

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        if (teachers.length === 0) {
            req.session.error = 'Teacher not found';
            return res.redirect('/teacher-dashboard');
        }

        const teacher = teachers[0];
        const teacherName = `${teacher.firstName} ${teacher.lastName}`;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

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

                // Get total count for notification badge
                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;  // ADD THIS LINE

                const [notificationList] = await connection.execute(`
                    SELECT id, message, is_read, created_at 
                    FROM teacher_notifications 
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

        // Get all classes assigned to this teacher
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department, c.classCode
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        // Get subjects for selected class
        let classSubjects = [];
        if (selectedClassId) {
            const [subjects] = await connection.execute(`
                SELECT s.id, s.name, s.subject_code, s.description
                FROM subjects s
                JOIN class_subjects cs ON cs.subject_id = s.id
                WHERE cs.class_id = ?
                ORDER BY s.name
            `, [selectedClassId]);
            classSubjects = subjects;
        }

        // Get current academic year and term
        const [currentAcademicYear] = await connection.execute(`
            SELECT year_name FROM academic_years WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const [currentTerm] = await connection.execute(`
            SELECT term_name FROM academic_terms WHERE is_current = TRUE AND school_id = ? LIMIT 1
        `, [schoolId]);

        const academicYear = selectedAcademicYear || (currentAcademicYear.length > 0 ? currentAcademicYear[0].year_name : '2023-2024');
        const term = selectedTerm || (currentTerm.length > 0 ? currentTerm[0].term_name : 'First Term');

        // Get available academic years and terms for dropdown
        const [academicYears] = await connection.execute(`
            SELECT DISTINCT year_name FROM academic_years ORDER BY year_name DESC
        `);

        const [terms] = await connection.execute(`
            SELECT DISTINCT term_name FROM academic_terms ORDER BY 
                CASE term_name
                    WHEN 'First Term' THEN 1
                    WHEN 'Second Term' THEN 2
                    WHEN 'Third Term' THEN 3
                END
        `);

        // Get result sheet data if class and subject are selected
        let resultData = [];
        let classInfo = null;
        let subjectInfo = null;
        let schoolInfo = null;
        let statistics = {
            totalStudents: 0,
            totalScores: 0,
            averageScore: 0,
            highestScore: 0,
            lowestScore: 100,
            passCount: 0,
            failCount: 0,
            passRate: 0,
            subjectAverage: 0,
            performanceByGender: { male: { count: 0, total: 0, average: 0 }, female: { count: 0, total: 0, average: 0 } }
        };

        if (selectedClassId && selectedSubjectId) {
            // Get school information
            const [schoolData] = schoolId
                ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
                : await connection.execute('SELECT * FROM school_info LIMIT 1');
            schoolInfo = schoolData[0] || {
                name: "Excel College",
                address: "12 Education Road, Lagos, Nigeria",
                email: "info@excelcollege.edu.ng",
                phone: "+234 812 345 6789"
            };

            // Get class info
            const [classData] = await connection.execute(`
                SELECT id, className, level, department 
                FROM classes WHERE id = ?
            `, [selectedClassId]);
            classInfo = classData[0] || null;

            // Get subject info
            const [subjectData] = await connection.execute(`
                SELECT id, name, subject_code, description FROM subjects WHERE id = ?
            `, [selectedSubjectId]);
            subjectInfo = subjectData[0] || null;

            // Get all students with their scores
            const [students] = await connection.execute(`
                SELECT 
                    s.id,
                    s.firstName,
                    s.middleName,
                    s.lastName,
                    s.admission_number,
                    s.gender,
                    s.dateOfBirth,
                    COALESCE(sc.test_score, 0) as test_score,
                    COALESCE(sc.exam_score, 0) as exam_score,
                    COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score,
                    sc.term,
                    sc.academic_year,
                    sc.updated_at as score_updated_at
                FROM students s
                LEFT JOIN student_scores sc ON sc.student_id = s.id 
                    AND sc.subject_id = ? 
                    AND sc.term = ? 
                    AND sc.academic_year = ?
                    AND sc.class_id = ?
                WHERE s.classId = ? AND s.school_id = ?
                ORDER BY s.lastName, s.firstName
            `, [selectedSubjectId, term, academicYear, selectedClassId, selectedClassId, schoolId]);

            // Calculate statistics
            let maleTotalScore = 0;
            let maleCount = 0;
            let femaleTotalScore = 0;
            let femaleCount = 0;
            let totalScoreSum = 0;
            let scoreCount = 0;

            for (var i = 0; i < students.length; i++) {
                var student = students[i];
                var totalScore = parseFloat(student.total_score) || 0;
                var grade = getGrade(totalScore);
                var gradeClass = getGradeClass(grade);
                var performance = getPerformanceRemark(totalScore);
                var position = getPosition(totalScore);

                if (totalScore > 0) {
                    totalScoreSum += totalScore;
                    scoreCount++;
                    if (totalScore > statistics.highestScore) statistics.highestScore = totalScore;
                    if (totalScore < statistics.lowestScore) statistics.lowestScore = totalScore;

                    if (totalScore >= 50) {
                        statistics.passCount++;
                    } else {
                        statistics.failCount++;
                    }

                    // Gender-based statistics
                    if (student.gender && student.gender.toLowerCase() === 'male') {
                        maleTotalScore += totalScore;
                        maleCount++;
                    } else if (student.gender && student.gender.toLowerCase() === 'female') {
                        femaleTotalScore += totalScore;
                        femaleCount++;
                    }
                }

                resultData.push({
                    id: student.id,
                    firstName: student.firstName,
                    middleName: student.middleName,
                    lastName: student.lastName,
                    fullName: studentDisplayName(student),
                    admissionNumber: student.admission_number,
                    gender: student.gender,
                    dateOfBirth: student.dateOfBirth,
                    testScore: student.test_score || 0,
                    examScore: student.exam_score || 0,
                    totalScore: totalScore.toFixed(1),
                    grade: grade,
                    gradeClass: gradeClass,
                    performance: performance,
                    position: position,
                    updatedAt: student.score_updated_at
                });
            }

            statistics.totalStudents = students.length;
            statistics.totalScores = scoreCount;
            statistics.averageScore = scoreCount > 0 ? (totalScoreSum / scoreCount).toFixed(1) : 0;
            statistics.lowestScore = statistics.lowestScore === 100 ? 0 : statistics.lowestScore;
            statistics.passRate = students.length > 0 ? ((statistics.passCount / students.length) * 100).toFixed(1) : 0;
            statistics.subjectAverage = statistics.averageScore;

            statistics.performanceByGender.male = {
                count: maleCount,
                total: maleTotalScore.toFixed(1),
                average: maleCount > 0 ? (maleTotalScore / maleCount).toFixed(1) : 0
            };
            statistics.performanceByGender.female = {
                count: femaleCount,
                total: femaleTotalScore.toFixed(1),
                average: femaleCount > 0 ? (femaleTotalScore / femaleCount).toFixed(1) : 0
            };

            // Sort by total score descending for rank
            resultData.sort(function (a, b) {
                return parseFloat(b.totalScore) - parseFloat(a.totalScore);
            });

            // Add rank
            for (var i = 0; i < resultData.length; i++) {
                resultData[i].rank = i + 1;
                if (i > 0 && resultData[i].totalScore === resultData[i - 1].totalScore) {
                    resultData[i].rank = resultData[i - 1].rank;
                }
            }

            // Sort back by name for display
            resultData.sort(function (a, b) {
                return a.fullName.localeCompare(b.fullName);
            });
        }

        res.render('teacher-result-sheets', {
            teacher: teacher,
            teacherName: teacherName,
            teacherClasses: teacherClasses,
            classSubjects: classSubjects,
            classInfo: classInfo,
            subjectInfo: subjectInfo,
            schoolInfo: schoolInfo,
            resultData: resultData,
            statistics: statistics,
            academicYears: academicYears,
            terms: terms,
            selectedClassId: selectedClassId,
            selectedSubjectId: selectedSubjectId,
            selectedTerm: term,
            selectedAcademicYear: academicYear,
            layout: layout,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE
            notifications: notifications,
            username: username,  // ADD THIS LINE
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'Result Sheets',
            currentPage: 'teacher-result-sheets'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading result sheets:', error);
        res.render('teacher-result-sheets', {
            teacher: { firstName: 'Teacher', lastName: '', designation: '' },
            teacherName: 'Teacher',
            teacherClasses: [],
            classSubjects: [],
            classInfo: null,
            subjectInfo: null,
            schoolInfo: null,
            resultData: [],
            statistics: {
                totalStudents: 0,
                totalScores: 0,
                averageScore: 0,
                highestScore: 0,
                lowestScore: 0,
                passCount: 0,
                failCount: 0,
                passRate: 0,
                subjectAverage: 0,
                performanceByGender: { male: { count: 0, total: 0, average: 0 }, female: { count: 0, total: 0, average: 0 } }
            },
            academicYears: [],
            terms: [],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: '',
            selectedAcademicYear: '',
            layout: 'detailed',
            unreadCount: 0,
            totalCount: 0,  // ADD THIS LINE
            notifications: [],
            username: req.session.username || 'Teacher',  // ADD THIS LINE
            moment: require('moment'),
            error: 'Failed to load result sheets: ' + error.message,
            title: 'Result Sheets',
            currentPage: 'teacher-result-sheets'
        });
    }
});

// Helper functions



// GET route - Print result sheet
router.get('/teacher/result-sheets/print', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        
        const { classId, subjectId, term, academicYear } = req.query;
        
        if (!classId || !subjectId) {
            req.session.error = 'Class and Subject are required';
            return res.redirect('/teacher/result-sheets');
        }
        
        // Get school information
        const [schoolData] = schoolId
            ? await connection.execute('SELECT * FROM school_info WHERE id = ? LIMIT 1', [schoolId])
            : await connection.execute('SELECT * FROM school_info LIMIT 1');
        
        const schoolInfo = schoolData[0] || {
            name: "Excel College",
            address: "12 Education Road, Lagos, Nigeria",
            email: "info@excelcollege.edu.ng",
            phone: "+234 812 345 6789"
        };
        
        // Get class info
        const [classData] = await connection.execute(`
            SELECT id, className, level, department 
            FROM classes WHERE id = ?
        `, [classId]);
        
        // Get subject info
        const [subjectData] = await connection.execute(`
            SELECT id, name, subject_code, description FROM subjects WHERE id = ?
        `, [subjectId]);
        
        // Get students with scores
        const [students] = await connection.execute(`
            SELECT 
                s.firstName,
                s.middleName,
                s.lastName,
                s.admission_number,
                s.gender,
                COALESCE(sc.test_score, 0) as test_score,
                COALESCE(sc.exam_score, 0) as exam_score,
                COALESCE(sc.test_score, 0) + COALESCE(sc.exam_score, 0) as total_score
            FROM students s
            LEFT JOIN student_scores sc ON sc.student_id = s.id 
                AND sc.subject_id = ? 
                AND sc.term = ? 
                AND sc.academic_year = ?
                AND sc.class_id = ?
            WHERE s.classId = ?
            ORDER BY s.lastName, s.firstName
        `, [subjectId, term, academicYear, classId, classId]);
        
        // Calculate rank
        var studentsWithTotal = students.map(function(s) {
            var total = parseFloat(s.total_score) || 0;
            return {
                ...s,
                totalScore: total,
                fullName: studentDisplayName(s),
                grade: getGrade(total)
            };
        });
        
        studentsWithTotal.sort(function(a, b) {
            return b.totalScore - a.totalScore;
        });
        
        for (var i = 0; i < studentsWithTotal.length; i++) {
            studentsWithTotal[i].rank = i + 1;
            if (i > 0 && studentsWithTotal[i].totalScore === studentsWithTotal[i-1].totalScore) {
                studentsWithTotal[i].rank = studentsWithTotal[i-1].rank;
            }
        }
        
        studentsWithTotal.sort(function(a, b) {
            return a.fullName.localeCompare(b.fullName);
        });
        
        res.render('teacher-result-sheets-print', {
            school: schoolInfo,
            classInfo: classData[0],
            subjectInfo: subjectData[0],
            students: studentsWithTotal,
            term: term,
            academicYear: academicYear,
            getGrade: getGrade,
            getGradeClass: getGradeClass,
            moment: require('moment')
        });
        
    } catch (error) {
        console.error('Error printing result sheet:', error);
        req.session.error = 'Failed to print result sheet';
        res.redirect('/teacher/result-sheets');
    }
});

// Helper functions




// ==================== TEACHER NOTIFICATIONS ROUTES ====================
// GET route - Teacher Notifications View
router.get('/teacher/notifications', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';

        // Get query parameters for filtering
        const filter = req.query.filter || 'all';
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        // Get teacher information
        const [teachers] = await connection.execute(`
            SELECT id, firstName, lastName, email, designation, department 
            FROM teachers 
            WHERE id = ? AND school_id = ?
        `, [teacherId, schoolId]);

        const teacher = teachers[0];
        const teacherName = teacher.firstName + ' ' + teacher.lastName;

        // Get unread notifications count and total count
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];
        let totalRecords = 0;
        let totalPages = 1;
        
        // Check if notifications table exists
        const [tableCheck] = await connection.execute(`
            SELECT COUNT(*) as count FROM information_schema.tables 
            WHERE table_schema = DATABASE() AND table_name = 'teacher_notifications'
        `);

        const tableExists = tableCheck[0].count > 0;

        if (tableExists) {
            // Get unread count for badge
            const [unreadResult] = await connection.execute(`
                SELECT COUNT(*) as count 
                FROM teacher_notifications 
                WHERE teacher_id = ? AND is_read = 0
            `, [teacherId]);
            unreadCount = unreadResult[0]?.count || 0;
            
            // Get total count for notification badge
            const [totalResult] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM teacher_notifications 
                WHERE teacher_id = ?
            `, [teacherId]);
            totalCount = totalResult[0]?.total || 0;

            // Build query based on filter
            let whereClause = 'WHERE teacher_id = ?';
            let queryParams = [teacherId];

            if (filter === 'unread') {
                whereClause += ' AND is_read = 0';
            } else if (filter === 'read') {
                whereClause += ' AND is_read = 1';
            }

            // Get total count for pagination
            const [countResult] = await connection.execute(`
                SELECT COUNT(*) as total 
                FROM teacher_notifications 
                ${whereClause}
            `, queryParams);

            totalRecords = countResult[0]?.total || 0;
            totalPages = Math.ceil(totalRecords / limit);

            // Get notifications with pagination
            const [notificationList] = await connection.execute(`
                SELECT 
                    n.*,
                    DATE_FORMAT(n.created_at, '%W, %M %d, %Y at %h:%i %p') as formatted_date
                FROM teacher_notifications n
                ${whereClause}
                ORDER BY n.created_at DESC
                LIMIT ? OFFSET ?
            `, [...queryParams, limit, offset]);

            notifications = notificationList;
        }

        // Get success and error messages from session
        const success = req.session.success || null;
        const error = req.session.error || null;
        
        // Clear session messages
        delete req.session.success;
        delete req.session.error;

        res.render('teacher-notifications', {
            teacher: teacher,
            teacherName: teacherName,
            notifications: notifications,
            unreadCount: unreadCount,
            totalCount: totalCount,
            currentFilter: filter,
            currentPage: page,
            totalPages: totalPages,
            totalRecords: totalRecords,
            limit: limit,
            tableExists: tableExists,
            username: username,
            success: success,  // ADD THIS LINE
            error: error,      // ADD THIS LINE
            moment: require('moment')
        });

    } catch (error) {
        console.error('Error loading teacher notifications:', error);
        
        // Get success and error messages from session
        const success = req.session.success || null;
        const errorMsg = req.session.error || null;
        
        // Clear session messages
        delete req.session.success;
        delete req.session.error;
        
        res.render('teacher-notifications', {
            teacher: { firstName: 'Teacher', lastName: '' },
            teacherName: 'Teacher',
            notifications: [],
            unreadCount: 0,
            totalCount: 0,
            currentFilter: 'all',
            currentPage: 1,
            totalPages: 1,
            totalRecords: 0,
            limit: 20,
            tableExists: false,
            username: req.session.username || 'Teacher',
            success: success,      // ADD THIS LINE
            error: errorMsg,       // ADD THIS LINE
            moment: require('moment')
        });
    }
});

// POST route - Mark single notification as read
router.post('/teacher/notifications/mark-read/:id', authenticate, requireRole('teacher'), async (req, res) => {
    const notificationId = req.params.id;
    const teacherId = req.session.userId;

    try {
        const connection = await getConnection();

        // Check if notification belongs to this teacher
        const [check] = await connection.execute(
            'SELECT id FROM teacher_notifications WHERE id = ? AND teacher_id = ?',
            [notificationId, teacherId]
        );

        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }

        await connection.execute(
            'UPDATE teacher_notifications SET is_read = 1, read_at = NOW() WHERE id = ?',
            [notificationId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Mark all notifications as read
router.post('/teacher/notifications/mark-all-read', authenticate, requireRole('teacher'), async (req, res) => {
    const teacherId = req.session.userId;

    try {
        const connection = await getConnection();

        await connection.execute(
            'UPDATE teacher_notifications SET is_read = 1, read_at = NOW() WHERE teacher_id = ? AND is_read = 0',
            [teacherId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete notification
router.post('/teacher/notifications/delete/:id', authenticate, requireRole('teacher'), async (req, res) => {
    const notificationId = req.params.id;
    const teacherId = req.session.userId;

    try {
        const connection = await getConnection();

        // Check if notification belongs to this teacher
        const [check] = await connection.execute(
            'SELECT id FROM teacher_notifications WHERE id = ? AND teacher_id = ?',
            [notificationId, teacherId]
        );

        if (check.length === 0) {
            return res.status(404).json({ success: false, error: 'Notification not found' });
        }

        await connection.execute(
            'DELETE FROM teacher_notifications WHERE id = ?',
            [notificationId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST route - Delete all read notifications
router.post('/teacher/notifications/delete-all-read', authenticate, requireRole('teacher'), async (req, res) => {
    const teacherId = req.session.userId;

    try {
        const connection = await getConnection();

        await connection.execute(
            'DELETE FROM teacher_notifications WHERE teacher_id = ? AND is_read = 1',
            [teacherId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error deleting read notifications:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint - Get unread notification count (for AJAX polling)
router.get('/api/teacher/notifications/unread-count', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;

        const [result] = await connection.execute(
            'SELECT COUNT(*) as count FROM teacher_notifications WHERE teacher_id = ? AND is_read = 0',
            [teacherId]
        );

        res.json({ success: true, count: result[0]?.count || 0 });

    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.json({ success: false, count: 0 });
    }
});

// GET route - Teacher Lesson Notes (with teacher-specific filtering)
router.get('/teacher/lesson-notes', authenticate, requireRole('teacher'), async (req, res) => {
    try {
        const connection = await getConnection();
        const teacherId = req.session.userId;
        const schoolId = req.session.schoolId || null;
        const username = req.session.username || 'Teacher';

        // Get unread notifications
        let unreadCount = 0;
        let totalCount = 0;
        let notifications = [];

        try {
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

                const [totalResult] = await connection.execute(`
                    SELECT COUNT(*) as total 
                    FROM teacher_notifications 
                    WHERE teacher_id = ?
                `, [teacherId]);
                totalCount = totalResult[0]?.total || 0;

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
        }

        // Get only this teacher's lesson notes
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
            WHERE ln.teacher_id = ? AND ln.school_id = ?
            ORDER BY ln.academic_year DESC, 
                     CASE ln.term
                         WHEN 'First Term' THEN 1
                         WHEN 'Second Term' THEN 2
                         WHEN 'Third Term' THEN 3
                     END,
                     ln.week_number ASC
        `, [teacherId, schoolId]);

        // Get teacher's classes for filter
        const [teacherClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department 
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        // Get teacher's subjects for filter
        const [teacherSubjects] = await connection.execute(`
            SELECT DISTINCT s.id, s.name 
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY s.name
        `, [teacherId, schoolId]);

        res.render('lesson-notes', {
            lessonNotes: lessonNotes,
            classes: teacherClasses,
            subjects: teacherSubjects,
            academicYears: [],
            terms: ['First Term', 'Second Term', 'Third Term'],
            weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: null,
            selectedWeekNumber: null,
            selectedAcademicYear: null,
            currentPage: 1,
            totalPages: 1,
            totalRecords: lessonNotes.length,
            userRole: 'teacher',
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            moment: require('moment'),
            success: req.session.success || null,
            error: req.session.error || null,
            title: 'My Lesson Notes',
            currentPage: 'lesson-notes'
        });

        delete req.session.success;
        delete req.session.error;

    } catch (error) {
        console.error('Error loading teacher lesson notes:', error);
        res.render('lesson-notes', {
            lessonNotes: [],
            classes: [],
            subjects: [],
            academicYears: [],
            terms: ['First Term', 'Second Term', 'Third Term'],
            weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            selectedClassId: null,
            selectedSubjectId: null,
            selectedTerm: null,
            selectedWeekNumber: null,
            selectedAcademicYear: null,
            currentPage: 1,
            totalPages: 1,
            totalRecords: 0,
            userRole: 'teacher',
            username: req.session.username || 'Teacher',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment: require('moment'),
            error: 'Failed to load lesson notes: ' + error.message
        });
    }
});

router.get('/teacher-profile/:id', authenticate, async (req, res) => {
    try {
        const connection = await getConnection();
        const schoolId = req.session.schoolId || null;
        const teacherId = req.params.id;
        const loggedInUserId = req.session.userId;
        const userRole = req.session.role;
        const username = req.session.username || (userRole === 'teacher' ? 'Teacher' : 'Admin');

        // Get unread notifications count for the topbar
        let unreadCount = 0;
        let totalCount = 0;  // ADD THIS LINE
        let notifications = [];

        // Check if viewing own profile or admin
        const isOwnProfile = (userRole === 'teacher' && loggedInUserId == teacherId);
        const isAdmin = (userRole === 'admin');

        if (!isOwnProfile && !isAdmin) {
            req.session.error = 'You do not have permission to view this profile';
            return res.redirect('/teacher-dashboard');
        }

        // Get teacher data with additional information
        const [teachers] = await connection.execute(
            `SELECT t.*, 
                    COUNT(DISTINCT c.id) as class_count,
                    COUNT(DISTINCT s.id) as student_count
             FROM teachers t
             LEFT JOIN classes c ON c.professorId = t.id AND c.school_id = t.school_id
             LEFT JOIN students s ON s.classId = c.id AND s.school_id = t.school_id
             WHERE t.id = ? AND t.school_id = ?
             GROUP BY t.id`,
            [teacherId, schoolId]
        );

        if (teachers.length === 0) {
            return res.status(404).render('error', {
                message: 'Teacher not found',
                error: { status: 404, message: 'The requested teacher does not exist.' }
            });
        }

        const teacher = teachers[0];

        // Get notifications based on role
        if (userRole === 'teacher' && isOwnProfile) {
            try {
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

                    const [totalResult] = await connection.execute(`
                        SELECT COUNT(*) as total 
                        FROM teacher_notifications 
                        WHERE teacher_id = ?
                    `, [teacherId]);
                    totalCount = totalResult[0]?.total || 0;

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
        } else if (userRole === 'admin') {
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

        // Get teacher's assigned classes
        const [assignedClasses] = await connection.execute(`
            SELECT c.id, c.className, c.level, c.department,
                   (SELECT COUNT(*) FROM students WHERE classId = c.id) as student_count
            FROM classes c
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY c.className
        `, [teacherId, schoolId]);

        // Get teacher's subjects
        const [subjects] = await connection.execute(`
            SELECT DISTINCT s.id, s.name, s.subject_code
            FROM subjects s
            JOIN class_subjects cs ON s.id = cs.subject_id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            ORDER BY s.name
        `, [teacherId, schoolId]);

        // Calculate counts for sidebar
        const myClassesCount = assignedClasses.length;
        const totalStudentsCount = assignedClasses.reduce((sum, cls) => sum + (cls.student_count || 0), 0);

        // Get recent activities
        const [recentActivities] = await connection.execute(`
            SELECT 
                'Entered scores for ' as activity,
                COUNT(*) as count,
                MAX(sc.created_at) as date
            FROM student_scores sc
            JOIN subjects sub ON sc.subject_id = sub.id
            JOIN class_subjects cs ON sub.id = cs.subject_id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            GROUP BY DATE(sc.created_at)
            ORDER BY sc.created_at DESC
            LIMIT 5
        `, [teacherId, schoolId]);

        // Get attendance summary
        const [attendanceSummary] = await connection.execute(`
            SELECT 
                COUNT(CASE WHEN (morning_status = 'present' OR afternoon_status = 'present') THEN 1 END) as present_count,
                COUNT(*) as total_sessions
            FROM attendance_records ar
            JOIN classes c ON ar.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            AND ar.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, [teacherId, schoolId]);

        const attendancePercentage = attendanceSummary.length > 0 && attendanceSummary[0].total_sessions > 0
            ? Math.round((attendanceSummary[0].present_count / attendanceSummary[0].total_sessions) * 100)
            : 0;

        // Get performance metrics
        const [performanceMetrics] = await connection.execute(`
            SELECT 
                AVG(sc.test_score + sc.exam_score) as avg_score,
                MAX(sc.test_score + sc.exam_score) as max_score,
                MIN(sc.test_score + sc.exam_score) as min_score
            FROM student_scores sc
            JOIN subjects sub ON sc.subject_id = sub.id
            JOIN class_subjects cs ON sub.id = cs.subject_id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.professorId = ? AND c.school_id = ?
            AND sc.academic_year = (SELECT year_name FROM academic_years WHERE is_current = TRUE LIMIT 1)
            AND sc.term = (SELECT term_name FROM academic_terms WHERE is_current = TRUE LIMIT 1)
        `, [teacherId, schoolId]);

        // Prepare teacher data for template
        const teacherData = {
            id: teacher.id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            email: teacher.email,
            phone: teacher.mobileNumber,
            gender: teacher.gender,
            designation: teacher.designation,
            department: teacher.department,
            dateOfBirth: teacher.dateOfBirth,
            joiningDate: teacher.joiningDate,
            education: teacher.education,
            nationality: teacher.nationality,
            stateOfOrigin: teacher.stateOfOrigin,
            localGovernment: teacher.localGovernment,
            residentialState: teacher.residentialState,
            residentialLGA: teacher.residentialLGA,
            emergencyContactName: teacher.emergencyContactName,
            emergencyContactNumber: teacher.emergencyContactNumber,
            address: teacher.address,
            class_count: teacher.class_count || 0,
            student_count: teacher.student_count || 0
        };

        // Render the profile with all data including sidebar variables
        res.render('teacher-profile', {
            // Teacher data
            teacher: teacher,
            teacherData: teacherData,
            teacherName: `${teacher.firstName} ${teacher.lastName}`,
            teacherEmail: teacher.email,
            teacherDesignation: teacher.designation || 'Teacher',

            // Sidebar variables (important!)
            myClassesCount: myClassesCount,
            totalStudents: totalStudentsCount,
            unreadCount: unreadCount,
            totalCount: totalCount,  // ADD THIS LINE

            // Profile specific data
            assignedClasses: assignedClasses,
            subjects: subjects,
            recentActivities: recentActivities,
            attendancePercentage: attendancePercentage,
            performanceMetrics: performanceMetrics[0] || { avg_score: 0, max_score: 0, min_score: 0 },

            // Notifications
            notifications: notifications,

            // Helper functions
            moment: require('moment'),

            // Page metadata
            title: 'Teacher Profile',
            currentPage: 'teacher-profile',
            role: req.session.role,
            username: username,  // ADD THIS LINE
            userId: req.session.userId
        });

    } catch (error) {
        console.error('Error fetching teacher profile:', error);
        res.status(500).render('error', {
            message: 'Error loading teacher profile',
            error: { status: 500, message: error.message }
        });
    }
});

// Staff Profile Route

module.exports = router;
