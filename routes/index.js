const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const teacherRoutes = require('./teacherRoutes');
const parentRoutes = require('./parentRoutes');
const studentRoutes = require('./studentRoutes');
const adminRoutes = require('./adminRoutes');

// Mount routes
router.use('/', authRoutes);
router.use('/', teacherRoutes);
router.use('/', parentRoutes);
router.use('/', studentRoutes);
router.use('/', adminRoutes);

module.exports = router;
