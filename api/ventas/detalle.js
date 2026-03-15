import { getDetalleVentas } from '../../lib/ventas/getDetalleVentas.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    const month = String(req.query?.month || '').trim();
    const q = String(req.query?.q || '').trim();
    console.log('[api/ventas/detalle] month', month || '(empty)');
    console.log('[api/ventas/detalle] q', q || '(empty)');
    const data = await getDetalleVentas({ month, q });
    console.log('[api/ventas/detalle] total rows', data.totalRows);
    console.log('[api/ventas/detalle] duration ms', Date.now() - startedAt);
    return res.status(200).json(data);
  } catch (error) {
    console.error('[api/ventas/detalle] error', error);
    return res.status(400).json({ ok: false, message: String(error?.message || error) });
  }
}
