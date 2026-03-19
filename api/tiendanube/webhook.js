import { fetchTiendanubeOrderById, getVentasConfig, processTiendanubeWebhook } from '../../lib/api/core.js';
import { verifyTiendanubeWebhook } from '../../lib/tiendanube/verifyWebhook.js';
import { writeVentasSyncState } from '../../lib/ventas/syncState.js';

const FIXED_STORE_ID = '6432936';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function getStoreId(payload = {}, req = {}) {
  return String(
    payload?.store_id
    || payload?.storeId
    || req.headers?.['x-linkedstore-id']
    || req.headers?.['x-tiendanube-store-id']
    || '',
  ).trim();
}

function extractOrderName(payload = {}, fallbackOrderId = '') {
  const rawOrder = payload?.order || {};
  const numberValue = rawOrder?.number ?? rawOrder?.order_number ?? payload?.number;
  if (numberValue !== undefined && numberValue !== null && String(numberValue).trim()) {
    const clean = String(numberValue).trim().replace(/^#/, '');
    return `#${clean}`;
  }
  return fallbackOrderId ? `#${fallbackOrderId}` : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const secret = String(process.env.TIENDANUBE_APP_SECRET || '').trim();
  const signature = String(req.headers?.['x-linkedstore-hmac-sha256'] || '').trim();
  const receivedAt = new Date().toISOString();

  try {
    const rawBody = await readRawBody(req);
    if (!verifyTiendanubeWebhook(rawBody, signature, secret)) {
      return res.status(401).json({ ok: false, message: 'Firma inválida.' });
    }

    const payload = JSON.parse(rawBody || '{}');
    const storeId = getStoreId(payload, req);
    if (storeId && storeId !== FIXED_STORE_ID) {
      return res.status(200).json({ ok: true, ignored: 'store_mismatch' });
    }

    const event = String(req.headers?.['x-tiendanube-event'] || req.headers?.['x-linkedstore-topic'] || payload?.event || payload?.topic || '').trim().toLowerCase();
    const orderId = String(payload?.id || payload?.order_id || payload?.resource_id || payload?.order?.id || '').trim();

    await writeVentasSyncState({
      mode: 'automatico',
      last_event_received_at: receivedAt,
      last_event_type: event,
    });

    if (!orderId) {
      await writeVentasSyncState({
        last_sync_at: new Date().toISOString(),
        last_sync_result: 'ok',
        last_sync_message: 'webhook sin order_id',
      });
      return res.status(200).json({ ok: true, ignored: 'missing_order_id' });
    }

    const configVentas = await getVentasConfig();
    const enrichedPayload = { ...payload };
    if (!enrichedPayload.order && configVentas?.store_id && configVentas?.access_token) {
      enrichedPayload.order = await fetchTiendanubeOrderById(configVentas.store_id, configVentas.access_token, orderId);
    }

    const result = await processTiendanubeWebhook(enrichedPayload, req);
    const orderName = extractOrderName(enrichedPayload, orderId);
    const processedAt = new Date().toISOString();

    await writeVentasSyncState({
      last_order_processed_at: processedAt,
      last_order_id: orderId,
      last_order_name: orderName,
      last_sync_at: processedAt,
      last_sync_result: 'ok',
      last_sync_message: 'webhook procesado',
      last_created_at_max: processedAt,
      last_updated_at_max: processedAt,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
    });
    return res.status(500).json({ ok: false, message: String(error?.message || error) });
  }
}

