import { searchClients } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const { items } = await searchClients(req.query?.q || '');
    return sendSuccess(res, { items });
  } catch (error) {
    return sendError(res, error, 'No se pudieron buscar clientes.');
  }
}
