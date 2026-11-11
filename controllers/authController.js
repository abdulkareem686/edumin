const argon2 = require('argon2');
const moment = require('moment');
const { getConnection } = require('../config/db');
const { studentDisplayName } = require('../utils/helpers');

// Function to compare passwords
async function comparePassword(inputPassword, storedPassword) {
    return await argon2.verify(storedPassword, inputPassword);
}

exports.comparePassword = comparePassword;

exports.getRegister = (req, res) => {
    res.render('page-register', { error: null });
};

exports.postRegister = async (req, res) => {
    const { 
        username, 
        email, 
        password, 
        confirmPassword, 
        role,
        schoolName,
        schoolEmail,
        schoolPhone,
        schoolWebsite,
        schoolAddress
    } = req.body;

    try {
        const connection = await getConnection();

        // Validate required fields
        if (!username || !email || !password || !role || !schoolName || !schoolEmail || !schoolPhone || !schoolAddress) {
            return res.render('page-register', { 
                error: 'All required fields must be filled' 
            });
        }

        // Check if passwords match
        if (password !== confirmPassword) {
            return res.render('page-register', { 
                error: 'Passwords do not match' 
            });
        }

        // Check password length
        if (password.length < 8) {
            return res.render('page-register', { 
                error: 'Password must be at least 8 characters long' 
            });
        }

        // Check if the username or email already exists
        const [existingUsers] = await connection.execute(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existingUsers.length > 0) {
            return res.render('page-register', { 
                error: 'Username or email already exists' 
            });
        }

        // Hash the password
        const hashedPassword = await argon2.hash(password);

        // Start transaction
        await connection.beginTransaction();

        try {
            // First, insert school information
            const [schoolResult] = await connection.execute(
                'INSERT INTO school_info (name, email, phone, website, address) VALUES (?, ?, ?, ?, ?)',
                [schoolName, schoolEmail, schoolPhone, schoolWebsite || null, schoolAddress]
            );

            const schoolId = schoolResult.insertId;

            // Then, insert the user with school reference
            await connection.execute(
                'INSERT INTO users (username, password, role, email, school_id) VALUES (?, ?, ?, ?, ?)',
                [username, hashedPassword, role, email, schoolId]
            );

            // Commit transaction
            await connection.commit();

            // Store school in session
            req.session.schoolId = schoolId;

            // Redirect to login after successful registration
            req.session.success = 'School registration successful! Please login.';
            res.redirect('/login');

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Registration error:', error);
        res.render('page-register', { 
            error: 'Registration failed: ' + error.message 
        });
    }
};

exports.getLogin = (req, res) => {
    res.render('page-login', { error: null, success: req.session.success || null });
    delete req.session.success;
};

exports.postLogin = async (req, res) => {
    const { email, credential } = req.body; // credential can be password or first name

    if (!email || !credential) {
        return res.render('page-login', {
            error: 'Email and credential are required'
        });
    }

    try {
        const connection = await getConnection();
        let sessionValues;
        let redirectTo;

        // Verify credentials before rotating the session; a failed login must
        // not invalidate an existing authenticated session.
        const [users] = await connection.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );
        if (users.length && await comparePassword(credential, users[0].password)) {
            const user = users[0];
            sessionValues = {
                userId: user.id,
                username: user.username,
                role: user.role,
                email: user.email || null,
                schoolId: user.school_id || null
            };
            redirectTo = '/';
        }

        if (!sessionValues) {
            const [parents] = await connection.execute(
                'SELECT * FROM parents WHERE email = ? AND status = "active"',
                [email]
            );
            if (parents.length && await comparePassword(credential, parents[0].password)) {
                const parent = parents[0];
                const [linkedStudents] = await connection.execute(`
                    SELECT s.*, c.className, c.level
                    FROM parent_students ps
                    JOIN students s ON ps.student_id = s.id
                    LEFT JOIN classes c ON s.classId = c.id
                    WHERE ps.parent_id = ? AND ps.can_receive_notifications = TRUE
                `, [parent.id]);
                const parentName = `${parent.first_name} ${parent.last_name}`;
                sessionValues = {
                    parentId: parent.id,
                    userId: parent.id,
                    username: parentName,
                    parentName,
                    parentEmail: parent.email,
                    role: 'parent',
                    linkedStudents,
                    schoolId: parent.school_id
                };
                redirectTo = '/parent/parent-dashboard';
            }
        }

        if (!sessionValues) {
            const [teachers] = await connection.execute(
                'SELECT * FROM teachers WHERE email = ?',
                [email]
            );
            if (teachers.length && await comparePassword(credential, teachers[0].password)) {
                const teacher = teachers[0];
                sessionValues = {
                    userId: teacher.id,
                    username: `${teacher.firstName} ${teacher.lastName}`,
                    role: 'teacher',
                    schoolId: teacher.school_id || null,
                    teacherData: teacher
                };
                redirectTo = '/teacher-dashboard';
            }
        }

        if (!sessionValues) {
            const [students] = await connection.execute(
                'SELECT * FROM students WHERE email = ? AND firstName = ?',
                [email, credential]
            );
            if (students.length) {
                const student = students[0];
                sessionValues = {
                    userId: student.id,
                    username: studentDisplayName(student),
                    role: 'student',
                    schoolId: student.school_id || null,
                    studentData: student
                };
                redirectTo = '/student-dashboard';
            }
        }

        if (!sessionValues) {
            return res.render('page-login', {
                error: 'Invalid credentials. Please check your email and password/first name.'
            });
        }

        await new Promise((resolve, reject) => {
            req.session.regenerate((err) => err ? reject(err) : resolve());
        });
        Object.assign(req.session, sessionValues);

        // Persist the authenticated session before redirecting. This is
        // necessary for serverless deployments where the redirect may be
        // handled by a different function instance.
        await new Promise((resolve, reject) => {
            req.session.save((err) => err ? reject(err) : resolve());
        });
        return res.redirect(redirectTo);

    } catch (error) {
        console.error('Login error:', error);
        if (!res.headersSent) {
            res.status(503).render('page-login', {
                error: 'Sign-in is temporarily unavailable. Please try again shortly.'
            });
        }
    }
};

