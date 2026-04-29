import {
  addAbono,
  cancelApartado,
  createApartado,
  getApartadoDetail,
  getHistorialApartado,
  getNextFolio,
  getApartadosMissingPdf,
  listApartados,
  regenerateApartadoPdf,
  searchApartados,
  updateApartadoStatus,
} from '../lib/api/apartados.js';
import { getPdfStatus, getPreviewData, getPrintData, getTicketByFolio, refreshPdf } from '../lib/api/documentos.js';
import { runApartadoPdfDriveWriteTest } from '../lib/apartados/pdf-sync.js';
import { ADMIN_SESSION_REQUIRED_MESSAGE, requireAdminSession } from './core.js';
import { createTraceId } from '../lib/observability/logger.js';

const jsonOk = (res, data, traceId = '') => res.status(200).json({ ok: true, data, ...(traceId ? { traceId } : {}) });
const jsonErr = (res, status, message, traceId = '') => res.status(status).json({ ok: false, message, ...(traceId ? { traceId } : {}) });
const readTraceFromRequest = (req = {}) =>
  createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);

export default async function handler(req, res) {
  const traceId = readTraceFromRequest(req);
  const action = String(req.query?.action || '').trim();
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  const requiresAdmin = new Set([
    'apartados-missing-pdf',
    'apartados-update-status',
    'apartados-pdf-refresh',
    'apartados-cancel',
    'apartados-pdf-drive-test',
    'ticket-pdf-refresh',
  ]);

  if (!action) return jsonErr(res, 400, 'action es obligatorio.', traceId);
  if (requiresAdmin.has(action) && !requireAdminSession(req, res, {
    logDenied: `[admin-session] legacy /api/sheets denied action=${action}`,
    touchActivity: true,
    reason: `legacy-sheets-${action}`,
  })) {
    return res.status(401).json({
      ok: false,
      code: 'ADMIN_SESSION_REQUIRED',
      message: ADMIN_SESSION_REQUIRED_MESSAGE,
      traceId,
    });
  }

  try {
    if (action === 'apartados-next') return jsonOk(res, await getNextFolio(req.query?.fecha || req.body?.fecha || ''), traceId);
    if (action === 'apartados-list') return jsonOk(res, await listApartados(req.query || {}), traceId);
    if (action === 'apartados-search') return jsonOk(res, await searchApartados(req.query || {}), traceId);
    if (action === 'apartados-missing-pdf') {
      const result = await getApartadosMissingPdf(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }
    if (action === 'apartados-create') return jsonOk(res, await createApartado(req.body || {}), traceId);
    if (action === 'apartados-abono') return jsonOk(res, await addAbono(req.body || {}), traceId);

    if (action === 'apartados-detail') {
      if (!folio) return jsonErr(res, 400, 'folio es obligatorio.', traceId);
      const result = await getApartadoDetail(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    if (action === 'apartados-historial') {
      if (!folio) return jsonErr(res, 400, 'folio es obligatorio.', traceId);
      const result = await getHistorialApartado(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    if (action === 'apartados-update-status') {
      const result = await updateApartadoStatus(req.body || {});
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    if (action === 'apartados-pdf-refresh') {
      if (!folio) return jsonErr(res, 400, 'folio es obligatorio.', traceId);
      const result = await regenerateApartadoPdf(folio, req.body || {});
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    if (action === 'apartados-cancel') {
      const result = await cancelApartado(req.body || {});
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    if (!folio && action.startsWith('ticket-')) return jsonErr(res, 400, 'folio es obligatorio.', traceId);

    if (action === 'ticket') {
      const result = await getTicketByFolio(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }
    if (action === 'ticket-pdf-status') {
      const result = await getPdfStatus(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }
    if (action === 'ticket-print-data') {
      const result = await getPrintData(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }
    if (action === 'ticket-preview') {
      const result = await getPreviewData(folio);
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }
    if (action === 'apartados-pdf-drive-test') {
      const result = await runApartadoPdfDriveWriteTest();
      if (!result?.ok) return jsonErr(res, 502, result?.error || 'No se pudo guardar el PDF en Drive.', traceId);
      return jsonOk(res, result, traceId);
    }
    if (action === 'ticket-pdf-refresh') {
      const result = await refreshPdf(folio, req.body || {});
      if (result?.status) return res.status(result.status).json({ ...(result.body || {}), traceId });
      return jsonOk(res, result, traceId);
    }

    return jsonErr(res, 400, 'action inválida para /api/sheets.', traceId);
  } catch (error) {
    return jsonErr(res, 500, error?.message || 'Error en /api/sheets.', traceId);
  }
}
