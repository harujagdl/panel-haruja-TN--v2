import { syncVentasFromTiendanube } from '../../lib/api/core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    const data = await syncVentasFromTiendanube();
    return res.status(200).json({ ok: true, data, fallback: true });
  } catch (error) {
    return res.status(400).json({ ok: false, message: String(error?.message || error) });
  }
}
