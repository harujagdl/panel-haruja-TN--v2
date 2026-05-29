import { createTraceId } from '../../lib/observability/logger.js';
import { runVentasPublicSync } from '../../lib/ventas/syncRunner.js';
import { readVentasSyncStateSafe } from '../../lib/ventas/syncState.js';

function envFlag(name) {
  return Boolean(String(process.env[name] || '').trim());
}

export default async function handler(req, res) {
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);

  if (req.method === 'GET') {
    const syncState = await readVentasSyncStateSafe();
    return res.status(200).json({
      ok: true,
      traceId,
      checks: {
        env: { ok: true },
        tiendanubeConfig: {
          ok: envFlag('TIENDANUBE_STORE_ID') && envFlag('TIENDANUBE_ACCESS_TOKEN'),
          hasStoreIdEnv: envFlag('TIENDANUBE_STORE_ID') || envFlag('TIENDANUBE_USER_ID'),
          hasTokenEnv: envFlag('TIENDANUBE_ACCESS_TOKEN'),
        },
        sheetsConfig: {
          ok: (envFlag('VENTAS_SHEET_ID') || envFlag('GOOGLE_SHEETS_ID') || envFlag('MASTER_SHEET_ID'))
            && envFlag('GOOGLE_SERVICE_ACCOUNT_EMAIL')
            && envFlag('GOOGLE_PRIVATE_KEY'),
          hasSpreadsheetId: envFlag('VENTAS_SHEET_ID') || envFlag('GOOGLE_SHEETS_ID') || envFlag('MASTER_SHEET_ID'),
        },
      },
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

  try {
    const data = await runVentasPublicSync({ traceId, source: 'public' });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      code: String(error?.code || 'SYNC_MANUAL_ERROR'),
      message: String(error?.message || error || 'Unknown sync error'),
      details: error?.details || null,
      traceId,
    });
  }
}
