import { getWebhookStatus } from '../../lib/tiendanube/getWebhookStatus.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  try {
    console.log('[api/tiendanube/status] start');
    const data = await getWebhookStatus();
    console.log('[api/tiendanube/status] db read ok');
    console.log('[api/tiendanube/status] result summary', {
      lastEvent: data.lastEvent,
      lastOrder: data.lastOrder,
      durationMs: Date.now() - startedAt,
    });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[api/tiendanube/status] error', error);
    return res.status(200).json({
      ok: true,
      mode: 'automatico',
      lastEvent: null,
      lastOrder: null,
      lastSyncAt: null,
      meta: {
        source: 'fallback',
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
