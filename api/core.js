import { getLatestWebhookEvent } from '../lib/ventas/dedupeWebhookEvent.js';
import {
  archivePrenda,
  assignVentaSeller,
  createPrenda,
  deletePrenda,
  getCatalogos,
  getVentasComisiones,
  getVentasConfig,
  getVentasDetalle,
  getVentasResumen,
  getVentasSinAsignar,
  importCorrections,
  listArchivedPrendas,
  listPrendas,
  rebuildVentasResumen,
  restorePrenda,
  saveVentasConfig,
  syncVentasFromTiendanube,
  registerTiendanubeWebhooks,
  updateVentasComisiones,
} from '../lib/api/core.js';

const GET_ACTIONS = new Set([
  'catalogos',
  'prendas-list',
  'prendas-archived-list',
  'ventas-comisiones',
  'ventas-config',
  'ventas-resumen',
  'ventas-detalle',
  'ventas-sin-asignar',
  'ventas-webhook-status',
]);
const POST_ACTIONS = new Set([
  'prendas-create',
  'prendas-delete',
  'prendas-archive',
  'prendas-restore',
  'prendas-import-corrections',
  'ventas-comisiones',
  'ventas-config-save',
  'ventas-sync',
  'venta-asignar-vendedora',
  'assign-seller',
  'ventas-rebuild',
  'tiendanube-webhooks-register',
]);

function success(res, data) {
  return res.status(200).json({ ok: true, data });
}

function error(res, status, message, err) {
  const detail = err ? String(err?.message || err) : undefined;
  return res.status(status).json({ ok: false, message, ...(detail ? { error: detail } : {}) });
}

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

export default async function handler(req, res) {
  try {
    const action = String(req.query?.action || '').trim();
    console.log('[api/core] action:', action || '(none)');
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

      if (action === 'ventas-detalle') {
        if (req.method !== 'GET') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await getVentasDetalle(req.query?.month, req.query?.search));
      }

      if (action === 'ventas-sin-asignar') {
        if (req.method !== 'GET') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await getVentasSinAsignar(req.query?.month));
      }

      if (action === 'ventas-webhook-status') {
        if (req.method !== 'GET') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await getLatestWebhookEvent());
      }

      if (action === 'ventas-sync') {
        if (req.method !== 'POST') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await syncVentasFromTiendanube());
      }

      if (action === 'venta-asignar-vendedora' || action === 'assign-seller') {
        if (req.method !== 'POST') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await assignVentaSeller(req.body || {}));
      }

      if (action === 'ventas-rebuild') {
        if (req.method !== 'POST') return error(res, 405, 'Method not allowed para esta action.');
        const month = req.body?.month || req.query?.month;
        return success(res, await rebuildVentasResumen(month));
      }

      if (action === 'tiendanube-webhooks-register') {
        if (req.method !== 'POST') return error(res, 405, 'Method not allowed para esta action.');
        return success(res, await registerTiendanubeWebhooks(getBaseUrl(req)));
      }

      return error(res, 400, 'Acción inválida para /api/core.');
    } catch (err) {
      console.error('[api/core] action failed:', action, err);
      const message = err?.message || `Error ejecutando action ${action}.`;
      const status = /no se encontr[oó] la venta/i.test(message) ? 404 : 400;
      return error(res, status, message, err);
    }
  } catch (errorFatal) {
    console.error('[api/core] fatal error:', errorFatal);
    return res.status(500).json({
      ok: false,
      message: errorFatal?.message || 'Error interno en /api/core.',
      error: String(errorFatal)
    });
  }
}
