const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireRole } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { uploadNoFile } = require('../middleware/upload');

// Public auth routes
router.get('/register', authController.getRegister);
router.post('/register', authController.postRegister);

router.get('/login', authController.getLogin);
router.post('/login', loginLimiter, authController.postLogin);

router.get('/logout', authController.logout);

// Portal redirects
router.get('/teacher', authenticate, authController.getTeacherPortal);
router.get('/staff', authenticate, authController.getStaffPortal);

// Admin password management
router.get('/admin/change-password', authenticate, requireRole('admin'), authController.getAdminChangePassword);
router.post('/admin/change-password', authenticate, requireRole('admin'), uploadNoFile.none(), authController.postAdminChangePassword);

module.exports = router;
