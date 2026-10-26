import express from 'express';
import {
    addMember,
    deleteUser,
    updateMember,
    addPlatformAdmin,
    getPlatformAdmins,
    deletePlatformAdmin,
    updatePlatformAdmin,
} from '../controllers/userController.js';
import { protectRoute, requireRole } from '../middlewares/protectRoute.js';

const router = express.Router();

router.use(protectRoute);

// Company users: company admins manage their own company, platform admins any company.
router.post('/add-member', requireRole('company_admin', 'platform_admin'), addMember);

// Platform admins (global accounts)
router.post('/add-platform-admin', requireRole('platform_admin'), addPlatformAdmin);
router.get('/platform-admins', requireRole('platform_admin'), getPlatformAdmins);
router.get('/platform-admin', requireRole('platform_admin'), getPlatformAdmins); // legacy alias
router.patch('/platform-admins/:userId', requireRole('platform_admin'), updatePlatformAdmin);
router.delete('/platform-admins/:userId', requireRole('platform_admin'), deletePlatformAdmin);
router.delete('/platform-admin/:userId', requireRole('platform_admin'), deletePlatformAdmin); // legacy alias

router.patch("/:userId", requireRole('company_admin', 'platform_admin'), updateMember);
router.delete('/:userId', requireRole('company_admin', 'platform_admin'), deleteUser);

export default router;
