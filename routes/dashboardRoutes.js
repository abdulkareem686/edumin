const express = require('express');
const router = express.Router();

const { authenticate, requireRole } = require('../middleware/auth');

/**
 * Canonical dashboard URL for every role.
 *
 * The application has always rendered these pages under their flat names
 * (for example `/teacher-dashboard`). The friendly, role-prefixed variants
 * (`/teacher/dashboard`, `/admin`, `/dashboard`, ...) were never registered,
 * so anybody following one of those links - a bookmark, a link from an older
 * release, or a URL typed by hand - landed on the 404 "Page Not Found" page.
 *
 * Every entry point below funnels into the canonical URL so there is exactly
 * one place that renders each dashboard.
 */
const ROLE_DASHBOARD = {
    admin: '/',
    teacher: '/teacher-dashboard',
    student: '/student-dashboard',
    parent: '/parent/parent-dashboard'
};

/**
 * Resolve the role of the signed-in user.
 *
 * Parent sessions are stored with both `role: 'parent'` and `parentId`, but a
 * parentId on its own is enough to identify a parent session.
 */
function resolveRole(req) {
    const session = req.session || {};

    if (session.role && ROLE_DASHBOARD[session.role]) {
        return session.role;
    }

    if (session.parentId) {
        return 'parent';
    }

    return null;
}

function sendToDashboard(req, res) {
    const role = resolveRole(req);

    if (!role) {
        return res.redirect('/login');
    }

    return res.redirect(ROLE_DASHBOARD[role]);
}

function redirectTo(role) {
    const target = ROLE_DASHBOARD[role];

    return (req, res) => res.redirect(target);
}

// ---------------------------------------------------------------------
// UNIVERSAL ENTRY POINTS
// ---------------------------------------------------------------------

// `/dashboard`, `/home` and `/dashboards` all resolve to the dashboard that
// belongs to the signed-in role instead of returning "Page Not Found".
router.get('/dashboard', authenticate, sendToDashboard);
router.get('/dashboards', authenticate, sendToDashboard);
router.get('/home', authenticate, sendToDashboard);

// ---------------------------------------------------------------------
// ADMIN DASHBOARD ALIASES
// ---------------------------------------------------------------------

// The admin dashboard is rendered at `/` by adminRoutes, so every other
// conventional admin landing URL redirects there.
router.get('/admin', authenticate, requireRole('admin'), redirectTo('admin'));
router.get('/admin/home', authenticate, requireRole('admin'), redirectTo('admin'));
router.get('/admin/index', authenticate, requireRole('admin'), redirectTo('admin'));
router.get('/admin/dashboard', authenticate, requireRole('admin'), redirectTo('admin'));
router.get('/admin-dashboard', authenticate, requireRole('admin'), redirectTo('admin'));

// ---------------------------------------------------------------------
// TEACHER DASHBOARD ALIASES
// ---------------------------------------------------------------------

// `/teacher` used to render a `teacher` view that does not exist. Send the
// teacher to their real dashboard instead of failing to render a page.
router.get('/teacher', authenticate, requireRole('teacher'), redirectTo('teacher'));
router.get('/teacher/home', authenticate, requireRole('teacher'), redirectTo('teacher'));
router.get('/teacher/dashboard', authenticate, requireRole('teacher'), redirectTo('teacher'));

// `/staff` is the admin/staff portal; the staff home is the admin dashboard.
router.get('/staff', authenticate, (req, res) => {
    const role = resolveRole(req);

    if (role === 'teacher') {
        return res.redirect(ROLE_DASHBOARD.teacher);
    }

    if (role === 'admin') {
        return res.redirect(ROLE_DASHBOARD.admin);
    }

    return res.redirect('/login');
});

// ---------------------------------------------------------------------
// STUDENT DASHBOARD ALIASES
// ---------------------------------------------------------------------

router.get('/student', authenticate, requireRole('student'), redirectTo('student'));
router.get('/student/home', authenticate, requireRole('student'), redirectTo('student'));
router.get('/student/dashboard', authenticate, requireRole('student'), redirectTo('student'));

// ---------------------------------------------------------------------
// PARENT DASHBOARD ALIASES
// ---------------------------------------------------------------------

router.get('/parent', authenticate, requireRole('parent'), redirectTo('parent'));
router.get('/parent/home', authenticate, requireRole('parent'), redirectTo('parent'));

module.exports = router;
