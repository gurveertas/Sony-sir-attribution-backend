import express from 'express';
import { getIndustryList, getPaymentMethod, addIndustry, addPaymentGateway, deleteIndustry, deletePaymentGateway} from '../controllers/inputFieldsController.js';

const router = express.Router();

router.get('/gateways', getPaymentMethod);
router.get('/industries', getIndustryList);
router.post("/industries", addIndustry);
router.post("/gateways", addPaymentGateway);
router.delete("/industries/:id", deleteIndustry);
router.delete("/gateways/:id", deletePaymentGateway);

export default router;