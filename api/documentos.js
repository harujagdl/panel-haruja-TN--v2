import { getPdfStatus, getPreviewData, getPrintData, getTicketByFolio, refreshPdf } from '../lib/api/documentos.js';

const GET_ACTIONS = new Set(['ticket', 'pdf-status', 'print-data', 'preview']);
const POST_ACTIONS = new Set(['pdf-refresh']);

const sendOk = (res, data) => res.status(200).json({ ok: true, data });
const sendErr = (res, status, message, error) => res.status(status).json({ ok: false, message, ...(error ? { error } : {}) });

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  if (!['GET', 'POST'].includes(req.method || '')) return sendErr(res, 405, 'Method not allowed.');
  if (req.method === 'GET' && !GET_ACTIONS.has(action)) return sendErr(res, POST_ACTIONS.has(action) ? 405 : 400, 'Acción inválida para método GET.');
  if (req.method === 'POST' && !POST_ACTIONS.has(action)) return sendErr(res, GET_ACTIONS.has(action) ? 405 : 400, 'Acción inválida para método POST.');

  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  if (!folio) return sendErr(res, 400, 'folio es obligatorio.');

  try {
    if (req.method === 'GET' && action === 'ticket') {
      const result = await getTicketByFolio(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'GET' && action === 'pdf-status') {
      const result = await getPdfStatus(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'GET' && action === 'print-data') {
      const result = await getPrintData(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'GET' && action === 'preview') {
      const result = await getPreviewData(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (req.method === 'POST' && action === 'pdf-refresh') {
      const result = await refreshPdf(folio, req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    return sendErr(res, 400, 'Acción inválida para /api/documentos.');
  } catch (error) {
    return sendErr(res, 500, error?.message || 'Error en /api/documentos.');
  }
}
