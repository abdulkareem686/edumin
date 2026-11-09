const ejs = require('ejs');
const path = require('path');
const moment = require('moment');

const viewsDir = path.join(__dirname, '../views/school_app');

async function test() {
    console.log('Testing render of all newly created & patched views...');
    const dummySession = { role: 'admin', userId: 1, username: 'Admin' };
    const baseLocals = {
        moment,
        role: 'admin',
        userRole: 'admin',
        username: 'Admin',
        userId: 1,
        session: dummySession,
        unreadCount: 0,
        totalCount: 0,
        notifications: [],
        error: null,
        success: null,
        studentDisplayName: (s) => (s ? [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ') : 'Student')
    };

    // 1. graduated-students
    try {
        await ejs.renderFile(path.join(viewsDir, 'graduated-students.ejs'), {
            ...baseLocals,
            graduates: [
                { id: 1, firstName: 'Amina', lastName: 'Bello', admission_number: 'ADM/2020/001', gender: 'Female', className: 'SS 3 Diamond', level: 'SENIOR SECONDARY', graduation_year: '2025/2026', graduation_date: '2026-07-20', email: 'amina@example.com' }
            ],
            graduationYears: ['2025/2026', '2024/2025'],
            selectedYear: '',
            searchQ: '',
            totalGraduates: 1,
            maleCount: 0,
            femaleCount: 1
        }, { views: [viewsDir] });
        console.log('✓ graduated-students.ejs rendered successfully');
    } catch (e) {
        console.error('✗ graduated-students.ejs error:', e);
    }

    // 2. add-student
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-student.ejs'), {
            ...baseLocals,
            formData: {},
            classes: [{ id: 1, className: 'JSS 1 Gold' }],
            nigerianStates: { Lagos: ['Ikeja', 'Alimosho'] },
            mode: 'add'
        }, { views: [viewsDir] });
        console.log('✓ add-student.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-student.ejs error:', e);
    }

    // 3. add-parent
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-parent.ejs'), {
            ...baseLocals,
            formData: {},
            students: []
        }, { views: [viewsDir] });
        console.log('✓ add-parent.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-parent.ejs error:', e);
    }

    // 4. add-teacher
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-teacher.ejs'), {
            ...baseLocals,
            formData: {},
            classes: [],
            nigerianStates: {}
        }, { views: [viewsDir] });
        console.log('✓ add-teacher.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-teacher.ejs error:', e);
    }

    // 5. add-staff
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-staff.ejs'), {
            ...baseLocals,
            formData: {},
            nigerianStates: {}
        }, { views: [viewsDir] });
        console.log('✓ add-staff.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-staff.ejs error:', e);
    }

    // 6. add-class
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-class.ejs'), {
            ...baseLocals,
            formData: {},
            teachers: [{ id: 1, firstName: 'John', lastName: 'Doe' }]
        }, { views: [viewsDir] });
        console.log('✓ add-class.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-class.ejs error:', e);
    }

    // 7. add-library
    try {
        await ejs.renderFile(path.join(viewsDir, 'add-library.ejs'), {
            ...baseLocals,
            bookData: {},
            formData: {}
        }, { views: [viewsDir] });
        console.log('✓ add-library.ejs rendered successfully');
    } catch (e) {
        console.error('✗ add-library.ejs error:', e);
    }

    // 8. class-subjects
    try {
        await ejs.renderFile(path.join(viewsDir, 'class-subjects.ejs'), {
            ...baseLocals,
            classInfo: { id: 1, className: 'SS 1 Science', level: 'SENIOR SECONDARY', displayName: 'SS 1 Science' },
            subjects: [{ id: 1, subjectName: 'Physics', subjectCode: 'PHY' }],
            students: [{ id: 10, firstName: 'Aliyu', lastName: 'Musa', department: 'Science', enrollments: [{ subjectId: 1, subjectName: 'Physics' }] }]
        }, { views: [viewsDir] });
        console.log('✓ class-subjects.ejs rendered successfully');
    } catch (e) {
        console.error('✗ class-subjects.ejs error:', e);
    }

    // 9. student-dashboard
    try {
        await ejs.renderFile(path.join(viewsDir, 'student-dashboard.ejs'), {
            ...baseLocals,
            role: 'student',
            studentData: { id: 10, firstName: 'Fatima', lastName: 'Umar', admission_number: 'ADM005' },
            className: 'SS 2 Arts',
            admissionNumber: 'ADM005',
            currentAcademicYear: '2026/2027',
            currentTerm: 'First Term',
            recentResults: [{ subject_name: 'Literature', ca_score: 35, exam_score: 55, grade: 'A', remarks: 'Excellent' }],
            averageScore: 88,
            attendancePercentage: 96,
            presentDays: 48,
            totalDays: 50,
            feeStatus: { status: 'Paid', balance: 0 },
            upcomingEvents: [{ title: 'Mid-term Break', eventDate: '2026-11-15' }],
            calculateGrade: () => 'A',
            welcomeMessage: null
        }, { views: [viewsDir] });
        console.log('✓ student-dashboard.ejs rendered successfully');
    } catch (e) {
        console.error('✗ student-dashboard.ejs error:', e);
    }

    // 10. parent-child-detail
    try {
        await ejs.renderFile(path.join(viewsDir, 'parent-child-detail.ejs'), {
            ...baseLocals,
            role: 'parent',
            child: { id: 10, firstName: 'Fatima', lastName: 'Umar', fullName: 'Fatima Umar', className: 'SS 2 Arts', admission_number: 'ADM005', gender: 'Female' },
            recentResults: [],
            attendanceSummary: { present_days: 48, total_days: 50, percentage: 96 },
            feeSummary: { total_due: 45000, total_paid: 45000, fee_count: 1 },
            upcomingEvents: []
        }, { views: [viewsDir] });
        console.log('✓ parent-child-detail.ejs rendered successfully');
    } catch (e) {
        console.error('✗ parent-child-detail.ejs error:', e);
    }

    // 11. teacher-class-detail
    try {
        await ejs.renderFile(path.join(viewsDir, 'teacher-class-detail.ejs'), {
            ...baseLocals,
            role: 'teacher',
            classData: { id: 1, className: 'JSS 2 Diamond', level: 'JUNIOR SECONDARY' },
            students: [{ id: 1, firstName: 'Ibrahim', lastName: 'Sani', admission_number: 'ADM010', gender: 'Male' }],
            subjects: [{ id: 1, subjectName: 'Basic Science', subjectCode: 'BSC' }],
            academicYear: '2026/2027',
            term: 'First Term'
        }, { views: [viewsDir] });
        console.log('✓ teacher-class-detail.ejs rendered successfully');
    } catch (e) {
        console.error('✗ teacher-class-detail.ejs error:', e);
    }

    // 12. teacher-enter-scores
    try {
        await ejs.renderFile(path.join(viewsDir, 'teacher-enter-scores.ejs'), {
            ...baseLocals,
            role: 'teacher',
            classData: { id: 1, className: 'JSS 2 Diamond' },
            subjectData: { id: 1, subjectName: 'Basic Science' },
            students: [{ id: 1, firstName: 'Ibrahim', lastName: 'Sani', admission_number: 'ADM010', ca_score: 30, exam_score: 50 }],
            academicYear: '2026/2027',
            term: 'First Term',
            academicYears: [{ year_name: '2026/2027' }],
            terms: [{ term_name: 'First Term' }]
        }, { views: [viewsDir] });
        console.log('✓ teacher-enter-scores.ejs rendered successfully');
    } catch (e) {
        console.error('✗ teacher-enter-scores.ejs error:', e);
    }

    // 13. teacher-weekly-timetable
    try {
        await ejs.renderFile(path.join(viewsDir, 'teacher-weekly-timetable.ejs'), {
            ...baseLocals,
            role: 'teacher',
            teacher: { firstName: 'Mr.', lastName: 'Teacher' },
            teacherName: 'Mr. Teacher',
            teacherClasses: [],
            subjects: [],
            timetableByDay: { 1: [{ subject_name: 'Maths', class_name: 'JSS 1', start_time: '08:00', end_time: '09:00', room: '1A' }] },
            days: { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' }
        }, { views: [viewsDir] });
        console.log('✓ teacher-weekly-timetable.ejs rendered successfully');
    } catch (e) {
        console.error('✗ teacher-weekly-timetable.ejs error:', e);
    }

    // 14. teacher-manage-timetable
    try {
        await ejs.renderFile(path.join(viewsDir, 'teacher-manage-timetable.ejs'), {
            ...baseLocals,
            role: 'teacher',
            teacher: { firstName: 'Mr.', lastName: 'Teacher' },
            teacherName: 'Mr. Teacher',
            teacherClasses: [{ id: 1, className: 'JSS 1' }],
            teacherSubjects: [{ id: 1, subjectName: 'Maths' }],
            timetableByDay: {},
            days: { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' }
        }, { views: [viewsDir] });
        console.log('✓ teacher-manage-timetable.ejs rendered successfully');
    } catch (e) {
        console.error('✗ teacher-manage-timetable.ejs error:', e);
    }

    // 15. teacher-grade-book-print
    try {
        await ejs.renderFile(path.join(viewsDir, 'teacher-grade-book-print.ejs'), {
            classInfo: { className: 'JSS 2 Diamond' },
            subjectInfo: { subjectName: 'Basic Science' },
            students: [{ id: 1, firstName: 'Ibrahim', lastName: 'Sani', admission_number: 'ADM010', ca_score: 30, exam_score: 50 }],
            term: 'First Term',
            academicYear: '2026/2027',
            schoolName: 'EduSuite School',
            getGrade: () => 'A',
            moment
        }, { views: [viewsDir] });
        console.log('✓ teacher-grade-book-print.ejs rendered successfully');
    } catch (e) {
        console.error('✗ teacher-grade-book-print.ejs error:', e);
    }

    console.log('--- ALL VIEW TESTS COMPLETED ---');
}

test();
