import { getVentasConfig } from '../api/core.js';
import {
  createSheetsClient,
  getSheetHeadersRaw,
  getSpreadsheetId,
  getSpreadsheetMetadata,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';
import { getLatestWebhookEvent } from '../ventas/dedupeWebhookEvent.js';

const SHEET_NAME = 'tiendanube_status';
const HEADERS = ['mode', 'last_event', 'last_order', 'last_sync_at', 'updated_at'];

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

async function ensureStatusSheet(sheets) {
  const metadata = await getSpreadsheetMetadata(sheets);
  const existing = (metadata?.sheets || []).find((sheet) => String(sheet?.properties?.title || '').trim() === SHEET_NAME);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: getSpreadsheetId(),
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  }

  const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
  if (!headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: getSpreadsheetId(),
      range: `${SHEET_NAME}!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

function mapStatusRecord(headers = [], row = []) {
  const rec = {};
  headers.forEach((h, i) => { rec[normalizeHeader(h)] = row?.[i] ?? ''; });
  return {
    mode: String(rec.mode || '').trim() || 'automatico',
    lastEvent: String(rec.last_event || '').trim() || null,
    lastOrder: String(rec.last_order || '').trim() || null,
    lastSyncAt: String(rec.last_sync_at || '').trim() || null,
    updatedAt: String(rec.updated_at || '').trim() || null,
  };
}

export async function saveWebhookStatus({ mode = 'automatico', lastEvent = null, lastOrder = null, lastSyncAt = null } = {}) {
  const sheets = createSheetsClient({ readOnly: false });
  await ensureStatusSheet(sheets);
  const updatedAt = new Date().toISOString();
  await updateSheetRowRaw(sheets, `${SHEET_NAME}!A2:E2`, [
    mode,
    lastEvent || '',
    lastOrder || '',
    lastSyncAt || '',
    updatedAt,
  ]);
  return { mode, lastEvent, lastOrder, lastSyncAt, updatedAt };
}

export async function getWebhookStatus() {
  const startedAt = Date.now();

  let persisted = null;
  try {
    const sheets = createSheetsClient({ readOnly: true });
    const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
    const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);
    if (headers.length && rows.length) persisted = mapStatusRecord(headers, rows[0]);
  } catch {
    persisted = null;
  }

  let latest = null;
  try {
    latest = await getLatestWebhookEvent();
  } catch {
    latest = null;
  }

  let lastSyncAtConfig = null;
  try {
    const config = await getVentasConfig();
    lastSyncAtConfig = config?.last_sync_at || null;
  } catch {
    lastSyncAtConfig = null;
  }

  return {
    ok: true,
    mode: persisted?.mode || 'automatico',
    lastEvent: persisted?.lastEvent || latest?.event || null,
    lastOrder: persisted?.lastOrder || latest?.orderId || null,
    lastSyncAt: persisted?.lastSyncAt || lastSyncAtConfig || null,
    meta: {
      source: persisted ? 'db_cache' : 'db_fallback',
      durationMs: Date.now() - startedAt,
    },
  };
}
