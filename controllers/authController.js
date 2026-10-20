const argon2 = require('argon2');
const moment = require('moment');
const { getConnection } = require('../config/db');
const { supabaseAdmin } = require('../config/supabase');
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
        let userExists = false;
        if (supabaseAdmin) {
            try {
                const { data } = await supabaseAdmin
                    .from('users')
                    .select('id')
                    .or(`username.eq.${username},email.eq.${email}`)
                    .limit(1);
                if (data && data.length > 0) userExists = true;
            } catch (_) {}
        }
        if (!userExists) {
            const [existingUsers] = await connection.execute(
                'SELECT id FROM users WHERE username = ? OR email = ?',
                [username, email]
            );
            if (existingUsers.length > 0) userExists = true;
        }

        if (userExists) {
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

            // Sync with Supabase
            if (supabaseAdmin) {
                try {
                    await supabaseAdmin.from('school_info').upsert({
                        id: schoolId,
                        name: schoolName,
                        email: schoolEmail,
                        phone: schoolPhone,
                        website: schoolWebsite || null,
                        address: schoolAddress
                    });
                    await supabaseAdmin.from('users').upsert({
                        username,
                        password: hashedPassword,
                        role,
                        email,
                        school_id: schoolId
                    });
                } catch (sbErr) {
                    console.warn('Supabase registration sync warning:', sbErr.message);
                }
            }

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

    try {
        const connection = await getConnection();

        if (!email || !credential) {
            return res.render('page-login', { 
                error: 'Email and credential are required' 
            });
        }

        // Regenerate session to ensure fresh session
        req.session.regenerate(async (err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.render('page-login', { 
                    error: 'Login failed. Please try again.' 
                });
            }

            try { 
                // First, try admin login via Supabase / MySQL
                let user = null;
                if (supabaseAdmin) {
                    try {
                        const { data } = await supabaseAdmin
                            .from('users')
                            .select('*')
                            .eq('email', email)
                            .limit(1);
                        if (data && data.length > 0) user = data[0];
                    } catch (_) {}
                }
                if (!user) {
                    const [users] = await connection.execute(
                        'SELECT * FROM users WHERE email = ?',
                        [email]
                    );
                    if (users.length > 0) user = users[0];
                }

                if (user) {
                    const passwordMatch = await comparePassword(credential, user.password);

                    if (passwordMatch) {
                        // Admin login successful
                        req.session.userId = user.id;
                        req.session.username = user.username;
                        req.session.role = user.role;
                        req.session.email = user.email || null;
                        req.session.schoolId = user.school_id || null;
                        return res.redirect('/');
                    }
                }

                // Second, try parent login (parents table with password)
                let parent = null;
                if (supabaseAdmin) {
                    try {
                        const { data } = await supabaseAdmin
                            .from('parents')
                            .select('*')
                            .eq('email', email)
                            .eq('status', 'active')
                            .limit(1);
                        if (data && data.length > 0) parent = data[0];
                    } catch (_) {}
                }
                if (!parent) {
                    const [parents] = await connection.execute(
                        'SELECT * FROM parents WHERE email = ? AND status = "active"',
                        [email]
                    );
                    if (parents.length > 0) parent = parents[0];
                }

                if (parent) {
                    const passwordMatch = await comparePassword(credential, parent.password);

                    if (passwordMatch) {
                        // Get linked students for this parent
                        const [linkedStudents] = await connection.execute(`
                            SELECT s.*, c.className, c.level 
                            FROM parent_students ps
                            JOIN students s ON ps.student_id = s.id
                            LEFT JOIN classes c ON s.classId = c.id
                            WHERE ps.parent_id = ? AND ps.can_receive_notifications = TRUE
                        `, [parent.id]);

                        req.session.parentId = parent.id;
                        req.session.userId = parent.id;
                        req.session.username = `${parent.first_name || parent.firstname} ${parent.last_name || parent.lastname}`;
                        req.session.parentName = `${parent.first_name || parent.firstname} ${parent.last_name || parent.lastname}`;
                        req.session.parentEmail = parent.email;
                        req.session.role = 'parent';
                        req.session.linkedStudents = linkedStudents;
                        req.session.schoolId = parent.school_id;
                        return res.redirect('/parent/parent-dashboard');
                    }
                }

                // Third, try teacher login (email + password)
                let teacher = null;
                if (supabaseAdmin) {
                    try {
                        const { data } = await supabaseAdmin
                            .from('teachers')
                            .select('*')
                            .eq('email', email)
                            .limit(1);
                        if (data && data.length > 0) teacher = data[0];
                    } catch (_) {}
                }
                if (!teacher) {
                    const [teachers] = await connection.execute(
                        'SELECT * FROM teachers WHERE email = ?',
                        [email]
                    );
                    if (teachers.length > 0) teacher = teachers[0];
                }

                if (teacher) {
                    const passwordMatch = await comparePassword(credential, teacher.password);

                    if (passwordMatch) {
                        // Teacher login successful
                        req.session.userId = teacher.id;
                        req.session.username = `${teacher.firstName || teacher.firstname} ${teacher.lastName || teacher.lastname}`;
                        req.session.role = 'teacher';
                        req.session.schoolId = teacher.school_id || null;
                        req.session.teacherData = teacher;
                        return res.redirect('/teacher-dashboard');
                    }
                }

                // Fourth, try student login (email + first name)
                let student = null;
                if (supabaseAdmin) {
                    try {
                        const { data } = await supabaseAdmin
                            .from('students')
                            .select('*')
                            .eq('email', email)
                            .ilike('firstname', credential)
                            .limit(1);
                        if (data && data.length > 0) student = data[0];
                    } catch (_) {}
                }
                if (!student) {
                    const [students] = await connection.execute(
                        'SELECT * FROM students WHERE email = ? AND firstName = ?',
                        [email, credential]
                    );
                    if (students.length > 0) student = students[0];
                }

                if (student) {
                    // Student login successful
                    req.session.userId = student.id;
                    req.session.username = studentDisplayName(student);
                    req.session.role = 'student';
                    req.session.schoolId = student.school_id || null;
                    req.session.studentData = student;
                    return res.redirect('/student-dashboard');
                }

                // If nothing matches, show generic error
                res.render('page-login', { 
                    error: 'Invalid credentials. Please check your email and password/first name.' 
                });
            } catch (innerError) {
                console.error('Login inner error:', innerError);
                res.render('page-login', { 
                    error: 'Login failed. Please try again.' 
                });
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.render('page-login', { 
            error: 'Login failed. Please try again.' 
        });
    }
};

exports.logout = (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
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
    res.render('teacher', { username: req.session.username });
};

exports.getStaffPortal = (req, res) => {
    if (req.session.role !== 'staff') {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: { status: 403, message: 'You do not have permission to access this page.' }
        });
    }
    res.render('staff', { username: req.session.username });
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

        if (supabaseAdmin) {
            try {
                await supabaseAdmin
                    .from('users')
                    .update({ password: hashedPassword })
                    .eq('id', adminId);
            } catch (sbErr) {
                console.warn('Supabase password change sync warning:', sbErr.message);
            }
        }

        req.session.success = 'Password changed successfully!';
        res.redirect('/admin/profile');

    } catch (error) {
        console.error('Error changing password:', error);
        req.session.error = 'Failed to change password: ' + error.message;
        res.redirect('/admin/change-password');
    }
};
