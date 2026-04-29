import { syncVentasFromTiendanube } from '../../lib/api/core.js';
import { createTraceId } from '../../lib/observability/logger.js';
import { invalidateVentasFullCache } from '../../lib/ventas/cache.js';
import {
  acquireVentasSyncLock,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

export default async function handler(req, res) {
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId });
  }

  console.log('[ventas-sync-manual] start trace_id=%s', traceId);
  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
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
    if (processed > 0) {
      const touched = Array.isArray(data.months_rebuilt) ? data.months_rebuilt : [];
      if (touched.length) touched.forEach((month) => invalidateVentasFullCache(month));
      else invalidateVentasFullCache();
    }
    return res.status(200).json({ ok: true, ...data, traceId });
  } catch (error) {
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
    });
    return res.status(500).json({ ok: false, code: 'SYNC_MANUAL_ERROR', message: String(error?.message || error), traceId });
  } finally {
    await releaseVentasSyncLock(lockOwnerId);
  }
}
