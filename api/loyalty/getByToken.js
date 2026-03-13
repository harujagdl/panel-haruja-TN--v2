import { getByToken } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const clientPublic = await getByToken(req.query?.token || '');
    return sendSuccess(res, { clientPublic });
  } catch (error) {
    return sendError(res, error, 'No se pudo obtener tarjeta por token.');
  }
}
