import { getVentasConfig, syncVentasFromTiendanube } from '../../lib/api/core.js';
import { createSheetsClient, getSpreadsheetMetadata } from '../../lib/google/sheetsClient.js';
import { createTraceId, logError, logInfo, logWarn } from '../../lib/observability/logger.js';
import { invalidateVentasFullCache } from '../../lib/ventas/cache.js';
import { invalidateMemoryCache } from '../../lib/api/memoryCache.js';
import { ADMIN_SESSION_REQUIRED_MESSAGE, requireAdminSession } from '../core.js';
import {
  acquireVentasSyncLock,
  readVentasSyncStateSafe,
  releaseVentasSyncLock,
  writeVentasSyncState,
} from '../../lib/ventas/syncState.js';

function getVentasSpreadsheetId() {
  return String(
    process.env.VENTAS_SHEET_ID
    || process.env.GOOGLE_SHEETS_ID
    || process.env.MASTER_SHEET_ID
    || '',
  ).trim();
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);
  if (req.method === 'GET') {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: Boolean(String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()),
      GOOGLE_PRIVATE_KEY: Boolean(String(process.env.GOOGLE_PRIVATE_KEY || '').trim()),
      VENTAS_SHEET_ID: Boolean(String(process.env.VENTAS_SHEET_ID || '').trim()),
      GOOGLE_SHEETS_ID: Boolean(String(process.env.GOOGLE_SHEETS_ID || '').trim()),
      MASTER_SHEET_ID: Boolean(String(process.env.MASTER_SHEET_ID || '').trim()),
      TIENDANUBE_CLIENT_ID: Boolean(String(process.env.TIENDANUBE_CLIENT_ID || '').trim()),
      TIENDANUBE_CLIENT_SECRET: Boolean(String(process.env.TIENDANUBE_CLIENT_SECRET || '').trim()),
      TIENDANUBE_STORE_ID: Boolean(String(process.env.TIENDANUBE_STORE_ID || '').trim()),
      TIENDANUBE_ACCESS_TOKEN: Boolean(String(process.env.TIENDANUBE_ACCESS_TOKEN || '').trim()),
    };
    const checks = {
      env: { ok: true },
      tiendanubeConfig: { ok: false },
      sheetsConfig: { ok: false },
      sheetsAccess: { ok: false },
    };
    try {
      const ventasConfig = await getVentasConfig();
      const storeId = String(
        ventasConfig?.store_id
        || ventasConfig?.storeId
        || process.env.TIENDANUBE_STORE_ID
        || process.env.TIENDANUBE_USER_ID
        || ''
      ).trim();
      const token = String(
        ventasConfig?.access_token
        || ventasConfig?.accessToken
        || ventasConfig?.token
        || process.env.TIENDANUBE_ACCESS_TOKEN
        || ''
      ).trim();
      checks.tiendanubeConfig = {
        ok: Boolean(storeId && token),
        hasStoreId: Boolean(storeId),
        hasToken: Boolean(token),
      };
    } catch (_) {}

    const spreadsheetId = getVentasSpreadsheetId();
    checks.sheetsConfig = {
      ok: Boolean(
        spreadsheetId
        && env.GOOGLE_SERVICE_ACCOUNT_EMAIL
        && env.GOOGLE_PRIVATE_KEY,
      ),
      spreadsheetId,
    };

    if (checks.sheetsConfig.ok) {
      try {
        const sheets = createSheetsClient({ readOnly: true });
        const metadata = await getSpreadsheetMetadata(sheets);
        checks.sheetsAccess = {
          ok: Boolean(metadata?.spreadsheetId || metadata?.properties?.title),
          title: String(metadata?.properties?.title || ''),
        };
      } catch (error) {
        checks.sheetsAccess = { ok: false, error: String(error?.message || error) };
      }
    }

    const syncState = await readVentasSyncStateSafe().catch(() => ({}));
    return res.status(200).json({
      ok: true,
      traceId,
      checks,
      env,
      lastSync: {
        at: String(syncState?.last_sync_at || ''),
        result: String(syncState?.last_sync_result || ''),
        message: String(syncState?.last_sync_message || ''),
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId });
  }


  if (!requireAdminSession(req, res, {
    logDenied: '[admin-session] ventas sync denied without valid session',
    touchActivity: true,
    reason: 'ventas-sync',
  })) {
    return res.status(401).json({ ok: false, code: 'ADMIN_SESSION_REQUIRED', message: ADMIN_SESSION_REQUIRED_MESSAGE, traceId });
  }

  logInfo('ventas.sync.start', { traceId, result: 'started' });
  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
    logWarn('ventas.sync.skipped', { traceId, result: 'skipped', reason: 'sync_running', durationMs: Date.now() - startedAt });
    return res.status(200).json({ ok: true, skipped: true, reason: 'sync_running', traceId });
  }
  const lockOwnerId = String(lock.ownerId || '').trim();

  try {
    const data = await syncVentasFromTiendanube({ traceId });
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
      const touched = Array.isArray(data?.months_rebuilt)
        ? data.months_rebuilt
        : [];
      if (touched.length) {
        touched.forEach((month) => {
          try {
            invalidateVentasFullCache(month);
          } catch (error) {
            console.error('[ventas.cache.invalidate.failed]', {
              message: error?.message || '',
            });
          }
        });
      } else {
        try {
          invalidateVentasFullCache();
        } catch (error) {
          console.error('[ventas.cache.invalidate.failed]', {
            message: error?.message || '',
          });
        }
      }
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
    const errorMessage = String(error?.message || error || 'Unknown sync error');

    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: errorMessage,
    });

    logError('ventas.sync.failed', {
      traceId,
      result: 'failed',
      processed: 0,
      inserted: 0,
      updated: 0,
      monthsRebuilt: 0,
      durationMs: Date.now() - startedAt,
      errorCode,
      errorMessage,
      stack: error?.stack || '',
      details: error?.details || null,
    });

    return res.status(500).json({
      ok: false,
      code: errorCode,
      message: errorMessage,
      details: error?.details || null,
      stack:
        process.env.NODE_ENV !== 'production'
          ? String(error?.stack || '')
          : undefined,
      traceId,
    });
  } finally {
    await releaseVentasSyncLock(lockOwnerId);
  }
}
