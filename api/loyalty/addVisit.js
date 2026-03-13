import { addVisit } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const result = await addVisit(req.body || {});
    return sendSuccess(res, result);
  } catch (error) {
    return sendError(res, error, 'No se pudo registrar visita.');
  }
}
