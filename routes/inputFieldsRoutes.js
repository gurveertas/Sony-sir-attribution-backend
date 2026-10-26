import express from 'express';
import { getIndustryList, getPaymentMethod, addIndustry, addPaymentGateway, deleteIndustry, deletePaymentGateway } from '../controllers/inputFieldsController.js';
import { protectRoute, requireRole } from '../middlewares/protectRoute.js';

const router = express.Router();

// Reference lists are public (the sign-up form needs them before anyone is logged in).
router.get('/gateways', getPaymentMethod);
router.get('/industries', getIndustryList);

// Changing them is a platform-admin action.
const platformAdminOnly = [protectRoute, requireRole('platform_admin')];
router.post("/industries", ...platformAdminOnly, addIndustry);
router.post("/gateways", ...platformAdminOnly, addPaymentGateway);
router.delete("/industries/:id", ...platformAdminOnly, deleteIndustry);
router.delete("/gateways/:id", ...platformAdminOnly, deletePaymentGateway);

export default router;
