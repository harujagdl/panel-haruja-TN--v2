import {
  appendSheetRowRaw,
  createSheetsClient,
  getSheetHeadersRaw,
  getSpreadsheetId,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';
import { getMexicoDateKey, getMexicoMonthKey } from './mexicoDate.js';

const SHEET_NAME = 'VentasTN';

const REQUIRED_HEADERS = [
  'order_id',
  'ticket_number',
  'ticket_label',
  'created_at',
  'updated_at',
  'paid_at',
  'cancelled_at',
  'month_key',
  'fecha_operativa',
  'customer_name',
  'customer_email',
  'total',
  'subtotal',
  'discount',
  'payment_status',
  'raw_status',
  'channel',
  'seller',
  'seller_assigned',
  'commissionable_total',
  'commission_rate',
  'commission_amount',
  'currency',
  'gateway_name',
  'store_id',
  'last_webhook_event',
  'last_webhook_processed_at',
  'source',
  'raw',
];

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDate(value) {
  const ms = new Date(String(value || '')).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function rowToRecord(headers = [], row = []) {
  const record = {};
  headers.forEach((header, index) => {
    record[normalizeHeader(header)] = row?.[index] ?? '';
  });
  return record;
}

async function ensureHeaders(sheets, headers = []) {
  const normalized = headers.map((header) => normalizeHeader(header));
  let changed = false;
  for (const required of REQUIRED_HEADERS) {
    if (!normalized.includes(required)) {
      headers.push(required);
      normalized.push(required);
      changed = true;
    }
  }

  if (changed) {
    await updateSheetRowRaw(sheets, `${SHEET_NAME}!A1:ZZ1`, headers);
  }

  return headers;
}

function ventaToRecord(venta, event) {
  const createdAt = venta.createdAt || new Date().toISOString();
  const fechaOperativa = getMexicoDateKey(createdAt);
  const monthKey = getMexicoMonthKey(createdAt) || getMexicoMonthKey(new Date());
  return {
    order_id: venta.orderId,
    ticket_number: venta.orderNumber ?? '',
    ticket_label: venta.orderNumber ? `#${venta.orderNumber}` : venta.orderId,
    created_at: createdAt,
    updated_at: venta.updatedAt || createdAt,
    paid_at: venta.paidAt || '',
    cancelled_at: venta.cancelledAt || '',
    month_key: monthKey,
    fecha_operativa: fechaOperativa,
    customer_name: venta.customerName || '',
    customer_email: venta.customerEmail || '',
    total: Number(venta.total || 0),
    subtotal: Number(venta.subtotal || 0),
    discount: Number(venta.discount || 0),
    payment_status: venta.paymentStatus || '',
    raw_status: venta.orderStatus || '',
    channel: 'tiendanube',
    seller: '',
    seller_assigned: 'FALSE',
    commissionable_total: Number(venta.total || 0),
    commission_rate: 0.1,
    commission_amount: 0,
    currency: venta.currency || 'MXN',
    gateway_name: venta.gatewayName || '',
    store_id: venta.storeId || process.env.TIENDANUBE_STORE_ID || '',
    last_webhook_event: event || '',
    last_webhook_processed_at: new Date().toISOString(),
    source: 'tiendanube_webhook',
    raw: JSON.stringify(venta.raw || {}),
  };
}

function mapHeadersToRow(headers = [], record = {}) {
  return headers.map((header) => record[normalizeHeader(header)] ?? '');
}

export async function upsertVenta(venta, { event } = {}) {
  const sheets = createSheetsClient({ readOnly: false });
  const headersRaw = await getSheetHeadersRaw(sheets, SHEET_NAME);
  const headers = await ensureHeaders(sheets, headersRaw);
  const rows = await readSheetRowsRaw(sheets, `${SHEET_NAME}!A2:ZZ`);

  const orderId = String(venta?.orderId || '').trim();
  if (!orderId) throw new Error('orderId is required for upsertVenta');

  const idxOrderId = headers.findIndex((header) => normalizeHeader(header) === 'order_id');
  const existingIndex = rows.findIndex((row) => String(row?.[idxOrderId] || '').trim() === orderId);

  const newRecord = ventaToRecord(venta, event);

  if (existingIndex >= 0) {
    const existingRecord = rowToRecord(headers, rows[existingIndex] || []);
    const currentUpdatedAt = parseDate(existingRecord.updated_at);
    const incomingUpdatedAt = parseDate(newRecord.updated_at);

    if (incomingUpdatedAt > 0 && currentUpdatedAt > 0 && incomingUpdatedAt < currentUpdatedAt) {
      return { action: 'ignored_old_event', stale: true, rowNumber: existingIndex + 2, venta: existingRecord };
    }

    if (String(existingRecord.seller || '').trim()) {
      newRecord.seller = existingRecord.seller;
      newRecord.seller_assigned = String(existingRecord.seller_assigned || 'FALSE').toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
      newRecord.commission_rate = Number(existingRecord.commission_rate || newRecord.commission_rate || 0.1);
      newRecord.commission_amount = Number(existingRecord.commission_amount || 0);
    }

    const rowNumber = existingIndex + 2;
    await updateSheetRowRaw(sheets, `${SHEET_NAME}!A${rowNumber}:ZZ${rowNumber}`, mapHeadersToRow(headers, newRecord));
    return { action: 'updated', stale: false, rowNumber, venta: newRecord };
  }

  await appendSheetRowRaw(sheets, SHEET_NAME, mapHeadersToRow(headers, newRecord));
  return { action: 'inserted', stale: false, rowNumber: rows.length + 2, venta: newRecord };
}
