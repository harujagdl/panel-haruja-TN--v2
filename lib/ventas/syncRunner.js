import { syncVentasFromTiendanube } from './tiendanubeSync.js';
import { invalidateMemoryCache } from '../api/memoryCache.js';
import { logError, logInfo, logWarn } from '../observability/logger.js';
import { invalidateVentasFullCache } from './cache.js';
import {
  acquireVentasSyncLock,
  readVentasSyncStateSafe,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from './syncState.js';

const RECENT_SUCCESS_COOLDOWN_MS = 2 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
const ventasSyncLocks = globalThis.__ventasSyncLocks || (globalThis.__ventasSyncLocks = new Map());
const ventasSyncQuotaPause = globalThis.__ventasSyncQuotaPause || (globalThis.__ventasSyncQuotaPause = new Map());

const QUOTA_MESSAGE = 'Google Sheets está limitando temporalmente las lecturas. Espera 2-5 minutos y vuelve a intentar.';

function isSheetsQuotaError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status || error?.details?.status || 0);
  return status === 429
    || code.includes('quota')
    || code.includes('resource_exhausted')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('resource_exhausted');
}

function parseDateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildCachedResponse(state = {}, reason = 'recent_success') {
  return {
    ok: true,
    status: 'cached',
    skipped: true,
    reason,
    message: 'Ya hay una sincronización exitosa reciente; se usa el estado cacheado para proteger la cuota de Google Sheets.',
    last_sync_at: String(state?.last_sync_at || '').trim() || null,
    last_sync_result: String(state?.last_sync_result || '').trim() || null,
    last_sync_message: String(state?.last_sync_message || '').trim() || null,
  };
}

function invalidateVentasApiCaches(months = []) {
  const touched = Array.isArray(months) ? months.filter(Boolean) : [];
  if (touched.length) {
    touched.forEach((month) => {
      try {
        invalidateVentasFullCache(month);
      } catch (error) {
        console.error('[ventas.cache.invalidate.failed]', { message: error?.message || '' });
      }
    });
  } else {
    try {
      invalidateVentasFullCache();
    } catch (error) {
      console.error('[ventas.cache.invalidate.failed]', { message: error?.message || '' });
    }
  }

  const store = globalThis.__apiMemoryCacheStore;
  if (store) {
    [...store.keys()].forEach((key) => {
      if (String(key || '').startsWith('api:ventas-')) invalidateMemoryCache(key);
    });
  }
}

export function getVentasSyncQuotaMessage() {
  return QUOTA_MESSAGE;
}

export async function runVentasPublicSync({ traceId = '', source = 'public' } = {}) {
  const startedAt = Date.now();
  const lockKey = 'ventas-sync';
  if (ventasSyncLocks.get(lockKey)) {
    logWarn('ventas.sync.skipped', { traceId, result: 'skipped', reason: 'sync_running', source });
    return { ok: true, status: 'running', skipped: true, reason: 'sync_running', message: 'Sincronización en curso', traceId };
  }

  const pausedUntil = Number(ventasSyncQuotaPause.get(lockKey) || 0);
  if (pausedUntil > Date.now()) {
    return {
      ok: true,
      status: 'paused',
      skipped: true,
      reason: 'sheets_quota_cooldown',
      message: QUOTA_MESSAGE,
      retryAfterMs: pausedUntil - Date.now(),
      traceId,
    };
  }

  const previous = await readVentasSyncStateSafe();
  const lastSyncMs = parseDateMs(previous?.last_sync_at);
  const lastResult = String(previous?.last_sync_result || '').trim().toLowerCase();
  if (lastSyncMs && Date.now() - lastSyncMs < RECENT_SUCCESS_COOLDOWN_MS && (lastResult.includes('ok') || lastResult.includes('success'))) {
    return { ...buildCachedResponse(previous), traceId };
  }

  ventasSyncLocks.set(lockKey, { traceId, startedAt });
  logInfo('ventas.sync.start', { traceId, result: 'started', source });

  let lockOwnerId = '';
  try {
    const sheetLock = await acquireVentasSyncLock();
    if (!sheetLock.acquired) {
      ventasSyncLocks.delete(lockKey);
      logWarn('ventas.sync.skipped', { traceId, result: 'skipped', reason: 'sync_running', source, durationMs: Date.now() - startedAt });
      return { ok: true, status: 'running', skipped: true, reason: 'sync_running', message: 'Sincronización en curso', traceId };
    }

    lockOwnerId = String(sheetLock.ownerId || '').trim();
    const data = await syncVentasFromTiendanube({ traceId });
    const now = new Date().toISOString();
    const processed = Number(data?.inserted || 0) + Number(data?.updated || 0);
    const inserted = Number(data?.inserted || 0);
    const updated = Number(data?.updated || 0);
    const monthsRebuilt = Array.isArray(data?.months_rebuilt) ? data.months_rebuilt : [];

    await writeVentasSyncState({
      mode: source,
      last_sync_at: now,
      last_sync_result: 'ok',
      last_sync_message: processed > 0 ? `${processed} órdenes actualizadas` : 'sin cambios',
      last_created_at_max: now,
      last_updated_at_max: now,
    });

    if (processed > 0) invalidateVentasApiCaches(monthsRebuilt);
    ventasSyncQuotaPause.delete(lockKey);
    logInfo('ventas.sync.success', { traceId, result: 'success', processed, inserted, updated, monthsRebuilt: monthsRebuilt.length, source, durationMs: Date.now() - startedAt });
    return { ok: true, status: 'ok', ...data, processed, traceId };
  } catch (error) {
    const errorMessage = String(error?.message || error || 'Unknown sync error');
    const quota = isSheetsQuotaError(error);
    if (quota) ventasSyncQuotaPause.set(lockKey, Date.now() + QUOTA_COOLDOWN_MS);
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: quota ? QUOTA_MESSAGE : errorMessage,
    }).catch(() => {});
    logError('ventas.sync.failed', {
      traceId,
      result: 'failed',
      source,
      durationMs: Date.now() - startedAt,
      errorCode: quota ? 'SHEETS_QUOTA_EXCEEDED' : String(error?.code || 'SYNC_ERROR'),
      errorMessage,
      stack: error?.stack || '',
      details: error?.details || null,
    });
    if (quota) {
      return {
        ok: true,
        status: 'paused',
        skipped: true,
        reason: 'sheets_quota_cooldown',
        message: QUOTA_MESSAGE,
        retryAfterMs: QUOTA_COOLDOWN_MS,
        traceId,
      };
    }
    throw error;
  } finally {
    ventasSyncLocks.delete(lockKey);
    await releaseVentasSyncLock(lockOwnerId).catch(() => {});
  }
}
