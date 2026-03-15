import { getResumenMensual } from '../../lib/ventas/getResumenMensual.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    const month = String(req.query?.month || '').trim();
    console.log('[api/ventas/resumen] month recibido', month || '(empty)');
    const data = await getResumenMensual(month);
    console.log('[api/ventas/resumen] fuente de datos', data?.meta?.source || 'unknown');
    console.log('[api/ventas/resumen] duration ms', Date.now() - startedAt);
    console.log('[api/ventas/resumen] total ventas count', data?.ventasCount || 0);
    return res.status(200).json(data);
  } catch (error) {
    console.error('[api/ventas/resumen] error', error);
    return res.status(400).json({ ok: false, message: String(error?.message || error) });
  }
}
