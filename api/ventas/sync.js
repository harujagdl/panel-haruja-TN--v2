import { syncVentasFromTiendanube } from '../../lib/api/core.js';
import { createTraceId, logError, logInfo, logWarn } from '../../lib/observability/logger.js';
import { invalidateVentasFullCache } from '../../lib/ventas/cache.js';
import { invalidateMemoryCache } from '../../lib/api/memoryCache.js';
import {
  acquireVentasSyncLock,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId });
  }

  logInfo('ventas.sync.start', { traceId, result: 'started' });
  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
    logWarn('ventas.sync.skipped', { traceId, result: 'skipped', reason: 'sync_running', durationMs: Date.now() - startedAt });
    return res.status(200).json({ ok: true, skipped: true, reason: 'sync_running', traceId });
  }
  const lockOwnerId = String(lock.ownerId || '').trim();

  try {
    const data = await syncVentasFromTiendanube();
    const now = new Date().toISOString();
    await writeVentasSyncState({
      mode: 'automatico',
      last_sync_at: now,
      last_sync_result: 'ok',
      last_sync_message: 'sincronizacion manual ejecutada',
      last_created_at_max: now,
      last_updated_at_max: now,
    });
    const processed = Number(data?.inserted || 0) + Number(data?.updated || 0);
    const inserted = Number(data?.inserted || 0);
    const updated = Number(data?.updated || 0);
    const monthsRebuilt = Array.isArray(data?.months_rebuilt) ? data.months_rebuilt.length : 0;
    if (processed > 0) {
      const touched = Array.isArray(data.months_rebuilt) ? data.months_rebuilt : [];
      if (touched.length) touched.forEach((month) => invalidateVentasFullCache(month));
      else invalidateVentasFullCache();
      const store = globalThis.__apiMemoryCacheStore;
      if (store) {
        [...store.keys()].forEach((key) => {
          if (String(key || '').startsWith('api:ventas-')) invalidateMemoryCache(key);
        });
      }
    }
    logInfo('ventas.sync.success', { traceId, result: 'success', processed, inserted, updated, monthsRebuilt, durationMs: Date.now() - startedAt });
    return res.status(200).json({ ok: true, ...data, traceId });
  } catch (error) {
    const errorCode = String(error?.code || 'SYNC_MANUAL_ERROR');
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
    });
    logError('ventas.sync.failed', { traceId, result: 'failed', processed: 0, inserted: 0, updated: 0, monthsRebuilt: 0, durationMs: Date.now() - startedAt, errorCode });
    return res.status(500).json({ ok: false, code: 'SYNC_MANUAL_ERROR', message: String(error?.message || error), traceId });
  } finally {
    await releaseVentasSyncLock(lockOwnerId);
  }
}
