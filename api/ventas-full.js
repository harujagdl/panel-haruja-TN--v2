import { getVentasFullData, getVentasFullStale } from '../lib/ventas/full.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const mes = String(req.query?.mes || req.query?.month || '').trim();
  const debug = String(req.query?.debug || '').trim() === '1';
  try {
    const payload = await getVentasFullData(mes, { debug });
    return res.status(200).json(payload);
  } catch (error) {
    const stale = getVentasFullStale(mes);
    if (stale) {
      return res.status(200).json({
        ...stale,
        stale: true,
        stale_message: 'Mostrando última información disponible',
      });
    }
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  }
}
