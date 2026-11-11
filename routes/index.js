const express = require('express');
const router = express.Router();

const dashboardRoutes = require('./dashboardRoutes');
const authRoutes = require('./authRoutes');
const teacherRoutes = require('./teacherRoutes');
const parentRoutes = require('./parentRoutes');
const studentRoutes = require('./studentRoutes');
const adminRoutes = require('./adminRoutes');

// Mount routes
// Dashboard entry points are mounted first so `/dashboard`, `/admin`,
// `/teacher/dashboard`, `/student/dashboard`, ... always resolve instead of
// falling through to the 404 handler.
router.use('/', dashboardRoutes);
router.use('/', authRoutes);
router.use('/', teacherRoutes);
router.use('/', parentRoutes);
router.use('/', studentRoutes);
router.use('/', adminRoutes);

module.exports = router;
