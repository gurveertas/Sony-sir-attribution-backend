import express from 'express';
import {
  createApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  rotateApiKey,
} from '../controllers/apiKeyController.js';
import { protectRoute } from '../middlewares/protectRoute.js';

const router = express.Router();

router.use(protectRoute);

router.post('/', createApiKey);

router.get('/', listApiKeys);

router.patch('/:id', updateApiKey);

router.delete('/:id', revokeApiKey);

router.post('/rotate', rotateApiKey);

export default router;
