import { getVentasDetalle, getVentasResumen } from '../../lib/api/core.js';

const EMPTY_RESUMEN = {
  ok: true,
  total_mes: 0,
  total_haru: 0,
  total_vendedora: 0,
  sin_asignar: 0,
  orders_count: 0,
  ticket_promedio: 0,
  message: 'Sin ventas para el periodo',
};

function buildTraceId() {
  return `ventas-mini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDataAbsenceError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return [
    'no existe',
    'not found',
    'encabezados',
    'header',
    'sin datos',
    'empty',
    'no tiene',
  ].some((token) => msg.includes(token));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }
  const traceId = buildTraceId();
  try {
    const month = String(req.query?.month || '').trim();
    const search = String(req.query?.search || '').trim();
    const resumen = await getVentasResumen(month).catch((error) => {
      if (!isDataAbsenceError(error)) throw error;
      console.warn('[ventas:index:resumen:fallback]', { traceId, month, error: String(error?.message || error) });
      return { ...EMPTY_RESUMEN };
    });
    const detalle = await getVentasDetalle(month, search).catch((error) => {
      if (!isDataAbsenceError(error)) throw error;
      console.warn('[ventas:index:detalle:fallback]', { traceId, month, error: String(error?.message || error) });
      return [];
    });
    return res.status(200).json({ ok: true, resumen, detalle });
  } catch (error) {
    console.error('[ventas:index:error]', { traceId, error: String(error?.message || error) });
    if (isDataAbsenceError(error)) {
      return res.status(200).json({ ok: true, resumen: { ...EMPTY_RESUMEN }, detalle: [], traceId });
    }
    return res.status(500).json({ ok: false, message: String(error?.message || error), traceId });
  }
}