exports.logout = (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.clearCookie('connect.sid', { path: '/' });
        res.redirect('/login');
    });
};

exports.getTeacherPortal = (req, res) => {
    if (req.session.role !== 'teacher') {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: { status: 403, message: 'You do not have permission to access this page.' }
        });
    }

    // There is no `teacher` view; the teacher landing page is the dashboard.
    res.redirect('/teacher-dashboard');
};

exports.getStaffPortal = (req, res) => {
    if (req.session.role === 'teacher') {
        return res.redirect('/teacher-dashboard');
    }

    if (req.session.role === 'admin') {
        return res.redirect('/');
    }

    res.status(403).render('error', {
        message: 'Access Denied',
        error: { status: 403, message: 'You do not have permission to access this page.' }
    });
};

exports.getAdminChangePassword = async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const username = req.session.username || 'Admin';

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

        res.render('admin-change-password', {
            username: username,
            unreadCount: unreadCount,
            totalCount: totalCount,
            notifications: notifications,
            error: req.session.error || null,
            success: req.session.success || null,
            moment: moment
        });

        delete req.session.error;
        delete req.session.success;

    } catch (error) {
        console.error('Error loading change password form:', error);
        res.status(500).render('error', {
            message: 'Error loading change password form',
            error: { status: 500, message: error.message },
            username: req.session.username || 'Admin'
        });
    }
};

exports.postAdminChangePassword = async (req, res) => {
    try {
        const connection = await getConnection();
        const adminId = req.session.userId;
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            req.session.error = 'All fields are required';
            return res.redirect('/admin/change-password');
        }

        if (newPassword !== confirmPassword) {
            req.session.error = 'New password and confirmation do not match';
            return res.redirect('/admin/change-password');
        }

        if (newPassword.length < 8) {
            req.session.error = 'New password must be at least 8 characters long';
            return res.redirect('/admin/change-password');
        }

        const [users] = await connection.execute(
            'SELECT password FROM users WHERE id = ?',
            [adminId]
        );

        if (users.length === 0) {
            req.session.error = 'User not found';
            return res.redirect('/admin/change-password');
        }

        const isPasswordValid = await comparePassword(currentPassword, users[0].password);
        if (!isPasswordValid) {
            req.session.error = 'Current password is incorrect';
            return res.redirect('/admin/change-password');
        }

        const hashedPassword = await argon2.hash(newPassword);

        await connection.execute(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedPassword, adminId]
        );

        req.session.success = 'Password changed successfully!';
        res.redirect('/admin/profile');

    } catch (error) {
        console.error('Error changing password:', error);
        req.session.error = 'Failed to change password: ' + error.message;
        res.redirect('/admin/change-password');
    }
};
