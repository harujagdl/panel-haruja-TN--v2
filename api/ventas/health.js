import { getVentasConfig } from '../../lib/api/core.js';
import { createSheetsClient, getSpreadsheetMetadata } from '../../lib/sheets/client.js';
import { createTraceId } from '../../lib/observability/logger.js';
import { readVentasSyncStateSafe } from '../../lib/ventas/syncState.js';

function getVentasSpreadsheetId() {
  return String(
    process.env.VENTAS_SHEET_ID
    || process.env.GOOGLE_SHEETS_ID
    || process.env.MASTER_SHEET_ID
    || '',
  ).trim();
}

export default async function handler(req, res) {
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.query?.traceId);
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', traceId });
  }

  const env = {
    hasToken: Boolean(String(process.env.TIENDANUBE_ACCESS_TOKEN || '').trim()),
    hasStoreId: Boolean(String(process.env.TIENDANUBE_STORE_ID || process.env.TIENDANUBE_USER_ID || '').trim()),
    hasSheetsId: Boolean(String(process.env.VENTAS_SHEET_ID || process.env.GOOGLE_SHEETS_ID || process.env.MASTER_SHEET_ID || '').trim()),
    hasGoogleEmail: Boolean(String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()),
    hasGoogleKey: Boolean(String(process.env.GOOGLE_PRIVATE_KEY || '').trim()),
  };

  const config = await getVentasConfig().catch(() => null);
  const spreadsheetId = getVentasSpreadsheetId();
  let sheetsAccess = false;
  try {
    const client = createSheetsClient({ readOnly: true });
    await getSpreadsheetMetadata(client);
    sheetsAccess = true;
  } catch {
    sheetsAccess = false;
  }

  const state = await readVentasSyncStateSafe().catch(() => ({}));

  return res.status(200).json({
    ok: true,
    traceId,
    checks: {
      env: Object.values(env).every(Boolean),
      tiendanubeConfig: Boolean(String(config?.store_id || process.env.TIENDANUBE_STORE_ID || '').trim()),
      sheetsConfig: Boolean(String(spreadsheetId || '').trim()),
      sheetsAccess,
    },
    env,
    lastSync: {
      status: state?.last_sync_result || null,
      lastSyncAt: state?.last_sync_at || null,
      lastError: state?.last_sync_result === 'error' ? (state?.last_sync_message || null) : null,
    },
  });
}
