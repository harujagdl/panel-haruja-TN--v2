import {
  archivePrenda,
  deletePrenda,
  importCorrections,
  listArchivedPrendas,
  restorePrenda,
} from '../lib/api/core.js';
import {
  ADMIN_SESSION_REQUIRED_MESSAGE,
  requireAdminSession,
  sendErr,
  sendOk,
} from './core.js';

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  if (!requireAdminSession(req, res, {
    logDenied: '[admin-session] admin action denied due to missing validated session',
    touchActivity: true,
    reason: `admin-${action || 'unknown-action'}`,
  })) {
    return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
  }

  try {
    if (action === 'prendas-delete') {
      const result = await deletePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archive') {
      const result = await archivePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-restore') {
      const result = await restorePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archived-list') return sendOk(res, await listArchivedPrendas());
    if (action === 'prendas-import-corrections') return sendOk(res, await importCorrections(req.body || {}));

    if (action === 'prendas-admin') {
      if (req.method === 'GET') return sendOk(res, await listArchivedPrendas());
      return sendOk(res, await importCorrections(req.body || {}));
    }

    return sendErr(res, 400, 'Acción inválida para /api/admin.');
  } catch (error) {
    return sendErr(res, 400, error?.message || 'Error en /api/admin.', error);
  }
}
