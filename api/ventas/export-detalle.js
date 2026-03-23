import { buildVentasDetalleExport } from '../../lib/ventas/detalleExport.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    const ventas = Array.isArray(req.body?.ventas) ? req.body.ventas : [];
    const payload = await buildVentasDetalleExport({ ventas });
    const status = payload?.ok ? 200 : (payload?.code === 'SHEETS_QUOTA_EXCEEDED' ? 429 : 400);
    return res.status(status).json(payload);
  } catch (error) {
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  }
}
