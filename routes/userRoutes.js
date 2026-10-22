import express from 'express';
import { addMember, deleteUser, updateMember, addPlatformAdmin, getPlatformAdmins, deletePlatformAdmin } from '../controllers/userController.js';
import { protectRoute, requireRole } from '../middlewares/protectRoute.js';

const router = express.Router();

router.use(protectRoute);

router.post('/add-member', addMember);
router.post('/add-platform-admin', requireRole('platform_admin'), addPlatformAdmin);
router.get('/platform-admins', requireRole('platform_admin'), getPlatformAdmins);
router.delete('/platform-admins/:userId', requireRole('platform_admin'), deletePlatformAdmin);
// Legacy singular path retained for existing clients.
router.delete('/platform-admin/:userId', requireRole('platform_admin'), deletePlatformAdmin);

router.patch("/:userId", updateMember);

router.delete('/:userId', deleteUser);



export default router;
