import { resolveTiendanubeConnection, syncVentasFromTiendanubeIncremental } from '../../lib/api/core.js';
import { createTraceId, logError, logInfo, logWarn } from '../../lib/observability/logger.js';
import { invalidateVentasFullCache } from '../../lib/ventas/cache.js';
import {
  acquireVentasSyncLock,
  readVentasSyncState,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

function isoOrEmpty(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId });
  }

  logInfo('ventas.sync_auto.start', { traceId, result: 'started' });
  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
    logWarn('ventas.sync_auto.skipped', { traceId, result: 'skipped', changed: false, processed: 0, durationMs: Date.now() - startedAt, errorCode: 'SYNC_RUNNING' });
    return res.status(200).json({ ok: true, skipped: true, reason: 'sync_running', traceId });
  }
  const lockOwnerId = String(lock.ownerId || '').trim();

  try {
    const previous = await readVentasSyncState();
    const lastUpdatedAtMax = isoOrEmpty(previous.last_updated_at_max);
    const lastCreatedAtMax = isoOrEmpty(previous.last_created_at_max);
    const connection = await resolveTiendanubeConnection();
    const storeId = connection.storeId;
    const endpoint = '/orders';
    logInfo('ventas.sync_auto.start', {
      traceId,
      result: 'running',
      lastUpdatedAtMax: lastUpdatedAtMax || 'EMPTY',
      lastCreatedAtMax: lastCreatedAtMax || 'EMPTY',
      storeId,
      endpoint,
    });

    const data = await syncVentasFromTiendanubeIncremental({
      updatedAtMin: lastUpdatedAtMax || undefined,
      createdAtMin: lastCreatedAtMax || undefined,
    });
    const processed = Number(data.inserted || 0) + Number(data.updated || 0);
    const changed = processed > 0;

    const now = new Date().toISOString();
    await writeVentasSyncState({
      mode: 'automatico',
      last_sync_at: now,
      last_sync_result: 'ok',
      last_sync_message: changed ? `${processed} órdenes actualizadas` : 'sin cambios',
      last_created_at_max: data.last_created_at_max || lastCreatedAtMax || previous.last_created_at_max || now,
      last_updated_at_max: data.last_updated_at_max || lastUpdatedAtMax || previous.last_updated_at_max || now,
    });

    if (changed) {
      const touched = Array.isArray(data.months_rebuilt) ? data.months_rebuilt : [];
      if (touched.length) touched.forEach((month) => invalidateVentasFullCache(month));
      else invalidateVentasFullCache();
    }
    logInfo('ventas.sync_auto.success', {
      traceId,
      result: 'success',
      changed,
      processed,
      lastUpdatedAtMax: data.last_updated_at_max || lastUpdatedAtMax || previous.last_updated_at_max || now,
      lastCreatedAtMax: data.last_created_at_max || lastCreatedAtMax || previous.last_created_at_max || now,
      durationMs: Date.now() - startedAt,
    });

    const status = await readVentasSyncState();
    return res.status(200).json({
      ok: true,
      changed,
      processed,
      status: {
        last_sync_at: status.last_sync_at || now,
        last_sync_result: status.last_sync_result || 'ok',
        last_sync_message: status.last_sync_message || '',
      },
      traceId,
    });
  } catch (error) {
    const code = String(error?.code || '').trim();
    const detailStatus = Number(error?.details?.status || error?.http_status || 500) || 500;
    const detailEndpoint = String(error?.details?.endpoint || '/orders');
    const detailStoreId = String(error?.details?.store_id || process.env.TIENDANUBE_STORE_ID || '').trim();
    const errorCode = code || 'SYNC_AUTO_ERROR';
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
    });
    logError('ventas.sync_auto.failed', {
      traceId,
      result: 'failed',
      changed: false,
      processed: 0,
      lastUpdatedAtMax: '',
      lastCreatedAtMax: '',
      durationMs: Date.now() - startedAt,
      errorCode,
      tnStatus: detailStatus,
      storeId: detailStoreId,
      endpoint: detailEndpoint,
    });
    const status = await readVentasSyncState();
    if (code === 'TIENDANUBE_NOT_FOUND') {
      return res.status(404).json({
        ok: false,
        code: 'TIENDANUBE_NOT_FOUND',
        message: 'Recurso no encontrado en Tiendanube',
        details: {
          store_id: detailStoreId,
          endpoint: detailEndpoint,
        },
        status: {
          last_sync_at: status.last_sync_at || new Date().toISOString(),
          last_sync_result: status.last_sync_result || 'error',
          last_sync_message: status.last_sync_message || String(error?.message || error),
        },
        preserve_cache: true,
        traceId,
      });
    }
    return res.status(500).json({
      ok: false,
      code: code || 'SYNC_AUTO_ERROR',
      message: String(error?.message || error),
      preserve_cache: true,
      status: {
        last_sync_at: status.last_sync_at || new Date().toISOString(),
        last_sync_result: status.last_sync_result || 'error',
        last_sync_message: status.last_sync_message || String(error?.message || error),
      },
      traceId,
    });
  } finally {
    await releaseVentasSyncLock(lockOwnerId);
  }
}
