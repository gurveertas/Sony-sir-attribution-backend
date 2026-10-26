import express from 'express';
import {
    registerCompany,
    companyLogin,
    sendMe,
    userLogout,
    verifyUser,
    resendVerification,
    forgotPass,
    resetPassword,
    verifyTwoFactorLogin,
    setupTwoFactor,
    enableTwoFactor,
    disableTwoFactor,
} from '../controllers/authController.js';
import { protectRoute } from '../middlewares/protectRoute.js';

const router = express.Router();
router.post('/company/register', registerCompany);
router.post('/user/login', companyLogin);
router.post('/2fa/verify', verifyTwoFactorLogin);
router.post('/verify-user', verifyUser);
router.post('/resend-verification', resendVerification);
router.post('/user/forgotpass', forgotPass);
router.post('/user/reset-password', resetPassword);
// Documented legacy alias; both paths intentionally share the same handler.
router.post('/reset-password', resetPassword);
router.get('/me', protectRoute, sendMe);
router.post('/2fa/setup', protectRoute, setupTwoFactor);
router.post('/2fa/enable', protectRoute, enableTwoFactor);
router.post('/2fa/disable', protectRoute, disableTwoFactor);
router.post('/logout', userLogout);

export default router;
