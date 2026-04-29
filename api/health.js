import { requireAdminSession, sendErr } from './core.js';
import { getVentasConfig } from '../lib/api/core.js';
import { createSheetsClient, getSpreadsheetMetadata, getSpreadsheetId } from '../lib/google/sheetsClient.js';
import { readVentasSyncState } from '../lib/ventas/syncState.js';
import { getLatestWebhookEvent } from '../lib/ventas/dedupeWebhookEvent.js';
import { getAdminSessionSecret } from '../lib/security/adminSessionConfig.js';
import { APARTADOS_PDF_DRIVE_ID } from '../lib/apartados/pdf-config.js';
import { createTraceId, getErrorMessage, logError, logInfo, logWarn } from '../lib/observability/logger.js';

const STATUS_WEIGHT = { ok: 0, warning: 1, error: 2 };

function nowIso() {
  return new Date().toISOString();
}

function timed(checkName, traceId, fn) {
  const startedAt = Date.now();
  return Promise.resolve()
    .then(fn)
    .then((result = {}) => ({ ...result, durationMs: Date.now() - startedAt }))
    .catch((error) => {
      const durationMs = Date.now() - startedAt;
      logError('health.check.error', { traceId, check: checkName, durationMs, message: getErrorMessage(error) });
      return { status: 'error', message: getErrorMessage(error), durationMs };
    });
}

function foldStatus(checks = {}) {
  const maxWeight = Object.values(checks).reduce((acc, check) => {
    const weight = STATUS_WEIGHT[String(check?.status || 'error')] ?? STATUS_WEIGHT.error;
    return Math.max(acc, weight);
  }, 0);
  if (maxWeight >= STATUS_WEIGHT.error) return 'error';
  if (maxWeight >= STATUS_WEIGHT.warning) return 'warning';
  return 'ok';
}

async function checkSheets(traceId) {
  return timed('sheets', traceId, async () => {
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) {
      return { status: 'error', message: 'Falta SHEET_ID.' };
    }
    const sheets = createSheetsClient({ readOnly: true });
    const metadata = await getSpreadsheetMetadata(sheets);
    const titles = Array.isArray(metadata?.sheets)
      ? metadata.sheets.map((sheet) => String(sheet?.properties?.title || '').trim()).filter(Boolean)
      : [];
    return {
      status: 'ok',
      spreadsheetConfigured: true,
      sheetCount: titles.length,
      sampleSheets: titles.slice(0, 5),
    };
  });
}

async function checkTiendanube(traceId) {
  return timed('tiendanube', traceId, async () => {
    const config = await getVentasConfig();
    const storeId = String(config?.store_id || process.env.TIENDANUBE_STORE_ID || '').trim();
    const accessTokenPresent = Boolean(String(config?.access_token || process.env.TIENDANUBE_ACCESS_TOKEN || '').trim());
    const appIdPresent = Boolean(String(config?.app_id || process.env.TIENDANUBE_APP_ID || '').trim());

    const missing = [];
    if (!storeId) missing.push('store_id');
    if (!accessTokenPresent) missing.push('access_token');

    if (missing.length) {
      return {
        status: 'warning',
        message: `Configuración incompleta (${missing.join(', ')}).`,
        storeIdConfigured: Boolean(storeId),
        accessTokenConfigured: accessTokenPresent,
        appIdConfigured: appIdPresent,
      };
    }

    return {
      status: appIdPresent ? 'ok' : 'warning',
      message: appIdPresent ? 'Configuración base lista.' : 'Falta app_id (opcional para algunos flujos).',
      storeIdConfigured: true,
      accessTokenConfigured: true,
      appIdConfigured: appIdPresent,
    };
  });
}

async function checkPdf(traceId) {
  return timed('pdf', traceId, async () => {
    const webAppUrl = String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || '').trim();
    const driveFolderId = String(process.env.APARTADOS_PDF_FOLDER_ID || '').trim();
    const driveId = String(APARTADOS_PDF_DRIVE_ID || '').trim();

    if (!webAppUrl && !driveFolderId) {
      return {
        status: 'warning',
        message: 'Sin HARUJA_APARTADOS_PDF_WEBAPP_URL ni APARTADOS_PDF_FOLDER_ID.',
        webAppConfigured: false,
        driveFolderConfigured: false,
        driveSharedConfigured: Boolean(driveId),
      };
    }

    return {
      status: 'ok',
      webAppConfigured: Boolean(webAppUrl),
      driveFolderConfigured: Boolean(driveFolderId),
      driveSharedConfigured: Boolean(driveId),
    };
  });
}

async function checkVentasSync(traceId) {
  return timed('ventasSync', traceId, async () => {
    const state = await readVentasSyncState();
    const lastResult = String(state?.last_sync_result || '').trim().toLowerCase();
    const status = !lastResult
      ? 'warning'
      : (lastResult.includes('ok') || lastResult.includes('success') ? 'ok' : 'error');

    return {
      status,
      last_sync_at: String(state?.last_sync_at || '').trim() || null,
      last_sync_result: String(state?.last_sync_result || '').trim() || null,
      last_sync_message: String(state?.last_sync_message || '').trim() || null,
    };
  });
}

async function checkWebhook(traceId) {
  return timed('webhook', traceId, async () => {
    const latest = await getLatestWebhookEvent();
    if (!latest) {
      return {
        status: 'warning',
        message: 'Sin eventos webhook registrados.',
        processedAt: null,
        event: null,
        orderId: null,
      };
    }
    const normalizedStatus = String(latest.status || '').trim();
    return {
      status: normalizedStatus && !normalizedStatus.toLowerCase().includes('error') ? 'ok' : 'warning',
      processedAt: latest.processedAt || null,
      statusDetail: normalizedStatus || null,
      event: latest.event || null,
      orderId: latest.orderId || null,
    };
  });
}

async function checkAdminConfig(traceId) {
  return timed('admin', traceId, async () => {
    try {
      getAdminSessionSecret();
      return { status: 'ok', configured: true };
    } catch {
      return { status: 'error', configured: false, message: 'ADMIN_SESSION_SECRET no configurado.' };
    }
  });
}

export default async function handler(req, res) {
  const traceId = createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id']);

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido. Usa GET.', traceId });
  }

  const session = requireAdminSession(req, res, { reason: 'health', touchActivity: false, logDenied: '[health] denied' });
  if (!session) {
    return sendErr(res, 401, 'No autorizado.', null, 'UNAUTHORIZED', traceId);
  }

  logInfo('health.start', { traceId, email: session?.email || 'admin' });

  const checks = {
    sheets: await checkSheets(traceId),
    tiendanube: await checkTiendanube(traceId),
    pdf: await checkPdf(traceId),
    ventasSync: await checkVentasSync(traceId),
    webhook: await checkWebhook(traceId),
    admin: await checkAdminConfig(traceId),
  };

  Object.entries(checks).forEach(([name, check]) => {
    const event = check?.status === 'error' ? 'health.check.failed' : (check?.status === 'warning' ? 'health.check.warning' : 'health.check.ok');
    const logFn = check?.status === 'error' ? logError : (check?.status === 'warning' ? logWarn : logInfo);
    logFn(event, { traceId, check: name, durationMs: check?.durationMs, message: check?.message || '' });
  });

  const status = foldStatus(checks);
  const payload = {
    ok: true,
    traceId,
    status,
    checks,
    generatedAt: nowIso(),
  };

  logInfo('health.done', { traceId, status });
  return res.status(200).json(payload);
}
