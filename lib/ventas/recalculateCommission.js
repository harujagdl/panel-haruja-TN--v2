import { createSheetsClient, getSheetHeadersRaw, readSheetRowsRaw, updateSheetRowRaw } from '../google/sheetsClient.js';

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowToRecord(headers = [], row = []) {
  const record = {};
  headers.forEach((header, index) => {
    record[normalizeHeader(header)] = row?.[index] ?? '';
  });
  return record;
}

function mapHeadersToRow(headers = [], record = {}) {
  return headers.map((header) => record[normalizeHeader(header)] ?? '');
}

export async function recalculateCommission(orderId) {
  const sheets = createSheetsClient({ readOnly: false });
  const headers = await getSheetHeadersRaw(sheets, 'VentasTN');
  const rows = await readSheetRowsRaw(sheets, 'VentasTN!A2:ZZ');

  const orderIdx = headers.findIndex((header) => normalizeHeader(header) === 'order_id');
  if (orderIdx < 0) return { updated: false };

  const rowIndex = rows.findIndex((row) => String(row?.[orderIdx] || '').trim() === String(orderId || '').trim());
  if (rowIndex < 0) return { updated: false };

  const record = rowToRecord(headers, rows[rowIndex] || []);
  const total = parseNumber(record.commissionable_total || record.total, 0);
  const rate = parseNumber(record.commission_rate, 0.1);
  const paymentStatus = String(record.payment_status || '').trim().toLowerCase();

  if (!String(record.seller || '').trim()) {
    record.seller = 'Pendiente';
    record.seller_assigned = 'FALSE';
  }

  record.commission_amount = paymentStatus === 'paid' ? total * rate : 0;

  const rowNumber = rowIndex + 2;
  await updateSheetRowRaw(sheets, `VentasTN!A${rowNumber}:ZZ${rowNumber}`, mapHeadersToRow(headers, record));

  return { updated: true, orderId: String(orderId), commission_amount: Number(record.commission_amount || 0) };
}
