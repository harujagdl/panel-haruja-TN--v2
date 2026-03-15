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
import { getPdfStatus, getPreviewData, getPrintData, getTicketByFolio, refreshPdf } from '../lib/api/documentos.js';

const jsonOk = (res, data) => res.status(200).json({ ok: true, data });
const jsonErr = (res, status, message) => res.status(status).json({ ok: false, message });

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  const folio = String(req.query?.folio || req.body?.folio || '').trim();

  if (!action) return jsonErr(res, 400, 'action es obligatorio.');

  try {
    if (action === 'apartados-next') return jsonOk(res, await getNextFolio());
    if (action === 'apartados-list') return jsonOk(res, await listApartados());
    if (action === 'apartados-search') return jsonOk(res, await searchApartados(req.query || {}));
    if (action === 'apartados-create') return jsonOk(res, await createApartado(req.body || {}));
    if (action === 'apartados-abono') return jsonOk(res, await addAbono(req.body || {}));

    if (action === 'apartados-detail') {
      if (!folio) return jsonErr(res, 400, 'folio es obligatorio.');
      const result = await getApartadoDetail(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }

    if (action === 'apartados-historial') {
      if (!folio) return jsonErr(res, 400, 'folio es obligatorio.');
      const result = await getHistorialApartado(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }

    if (action === 'apartados-update-status') {
      const result = await updateApartadoStatus(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }

    if (action === 'apartados-cancel') {
      const result = await cancelApartado(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }

    if (!folio && action.startsWith('ticket-')) return jsonErr(res, 400, 'folio es obligatorio.');

    if (action === 'ticket') {
      const result = await getTicketByFolio(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }
    if (action === 'ticket-pdf-status') {
      const result = await getPdfStatus(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }
    if (action === 'ticket-print-data') {
      const result = await getPrintData(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }
    if (action === 'ticket-preview') {
      const result = await getPreviewData(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }
    if (action === 'ticket-pdf-refresh') {
      const result = await refreshPdf(folio, req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return jsonOk(res, result);
    }

    return jsonErr(res, 400, 'action inválida para /api/sheets.');
  } catch (error) {
    return jsonErr(res, 500, error?.message || 'Error en /api/sheets.');
  }
}
