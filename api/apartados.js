import {
  addAbono,
  cancelApartado,
  createApartado,
  getApartadoDetail,
  getHistorialApartado,
  getNextFolio,
  listApartados,
  searchApartados,
  updateApartadoStatus,
} from '../lib/api/apartados.js';

const GET_ACTIONS = new Set(['next', 'list', 'detail', 'historial', 'search']);
const POST_ACTIONS = new Set(['create', 'abono', 'update-status', 'cancel']);

const sendOk = (res, data) => res.status(200).json({ ok: true, data });
const sendErr = (res, status, message, error) => res.status(status).json({ ok: false, message, ...(error ? { error } : {}) });

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  if (!['GET', 'POST'].includes(req.method || '')) return sendErr(res, 405, 'Method not allowed.');
  if (req.method === 'GET' && !GET_ACTIONS.has(action)) return sendErr(res, POST_ACTIONS.has(action) ? 405 : 400, 'Acción inválida para método GET.');
  if (req.method === 'POST' && !POST_ACTIONS.has(action)) return sendErr(res, GET_ACTIONS.has(action) ? 405 : 400, 'Acción inválida para método POST.');

  const folio = String(req.query?.folio || req.body?.folio || '').trim();

  try {
    if (req.method === 'GET' && action === 'next') return sendOk(res, await getNextFolio());
    if (req.method === 'GET' && action === 'list') return sendOk(res, await listApartados());

    if (req.method === 'GET' && action === 'detail') {
      if (!folio) return sendErr(res, 400, 'folio es obligatorio para action=detail.');
      const result = await getApartadoDetail(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'GET' && action === 'historial') {
      if (!folio) return sendErr(res, 400, 'folio es obligatorio para action=historial.');
      const result = await getHistorialApartado(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'GET' && action === 'search') return sendOk(res, await searchApartados(req.query || {}));

    if (req.method === 'POST' && action === 'create') return sendOk(res, await createApartado(req.body || {}));
    if (req.method === 'POST' && action === 'abono') return sendOk(res, await addAbono(req.body || {}));

    if (req.method === 'POST' && action === 'update-status') {
      const result = await updateApartadoStatus(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'POST' && action === 'cancel') {
      const result = await cancelApartado(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    return sendErr(res, 400, 'Acción inválida para /api/apartados.');
  } catch (error) {
    return sendErr(res, 400, error?.message || 'Error en /api/apartados.');
  }
}
