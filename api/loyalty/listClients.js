import { listClients } from '../../lib/api/loyalty.js';
import { allowMethods, sendError, sendSuccess } from './_utils.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const { items } = await listClients({
      limit: req.query?.limit,
      orderBy: req.query?.orderBy,
      sort: req.query?.sort
    });
    return sendSuccess(res, { items });
  } catch (error) {
    return sendError(res, error, 'No se pudo listar clientes.');
  }
}
