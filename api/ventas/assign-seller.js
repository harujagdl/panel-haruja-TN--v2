import { assignVentaSeller } from '../../lib/api/core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }
  try {
    const data = await assignVentaSeller(req.body || {});
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    return res.status(400).json({ ok: false, message: String(error?.message || error) });
  }
}
