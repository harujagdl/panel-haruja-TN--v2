import { getVentasDetalle, getVentasResumen } from '../../lib/api/core.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }
  try {
    const month = String(req.query?.month || '').trim();
    const search = String(req.query?.search || '').trim();
    const [resumen, detalle] = await Promise.all([
      getVentasResumen(month),
      getVentasDetalle(month, search),
    ]);
    return res.status(200).json({ ok: true, resumen, detalle });
  } catch (error) {
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  }
}

