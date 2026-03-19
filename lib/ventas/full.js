import { createSheetsClient, getSpreadsheetId, readSheetRangesBatchRaw } from '../google/sheetsClient.js';
import { getVentasFullCache, setVentasFullCache } from './cache.js';

const SHEET_VENTAS = process.env.VENTAS_SHEET_NAME || 'VentasTN';
const SHEET_STATUS = 'VentasSyncEstado';

function normalizeMonth(monthValue = '') {
  const raw = String(monthValue || '').trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new Error('Mes inválido. Usa formato YYYY-MM.');
  return raw;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeHeader(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function parseNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/\$/g, '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function monthFromDate(value) {
  const parsed = new Date(String(value || '').trim());
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dateDesc(a = '', b = '') {
  return new Date(b).getTime() - new Date(a).getTime();
}

function parseStatusRows(rows = []) {
  const map = {};
  rows.forEach((row = []) => {
    const key = String(row[0] || '').trim();
    if (!key) return;
    map[key] = String(row[1] || '').trim();
  });
  return {
    mode: map.mode || 'automatico',
    last_event_received_at: map.last_event_received_at || '',
    last_event_type: map.last_event_type || '',
    last_order_processed_at: map.last_order_processed_at || '',
    last_order_name: map.last_order_name || '',
    last_order_id: map.last_order_id || '',
    last_sync_at: map.last_sync_at || '',
    last_sync_result: map.last_sync_result || '',
    last_sync_message: map.last_sync_message || '',
  };
}

function mapVenta(headers = [], row = []) {
  const byKey = {};
  headers.forEach((header, index) => {
    byKey[normalizeHeader(header)] = row[index] ?? '';
  });

  const createdAt = String(byKey.created_at || byKey.fecha || '').trim();
  const total = parseNumber(byKey.total, 0);
  const sellerRaw = String(byKey.seller || '').trim();
  const seller = sellerRaw.toLowerCase() === 'haru'
    ? 'Haru'
    : sellerRaw.toLowerCase() === 'vendedora'
      ? 'Vendedora'
      : '';
  const sellerAssigned = ['true', '1', 'si', 'sí', 'yes'].includes(String(byKey.seller_assigned || '').trim().toLowerCase());

  return {
    order_id: String(byKey.order_id || '').trim(),
    ticket_label: String(byKey.ticket_label || '').trim(),
    ticket_number: String(byKey.ticket_number || '').trim(),
    created_at: createdAt,
    month_key: String(byKey.month_key || monthFromDate(createdAt)).trim(),
    customer_name: String(byKey.customer_name || '').trim(),
    total,
    payment_status: String(byKey.payment_status || '').trim().toLowerCase(),
    fulfillment_status: String(byKey.fulfillment_status || '').trim().toLowerCase(),
    seller,
    seller_assigned: sellerAssigned,
    commission_amount: parseNumber(byKey.commission_amount, 0),
  };
}

function buildResumen(ventas = []) {
  const paid = ventas.filter((item) => item.payment_status === 'paid');
  const totalMes = paid.reduce((acc, item) => acc + parseNumber(item.total, 0), 0);
  const totalHaru = paid.filter((item) => item.seller === 'Haru').reduce((acc, item) => acc + parseNumber(item.total, 0), 0);
  const totalVendedora = paid.filter((item) => item.seller === 'Vendedora').reduce((acc, item) => acc + parseNumber(item.total, 0), 0);
  const sinAsignar = paid.filter((item) => !item.seller || !item.seller_assigned).length;

  return {
    total_mes: totalMes,
    ticket_promedio: paid.length ? totalMes / paid.length : 0,
    sin_asignar: sinAsignar,
    por_vendedora: {
      Haru: totalHaru,
      Vendedora: totalVendedora,
    },
    total_haru: totalHaru,
    total_vendedora: totalVendedora,
    orders_count: paid.length,
  };
}

function resolveRangeBatch(batch = {}, partialRange = '') {
  const key = Object.keys(batch).find((current) => current.startsWith(partialRange));
  return key ? (batch[key] || []) : [];
}

export async function getVentasFullData(monthValue = '', { forceRefresh = false } = {}) {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  if (!forceRefresh) {
    const cached = getVentasFullCache(monthKey);
    if (cached.hit) {
      console.log('[ventas-full] cache_hit', { mes: monthKey });
      return cached.data;
    }
    console.log('[ventas-full] cache_miss', { mes: monthKey });
  }

  const sheets = createSheetsClient({ readOnly: true });
  const ventasRange = `${SHEET_VENTAS}!A1:ZZ`;
  const statusRange = `${SHEET_STATUS}!A1:C`;

  console.log('[ventas-full] sheets_read_start', { mes: monthKey, spreadsheet_id: getSpreadsheetId() });
  const batch = await readSheetRangesBatchRaw(sheets, [ventasRange, statusRange]);
  console.log('[ventas-full] sheets_read_done', { mes: monthKey });

  const ventasRowsRaw = resolveRangeBatch(batch, ventasRange);
  const statusRowsRaw = resolveRangeBatch(batch, statusRange);

  const headers = Array.isArray(ventasRowsRaw[0]) ? ventasRowsRaw[0] : [];
  const salesRows = headers.length ? ventasRowsRaw.slice(1) : [];
  const ventas = salesRows
    .map((row) => mapVenta(headers, row))
    .filter((venta) => venta.order_id && venta.month_key === monthKey)
    .sort((a, b) => dateDesc(a.created_at, b.created_at));

  const statusRows = (statusRowsRaw || []).slice(1);
  const status = parseStatusRows(statusRows);
  const payload = {
    ok: true,
    mes: monthKey,
    resumen: buildResumen(ventas),
    status,
    ventas,
  };

  setVentasFullCache(monthKey, payload);
  return payload;
}

export function getVentasFullStale(monthValue = '') {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const cached = getVentasFullCache(monthKey);
  return cached.stale || null;
}
