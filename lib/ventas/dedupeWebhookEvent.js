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
const HEADERS = ['event_key', 'event', 'order_id', 'store_id', 'body_hash', 'processed', 'processed_at', 'status'];

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
      range: `${SHEET_NAME}!A1:H1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

export async function dedupeWebhookEvent({ event, orderId, storeId, rawBody, status = 'received' }) {
  const bodyHash = crypto.createHash('sha256').update(String(rawBody || ''), 'utf8').digest('hex');
  const eventKey = `${storeId}_${event}_${orderId}_${bodyHash}`;

  const sheets = createSheetsClient({ readOnly: false });
  await ensureWebhookEventsSheet(sheets);

  const headers = await getSheetHeadersRaw(sheets, SHEET_NAME);
  const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);
  const exists = rows.some((row) => String(rowToRecord(headers, row).event_key || '').trim() === eventKey);

  if (exists) {
    return { duplicated: true, eventKey, bodyHash };
  }

  await appendSheetRowRaw(sheets, SHEET_NAME, [
    eventKey,
    event,
    orderId,
    storeId,
    bodyHash,
    'TRUE',
    new Date().toISOString(),
    status,
  ]);

  return { duplicated: false, eventKey, bodyHash };
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
      status: String(record.status || '').trim() || null,
    };
  } catch {
    return null;
  }
}
