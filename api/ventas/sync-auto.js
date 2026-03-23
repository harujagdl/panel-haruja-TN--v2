import { resolveTiendanubeConnection, syncVentasFromTiendanubeIncremental } from '../../lib/api/core.js';
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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  console.log('[ventas-sync-auto] start');
  const lock = await acquireVentasSyncLock();
  if (!lock.acquired) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'sync_running' });
  }

  try {
    const previous = await readVentasSyncState();
    const lastUpdatedAtMax = isoOrEmpty(previous.last_updated_at_max);
    const lastCreatedAtMax = isoOrEmpty(previous.last_created_at_max);
    const connection = await resolveTiendanubeConnection();
    const storeId = connection.storeId;
    const baseUrl = 'https://api.tiendanube.com/v1';
    const endpoint = '/orders';
    const requestUrl = `${baseUrl}/${encodeURIComponent(storeId)}${endpoint}`;
    console.log('[ventas-sync-auto] store_id=%s', storeId);
    console.log('[ventas-sync-auto] store_source=%s', connection.storeSource || 'unknown');
    console.log('[ventas-sync-auto] token_source=%s', connection.tokenSource || 'unknown');
    console.log('[ventas-sync-auto] base_url=%s', baseUrl);
    console.log('[ventas-sync-auto] endpoint=%s', endpoint);
    console.log('[ventas-sync-auto] request_url=%s', requestUrl);
    console.log('[ventas-sync-auto] since_updated_at=%s', lastUpdatedAtMax || 'EMPTY');
    console.log('[ventas-sync-auto] since_created_at=%s', lastCreatedAtMax || 'EMPTY');

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
      console.log('[ventas-sync-auto] cache_invalidated');
      console.log(`[ventas-sync-auto] processed_${processed}`);
    } else {
      console.log('[ventas-sync-auto] no_changes');
    }

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
    });
  } catch (error) {
    const code = String(error?.code || '').trim();
    const detailStatus = Number(error?.details?.status || error?.http_status || 500) || 500;
    const detailEndpoint = String(error?.details?.endpoint || '/orders');
    const detailStoreId = String(error?.details?.store_id || process.env.TIENDANUBE_STORE_ID || '').trim();
    if (code) {
      console.log('[ventas-sync-auto] tn_status=%s', detailStatus);
      console.log('[ventas-sync-auto] tn_error=%s', String(error?.message || error));
      console.log('[ventas-sync-auto] tn_store_id=%s', detailStoreId);
      console.log('[ventas-sync-auto] tn_endpoint=%s', detailEndpoint);
    }
    await writeVentasSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_result: 'error',
      last_sync_message: String(error?.message || error),
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
    });
  } finally {
    await releaseVentasSyncLock();
  }
}
