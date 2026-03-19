import {
  appendSheetRowRaw,
  createSheetsClient,
  getSheetHeadersRaw,
  getSpreadsheetId,
  getSpreadsheetMetadata,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';

const SHEET_NAME = 'VentasSyncEstado';
const REQUIRED_HEADERS = ['key', 'value', 'updated_at'];
const REQUIRED_KEYS = [
  'mode',
  'last_event_received_at',
  'last_event_type',
  'last_order_processed_at',
  'last_order_name',
  'last_order_id',
  'last_sync_at',
  'last_sync_result',
  'last_sync_message',
  'last_created_at_max',
  'last_updated_at_max',
  'sync_lock',
  'sync_lock_at',
];

function normalize(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureSheetExists(sheets) {
  const metadata = await getSpreadsheetMetadata(sheets);
  const exists = (metadata?.sheets || []).some((sheet) => normalize(sheet?.properties?.title) === SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: getSpreadsheetId(),
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  }
}

async function ensureHeaders(sheets) {
  const currentHeaders = await getSheetHeadersRaw(sheets, SHEET_NAME);
  if (!currentHeaders.length) {
    await updateSheetRowRaw(sheets, `${SHEET_NAME}!A1:C1`, REQUIRED_HEADERS);
    return REQUIRED_HEADERS.slice();
  }
  const normalized = currentHeaders.map((header) => normalize(header).toLowerCase());
  if (REQUIRED_HEADERS.every((header) => normalized.includes(header))) return currentHeaders;
  await updateSheetRowRaw(sheets, `${SHEET_NAME}!A1:C1`, REQUIRED_HEADERS);
  return REQUIRED_HEADERS.slice();
}

function rowToRecord(row = []) {
  return {
    key: normalize(row[0]),
    value: normalize(row[1]),
    updated_at: normalize(row[2]),
  };
}

async function ensureStateSheet() {
  const sheets = createSheetsClient({ readOnly: false });
  await ensureSheetExists(sheets);
  await ensureHeaders(sheets);
  const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:C`);
  const rowMap = new Map();

  rows.forEach((row, index) => {
    const record = rowToRecord(row);
    if (!record.key) return;
    rowMap.set(record.key, {
      ...record,
      rowNumber: index + 2,
    });
  });

  const missing = REQUIRED_KEYS.filter((key) => !rowMap.has(key));
  for (const key of missing) {
    await appendSheetRowRaw(sheets, SHEET_NAME, [key, '', nowIso()]);
  }

  if (missing.length) {
    const refreshedRows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:C`);
    rowMap.clear();
    refreshedRows.forEach((row, index) => {
      const record = rowToRecord(row);
      if (!record.key) return;
      rowMap.set(record.key, {
        ...record,
        rowNumber: index + 2,
      });
    });
  }

  return { sheets, rowMap };
}

export async function readVentasSyncState() {
  const { rowMap } = await ensureStateSheet();
  const result = {};
  REQUIRED_KEYS.forEach((key) => {
    result[key] = rowMap.get(key)?.value || '';
  });
  return result;
}

export async function writeVentasSyncState(values = {}) {
  const { sheets, rowMap } = await ensureStateSheet();
  const updates = Object.entries(values)
    .filter(([key]) => REQUIRED_KEYS.includes(key));
  if (!updates.length) return;
  const at = nowIso();
  for (const [key, value] of updates) {
    const row = rowMap.get(key);
    if (!row?.rowNumber) continue;
    await updateSheetRowRaw(sheets, `${SHEET_NAME}!A${row.rowNumber}:C${row.rowNumber}`, [key, value === undefined || value === null ? '' : String(value), at]);
  }
}

export async function acquireVentasSyncLock() {
  const state = await readVentasSyncState();
  const lock = normalize(state.sync_lock).toLowerCase();
  if (lock === 'true' || lock === '1') return { acquired: false, state };
  const lockAt = nowIso();
  await writeVentasSyncState({
    sync_lock: 'true',
    sync_lock_at: lockAt,
  });
  return { acquired: true, lockAt };
}

export async function releaseVentasSyncLock() {
  await writeVentasSyncState({
    sync_lock: 'false',
    sync_lock_at: '',
  });
}

