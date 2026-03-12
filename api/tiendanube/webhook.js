import { processTiendanubeWebhook } from '../../lib/api/core.js';

function badRequest(res, message) {
  return res.status(400).json({ ok: false, message });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return badRequest(res, 'Body inválido o ausente.');
  }

  const event = String(req.headers?.['x-tiendanube-event'] || req.headers?.['x-linkedstore-topic'] || body.event || body.topic || '').trim();
  if (!event) {
    return badRequest(res, 'Evento de webhook ausente.');
  }

  const orderId = String(body?.order?.id || body?.id || body?.order_id || body?.resource_id || '').trim();
  if (!orderId && event.toLowerCase().startsWith('order/')) {
    return badRequest(res, 'order_id ausente en webhook de orden.');
  }

  try {
    const result = await processTiendanubeWebhook(body, req);
    if (!result.ignored) {
      console.log('[tiendanube:webhook]', {
        event: result.event,
        order_id: result.order_id,
        month_key: result.month_key,
        action: result.action,
      });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    const message = String(err?.message || 'Error procesando webhook de Tiendanube.');
    console.error('[tiendanube:webhook:error]', { event, order_id: orderId, message });
    return badRequest(res, message);
  }
}
