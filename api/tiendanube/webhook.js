import { fetchTiendanubeOrderById, processTiendanubeWebhook, resolveTiendanubeConnection } from '../../lib/api/core.js';
import { createTraceId, logError, logInfo, logWarn } from '../../lib/observability/logger.js';
import crypto from 'crypto';
import { verifyTiendanubeWebhook } from '../../lib/tiendanube/verifyWebhook.js';
import { invalidateVentasFullCache } from '../../lib/ventas/cache.js';
import { registerWebhookEventAttempt, trackWebhookEventResult } from '../../lib/ventas/dedupeWebhookEvent.js';
import {
  acquireVentasSyncLock,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

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

function getEventId(payload = {}, req = {}) {
  return String(
    req.headers?.['x-tiendanube-event-id']
    || req.headers?.['x-linkedstore-event-id']
    || payload?.event_id
    || payload?.idempotency_key
    || '',
  ).trim();
}

function getEventTimestamp(payload = {}, req = {}) {
  return String(
    req.headers?.['x-tiendanube-event-created-at']
    || req.headers?.['x-linkedstore-event-created-at']
    || payload?.created_at
    || payload?.sent_at
    || '',
  ).trim();
}

async function logWebhookTrace(meta = {}) {
  const { eventKey, orderId, result, reason, errorCode, traceId } = meta;
  console.log('[ventas-webhook] trace event_key=%s order_id=%s result=%s reason=%s error_code=%s trace_id=%s', eventKey || '-', orderId || '-', result || '-', reason || '-', errorCode || '-', traceId || '-');
  try {
    await trackWebhookEventResult({
      eventKey: meta.eventKey,
      eventId: meta.eventId,
      event: meta.event,
      orderId: meta.orderId,
      storeId: meta.storeId,
      bodyHash: meta.bodyHash,
      eventTimestamp: meta.eventTimestamp,
      result: meta.result,
      reason: meta.reason,
      errorCode: meta.errorCode,
      traceId: meta.traceId,
    });
  } catch (error) {
    console.warn('[ventas-webhook] trace_write_failed', String(error?.message || error));
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  let effectiveTraceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.query?.traceId || req?.body?.traceId);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId: effectiveTraceId });
  }

  const secret = String(process.env.TIENDANUBE_APP_SECRET || '').trim();
  const signature = String(req.headers?.['x-linkedstore-hmac-sha256'] || '').trim();
  const receivedAt = new Date().toISOString();
  let lockAcquired = false;
  let lockOwnerId = '';
  let traceMeta = null;
  logInfo('ventas.webhook.received', { traceId: effectiveTraceId, result: 'received' });

  try {
    const rawBody = await readRawBody(req);
    const bodyHash = crypto.createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
    effectiveTraceId = createTraceId(effectiveTraceId || `tnwh-${bodyHash.slice(0, 12)}`);
    if (!verifyTiendanubeWebhook(rawBody, signature, secret)) {
      logWarn('ventas.webhook.failed', { traceId: effectiveTraceId, result: 'failed', reason: 'signature_validation_failed', durationMs: Date.now() - startedAt, errorCode: 'INVALID_SIGNATURE' });
      await logWebhookTrace({
        bodyHash,
        traceId: effectiveTraceId,
        result: 'invalid_signature',
        reason: 'signature_validation_failed',
        errorCode: 'INVALID_SIGNATURE',
      });
      return res.status(401).json({
        ok: false,
        code: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Firma inválida.',
        traceId: effectiveTraceId,
      });
    }

    const payload = JSON.parse(rawBody || '{}');
    const connection = await resolveTiendanubeConnection();
    const resolvedStoreId = String(connection?.storeId || '').trim();
    const storeId = getStoreId(payload, req);
    if (storeId && resolvedStoreId && storeId !== resolvedStoreId) {
      logInfo('ventas.webhook.ignored', { traceId: effectiveTraceId, event: 'store_mismatch', storeId: resolvedStoreId, orderId: '-', result: 'ignored', reason: 'store_mismatch', durationMs: Date.now() - startedAt });
      return res.status(200).json({ ok: true, ignored: 'store_mismatch', traceId: effectiveTraceId });
    }

    const event = String(req.headers?.['x-tiendanube-event'] || req.headers?.['x-linkedstore-topic'] || payload?.event || payload?.topic || '').trim().toLowerCase();
    const orderId = String(payload?.id || payload?.order_id || payload?.resource_id || payload?.order?.id || '').trim();
    const eventId = getEventId(payload, req);
    const eventTimestamp = getEventTimestamp(payload, req);
    const dedupe = await registerWebhookEventAttempt({
      source: 'tiendanube',
      event,
      orderId,
      storeId: resolvedStoreId || storeId,
      eventId,
      bodyHash,
      eventTimestamp,
    });
    traceMeta = {
      eventKey: dedupe.eventKey,
      eventId,
      event,
      orderId,
      storeId: resolvedStoreId || storeId,
      bodyHash: dedupe.bodyHash || bodyHash,
      eventTimestamp,
      traceId: effectiveTraceId,
    };

    if (dedupe.duplicated) {
      logInfo('ventas.webhook.duplicate', { traceId: effectiveTraceId, eventKey: dedupe.eventKey, event, orderId: orderId || '-', storeId: resolvedStoreId || storeId, result: 'duplicate_ignored', reason: 'duplicate_event_key_recent', durationMs: Date.now() - startedAt });
      await logWebhookTrace({
        ...traceMeta,
        result: 'duplicate_ignored',
        reason: 'duplicate_event_key_recent',
      });
      return res.status(200).json({ ok: true, result: 'duplicate_ignored', traceId: effectiveTraceId });
    }

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
      logInfo('ventas.webhook.ignored', { traceId: effectiveTraceId, eventKey: dedupe.eventKey, event, orderId: '-', storeId: resolvedStoreId || storeId, result: 'ignored', reason: 'missing_order_id', durationMs: Date.now() - startedAt });
      await logWebhookTrace({
        ...traceMeta,
        result: 'no_relevant_change',
        reason: 'missing_order_id',
      });
      return res.status(200).json({ ok: true, result: 'no_relevant_change', traceId: effectiveTraceId });
    }

    const lock = await acquireVentasSyncLock();
    if (!lock.acquired) {
      logInfo('ventas.webhook.duplicate', { traceId: effectiveTraceId, eventKey: dedupe.eventKey, event, orderId: orderId || '-', storeId: resolvedStoreId || storeId, result: 'duplicate_ignored', reason: 'sync_running_lock_active', durationMs: Date.now() - startedAt });
      await logWebhookTrace({
        ...traceMeta,
        result: 'duplicate_ignored',
        reason: 'sync_running_lock_active',
      });
      return res.status(200).json({ ok: true, skipped: true, reason: 'sync_running', traceId: effectiveTraceId });
    }
    lockAcquired = true;
    lockOwnerId = String(lock.ownerId || '').trim();

    const enrichedPayload = { ...payload };
    if (!enrichedPayload.order && resolvedStoreId && connection?.accessToken) {
      try {
        enrichedPayload.order = await fetchTiendanubeOrderById(resolvedStoreId, connection.accessToken, orderId);
      } catch (error) {
        await logWebhookTrace({
          ...traceMeta,
          result: 'fetch_failed',
          reason: String(error?.message || error),
        });
        throw new Error(`fetch_failed:${String(error?.message || error)}`);
      }
    }

    const result = await processTiendanubeWebhook(enrichedPayload, req);
    const orderName = extractOrderName(enrichedPayload, orderId);
    const processedAt = new Date().toISOString();
    const webhookResult = result?.action === 'no_relevant_change' ? 'no_relevant_change' : 'processed';

    await writeVentasSyncState({
      last_order_processed_at: processedAt,
      last_order_id: orderId,
      last_order_name: orderName,
      last_sync_at: processedAt,
      last_sync_result: 'ok',
      last_sync_message: webhookResult === 'processed' ? 'webhook procesado' : 'webhook sin cambios relevantes',
      last_created_at_max: processedAt,
      last_updated_at_max: processedAt,
    });
    if (webhookResult === 'processed') invalidateVentasFullCache(result.month_key);
    await logWebhookTrace({
      ...traceMeta,
      result: webhookResult,
      reason: result?.action || 'upsert_ok',
    });
    logInfo('ventas.webhook.success', { traceId: effectiveTraceId, eventKey: dedupe.eventKey, event, orderId: orderId || '-', storeId: resolvedStoreId || storeId, result: webhookResult, reason: result?.action || 'upsert_ok', durationMs: Date.now() - startedAt });
    await releaseVentasSyncLock(lockOwnerId);
    lockAcquired = false;

    return res.status(200).json({ ok: true, result: webhookResult, ...result, traceId: effectiveTraceId });
  } catch (error) {
    const message = String(error?.message || error);
    const isFetchFailed = message.startsWith('fetch_failed:');
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: message,
    });
    await logWebhookTrace({
      ...(traceMeta || {}),
      result: isFetchFailed ? 'fetch_failed' : 'error',
      reason: message,
    });
    logError('ventas.webhook.failed', { traceId: effectiveTraceId, eventKey: traceMeta?.eventKey, event: traceMeta?.event || '-', orderId: traceMeta?.orderId || '-', storeId: traceMeta?.storeId || '-', result: isFetchFailed ? 'fetch_failed' : 'failed', reason: message, durationMs: Date.now() - startedAt, errorCode: 'WEBHOOK_ERROR' });
    if (lockAcquired) await releaseVentasSyncLock(lockOwnerId);
    return res.status(500).json({
      ok: false,
      code: 'WEBHOOK_ERROR',
      result: isFetchFailed ? 'fetch_failed' : 'error',
      message,
      traceId: effectiveTraceId,
    });
  }
}
