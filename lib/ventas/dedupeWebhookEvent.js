import crypto from 'crypto';
import {
  appendSheetRowRaw,
  createSheetsClient,
  getSheetHeadersRaw,
  getSpreadsheetId,
  getSpreadsheetMetadata,
  readSheetRowsRaw,
} from '../google/sheetsClient.js';

const SHEET_NAME = 'webhook_events';
const HEADERS = ['received_at', 'event_key', 'event_id', 'event', 'order_id', 'store_id', 'event_ts', 'body_hash', 'result', 'reason', 'processed_at'];
const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function rowToRecord(headers = [], row = []) {
  const record = {};
  headers.forEach((header, index) => {
    record[normalizeHeader(header)] = row?.[index] ?? '';
  });
  return record;
}

async function ensureWebhookEventsSheet(sheets) {
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
      range: `${SHEET_NAME}!A1:K1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

export async function dedupeWebhookEvent({ event, orderId, storeId, rawBody, status = 'received' }) {
  const bodyHash = crypto.createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
  const normalizedStoreId = String(storeId || '').trim().toLowerCase();
  const normalizedEvent = String(event || '').trim().toLowerCase();
  const normalizedOrderId = String(orderId || '').trim();
  const eventKey = `${normalizedStoreId}::${normalizedEvent}::${normalizedOrderId}::${bodyHash}`;

  const sheets = createSheetsClient({ readOnly: false });
  await ensureWebhookEventsSheet(sheets);

  const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
  const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);
  const exists = rows.some((row) => String(rowToRecord(headers, row).event_key || '').trim() === eventKey);

  if (exists) {
    return { duplicated: true, eventKey, bodyHash };
  }

  const now = new Date().toISOString();
  await appendSheetRowRaw(sheets, SHEET_NAME, [
    now,
    eventKey,
    '',
    event,
    orderId,
    storeId,
    '',
    bodyHash,
    status,
    'legacy_dedupe',
    now,
  ]);

  return { duplicated: false, eventKey, bodyHash };
}

function normalizeTimestampMinute(value = '') {
  const ms = new Date(String(value || '')).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function buildFallbackEventKey({ source, event, orderId, storeId, bodyHash, eventTimestamp }) {
  const parts = [
    String(source || 'tiendanube').trim().toLowerCase() || 'tiendanube',
    String(storeId || '').trim().toLowerCase(),
    String(event || '').trim().toLowerCase(),
    String(orderId || '').trim(),
    normalizeTimestampMinute(eventTimestamp),
    String(bodyHash || '').trim(),
  ];
  return parts.join('::');
}

export function buildWebhookEventKey({
  source = 'tiendanube',
  event = '',
  orderId = '',
  storeId = '',
  eventId = '',
  bodyHash = '',
  eventTimestamp = '',
} = {}) {
  const normalizedEventId = String(eventId || '').trim();
  if (normalizedEventId) {
    return `${String(source || 'tiendanube').trim().toLowerCase()}::id::${normalizedEventId}`;
  }
  return buildFallbackEventKey({ source, event, orderId, storeId, bodyHash, eventTimestamp });
}

function isRecentRecord(record = {}, dedupeWindowMs) {
  const processedAt = String(record.processed_at || '').trim();
  const processedAtMs = processedAt ? new Date(processedAt).getTime() : 0;
  if (!Number.isFinite(processedAtMs) || processedAtMs <= 0) return false;
  return (Date.now() - processedAtMs) <= dedupeWindowMs;
}

export async function registerWebhookEventAttempt({
  source = 'tiendanube',
  event = '',
  orderId = '',
  storeId = '',
  eventId = '',
  rawBody = '',
  eventTimestamp = '',
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
} = {}) {
  const bodyHash = crypto.createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
  const eventKey = buildWebhookEventKey({
    source,
    event,
    orderId,
    storeId,
    eventId,
    bodyHash,
    eventTimestamp,
  });

  const sheets = createSheetsClient({ readOnly: false });
  await ensureWebhookEventsSheet(sheets);
  const now = new Date().toISOString();
  const claimId = `claim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const claimReason = `claim:${claimId}`;

  // First write a persistent claim row. Winner is the earliest recent claim for event_key.
  await appendSheetRowRaw(sheets, SHEET_NAME, [
    now,
    eventKey,
    String(eventId || '').trim(),
    String(event || '').trim(),
    String(orderId || '').trim(),
    String(storeId || '').trim(),
    normalizeTimestampMinute(eventTimestamp),
    bodyHash,
    'claimed',
    claimReason,
    now,
  ]);

  const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
  const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);
  const records = rows.map((row, index) => ({ ...rowToRecord(headers, row), rowNumber: index + 2 }));
  const currentClaim = records
    .filter((record) => String(record.event_key || '').trim() === eventKey && String(record.reason || '').trim() === claimReason)
    .slice(-1)[0];
  const claimRowNumber = Number(currentClaim?.rowNumber || 0);

  const duplicated = records.some((record) => {
    if (String(record.event_key || '').trim() !== eventKey) return false;
    if (!isRecentRecord(record, dedupeWindowMs)) return false;
    const rowNumber = Number(record.rowNumber || 0);
    return rowNumber > 0 && claimRowNumber > 0 && rowNumber < claimRowNumber;
  });

  await appendSheetRowRaw(sheets, SHEET_NAME, [
    now,
    eventKey,
    String(eventId || '').trim(),
    String(event || '').trim(),
    String(orderId || '').trim(),
    String(storeId || '').trim(),
    normalizeTimestampMinute(eventTimestamp),
    bodyHash,
    duplicated ? 'duplicate_ignored' : 'accepted',
    duplicated ? 'duplicate_event_key_recent' : 'accepted_first_write_wins',
    now,
  ]);

  return { duplicated, eventKey, bodyHash };
}

export async function trackWebhookEventResult({
  eventKey = '',
  eventId = '',
  event = '',
  orderId = '',
  storeId = '',
  rawBody = '',
  eventTimestamp = '',
  result = 'processed',
  reason = '',
} = {}) {
  const bodyHash = crypto.createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
  const now = new Date().toISOString();
  const resolvedEventKey = String(eventKey || '').trim() || buildWebhookEventKey({
    event,
    orderId,
    storeId,
    eventId,
    bodyHash,
    eventTimestamp,
  });

  const sheets = createSheetsClient({ readOnly: false });
  await ensureWebhookEventsSheet(sheets);
  await appendSheetRowRaw(sheets, SHEET_NAME, [
    now,
    resolvedEventKey,
    String(eventId || '').trim(),
    String(event || '').trim(),
    String(orderId || '').trim(),
    String(storeId || '').trim(),
    normalizeTimestampMinute(eventTimestamp),
    bodyHash,
    String(result || '').trim(),
    String(reason || '').trim(),
    now,
  ]);

  return { eventKey: resolvedEventKey };
}

export async function getLatestWebhookEvent() {
  const sheets = createSheetsClient({ readOnly: true });
  try {
    const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
    const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);
    if (!rows.length) return null;
    const latest = rows[rows.length - 1];
    const record = rowToRecord(headers, latest);
    return {
      event: String(record.event || '').trim() || null,
      orderId: String(record.order_id || '').trim() || null,
      processedAt: String(record.processed_at || '').trim() || null,
      status: String(record.result || '').trim() || null,
      eventKey: String(record.event_key || '').trim() || null,
      reason: String(record.reason || '').trim() || null,
    };
  } catch {
    return null;
  }
}
