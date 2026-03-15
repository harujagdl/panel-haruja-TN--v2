import { fetchOrderById } from '../../lib/tiendanube/client.js';
import { parseTiendanubeWebhook } from '../../lib/tiendanube/parseWebhook.js';
import { verifyTiendanubeWebhook } from '../../lib/tiendanube/verifyWebhook.js';
import { dedupeWebhookEvent } from '../../lib/ventas/dedupeWebhookEvent.js';
import { mapOrderToVenta } from '../../lib/ventas/mapOrderToVenta.js';
import { recalculateCommission } from '../../lib/ventas/recalculateCommission.js';
import { recalculateMetaVsVenta } from '../../lib/ventas/recalculateMetaVsVenta.js';
import { recalculateResumenMensual } from '../../lib/ventas/recalculateResumenMensual.js';
import { upsertVenta } from '../../lib/ventas/upsertVenta.js';

const FIXED_STORE_ID = '6432936';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const secret = String(process.env.TIENDANUBE_APP_SECRET || '').trim();
  const signature = String(req.headers?.['x-linkedstore-hmac-sha256'] || '').trim();

  try {
    const rawBody = await readRawBody(req);

    if (!verifyTiendanubeWebhook(rawBody, signature, secret)) {
      console.error('[tiendanube:webhook] firma inválida');
      return res.status(401).json({ ok: false, error: 'invalid_signature' });
    }

    const payload = JSON.parse(rawBody || '{}');
    const parsed = parseTiendanubeWebhook(payload, req.headers || {});

    if (!parsed.storeId || parsed.storeId !== FIXED_STORE_ID) {
      console.log('[tiendanube:webhook] store inválido/ignorado', { receivedStoreId: parsed.storeId || null, expectedStoreId: FIXED_STORE_ID });
      return res.status(200).json({ ok: true, ignored: 'store_mismatch' });
    }

    if (!parsed.orderId) {
      console.log('[tiendanube:webhook] orderId faltante', { event: parsed.event });
      return res.status(200).json({ ok: true, ignored: 'missing_order_id' });
    }

    const dedupe = await dedupeWebhookEvent({
      event: parsed.event,
      orderId: parsed.orderId,
      storeId: parsed.storeId,
      rawBody,
      status: 'received',
    });

    if (dedupe.duplicated) {
      console.log('[tiendanube:webhook] evento duplicado', { event: parsed.event, orderId: parsed.orderId });
      return res.status(200).json({ ok: true, ignored: 'duplicate_event' });
    }

    let order;
    try {
      order = await fetchOrderById(parsed.orderId);
    } catch (error) {
      console.error('[tiendanube:webhook] error API', { orderId: parsed.orderId, message: String(error?.message || error) });
      throw error;
    }

    const venta = mapOrderToVenta(order);
    const upsertResult = await upsertVenta(venta, { event: parsed.event });

    if (upsertResult.stale) {
      console.log('[tiendanube:webhook] evento viejo', { event: parsed.event, orderId: parsed.orderId });
      return res.status(200).json({ ok: true, ignored: 'old_event' });
    }

    await recalculateCommission(venta.orderId);
    const monthKey = String(upsertResult?.venta?.month_key || '').trim();
    if (monthKey) {
      await recalculateResumenMensual(monthKey);
      await recalculateMetaVsVenta(monthKey);
    }

    console.log('[tiendanube:webhook] recalculo exitoso', { event: parsed.event, orderId: parsed.orderId, action: upsertResult.action });

    return res.status(200).json({
      ok: true,
      event: parsed.event,
      orderId: parsed.orderId,
      action: upsertResult.action,
    });
  } catch (error) {
    console.error('[tiendanube:webhook] webhook_processing_error', {
      message: String(error?.message || error),
    });
    return res.status(500).json({ ok: false, error: 'webhook_processing_error' });
  }
}
