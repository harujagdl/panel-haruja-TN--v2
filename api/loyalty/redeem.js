import { redeem } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const client = await redeem(req.body || {});
    return sendSuccess(res, { client });
  } catch (error) {
    return sendError(res, error, 'No se pudo canjear.');
  }
}
