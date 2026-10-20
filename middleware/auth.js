const { verifySupabaseJwt, supabaseAdmin } = require('../config/supabase');

// Middleware to authenticate user via Session or Supabase JWT
async function authenticate(req, res, next) {
    // 1. Check existing session
    if (req.session && (req.session.role || req.session.parentId || req.session.userId)) {
        return next();
    }

    // 2. Check Supabase JWT bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const { valid, payload } = await verifySupabaseJwt(token);
        if (valid && payload) {
            req.supabaseUser = payload;
            if (!req.session) req.session = {};
            req.session.userId = payload.sub;
            req.session.role = payload.role || payload.app_metadata?.role || 'admin';
            return next();
        }
    }

    // 3. Fallback to login redirect or 401 for API routes
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    return res.redirect('/login');
}

// Middleware to check specific roles
function requireRole(role) {
    return (req, res, next) => {
        const userRole = req.session?.role || req.supabaseUser?.role;
        if (userRole === role) {
            return next();
        } else if (role === 'parent' && req.session && req.session.parentId && req.session.role === 'parent') {
            return next();
        } else {
            if (req.path && req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: 'Access Denied: insufficient permissions' });
            }
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
