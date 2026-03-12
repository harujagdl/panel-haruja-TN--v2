import {
  archivePrenda,
  createPrenda,
  deletePrenda,
  getCatalogos,
  getVentasConfig,
  getVentasComisiones,
  getVentasResumen,
  importCorrections,
  listArchivedPrendas,
  listPrendas,
  restorePrenda,
  saveVentasConfig,
  updateVentasComisiones,
} from '../lib/api/core.js';

const GET_ACTIONS = new Set(['catalogos', 'prendas-list', 'prendas-archived-list', 'ventas-comisiones', 'ventas-config', 'ventas-resumen']);
const POST_ACTIONS = new Set(['prendas-create', 'prendas-delete', 'prendas-archive', 'prendas-restore', 'prendas-import-corrections', 'ventas-comisiones', 'ventas-config-save']);

function success(res, data) {
  return res.status(200).json({ ok: true, data });
}

function error(res, status, message, err) {
  return res.status(status).json({ ok: false, message, ...(err ? { error: err } : {}) });
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return error(res, 400, 'action es obligatorio.');

  if (req.method === 'GET' && !GET_ACTIONS.has(action)) return error(res, 400, 'Acción GET inválida para /api/core.');
  if (req.method === 'POST' && !POST_ACTIONS.has(action)) return error(res, 400, 'Acción POST inválida para /api/core.');
  if (!['GET', 'POST'].includes(req.method || '')) return error(res, 405, 'Method not allowed.');
  if (req.method === 'GET' && POST_ACTIONS.has(action) && !GET_ACTIONS.has(action)) return error(res, 405, 'Method not allowed para esta action.');
  if (req.method === 'POST' && GET_ACTIONS.has(action) && !POST_ACTIONS.has(action)) return error(res, 405, 'Method not allowed para esta action.');

  try {
    if (action === 'catalogos') return success(res, await getCatalogos());
    if (action === 'prendas-list') return success(res, await listPrendas());
    if (action === 'prendas-create') return success(res, await createPrenda(req.body || {}));

    if (action === 'prendas-delete') {
      const result = await deletePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return success(res, result);
    }

    if (action === 'prendas-archive') {
      const result = await archivePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return success(res, result);
    }

    if (action === 'prendas-archived-list') return success(res, await listArchivedPrendas());

    if (action === 'prendas-restore') {
      const result = await restorePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return success(res, result);
    }

    if (action === 'prendas-import-corrections') return success(res, await importCorrections(req.body || {}));

    if (action === 'ventas-comisiones') {
      if (req.method === 'GET') return success(res, await getVentasComisiones(req.query || {}, req));
      return success(res, await updateVentasComisiones(req.body || {}, req));
    }

    if (action === 'ventas-config') {
      if (req.method !== 'GET') return error(res, 405, 'Method not allowed para esta action.');
      return success(res, await getVentasConfig());
    }

    if (action === 'ventas-config-save') {
      if (req.method !== 'POST') return error(res, 405, 'Method not allowed para esta action.');
      const payload = req.body || {};
      if (!String(payload.store_id || '').trim()) return error(res, 400, 'store_id es obligatorio.');
      return success(res, await saveVentasConfig(payload));
    }

    if (action === 'ventas-resumen') {
      if (req.method !== 'GET') return error(res, 405, 'Method not allowed para esta action.');
      return success(res, await getVentasResumen(req.query?.month));
    }

    return error(res, 400, 'Acción inválida para /api/core.');
  } catch (err) {
    return error(res, 400, err?.message || 'Error en /api/core.', err?.stack ? String(err.message || '') : undefined);
  }
}
