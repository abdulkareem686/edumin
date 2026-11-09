// Middleware to authenticate user
function authenticate(req, res, next) {
    if (req.session && (req.session.role || req.session.parentId || req.session.userId)) {
        return next();
    } else {
        res.redirect('/login');
    }
}

// Middleware to check specific roles
function requireRole(role) {
    return (req, res, next) => {
        if (req.session && req.session.role === role) {
            return next();
        } else if (role === 'parent' && req.session && req.session.parentId && req.session.role === 'parent') {
            return next();
        } else {
            res.status(403).render('error', {
                message: 'Access Denied',
                error: { status: 403, message: 'You do not have permission to access this page.' }
            });
        }
    };
}

const requireAdmin = requireRole('admin');
const requireTeacher = requireRole('teacher');
const requireParent = requireRole('parent');
const requireStudent = requireRole('student');

module.exports = {
    authenticate,
    requireRole,
    requireAdmin,
    requireTeacher,
    requireParent,
    requireStudent
};
