import { syncVentasFromTiendanube } from '../../lib/api/core.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    console.log('[api/tiendanube/sync] trigger recibido');
    const data = await syncVentasFromTiendanube();
    console.log('[api/tiendanube/sync] órdenes procesadas', data?.synced || 0);
    console.log('[api/tiendanube/sync] duration total', Date.now() - startedAt);
    return res.status(200).json({
      ok: true,
      data,
      fallback: true,
      meta: {
        source: 'sync_manual',
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    return res.status(400).json({ ok: false, message: String(error?.message || error) });
  }
}
