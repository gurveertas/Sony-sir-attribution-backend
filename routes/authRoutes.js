import express from 'express';
import { registerCompany, companyLogin, sendMe, userLogout, verifyUser, forgotPass, resetPassword } from '../controllers/authController.js';
import { protectRoute } from '../middlewares/protectRoute.js';

const router = express.Router(); 
router.post('/company/register', registerCompany);
router.post('/user/login', companyLogin);
router.post('/verify-user', verifyUser);
router.post('/user/forgotpass', forgotPass);
router.post('/user/reset-password', resetPassword);
// Documented legacy alias; both paths intentionally share the same handler.
router.post('/reset-password', resetPassword);
router.get('/me', protectRoute, sendMe);
router.post('/logout', userLogout);

export default router;
