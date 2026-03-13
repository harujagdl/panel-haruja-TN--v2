import { registerClient } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const client = await registerClient(req.body || {});
    return sendSuccess(res, { client });
  } catch (error) {
    return sendError(res, error, 'No se pudo registrar cliente.');
  }
}
