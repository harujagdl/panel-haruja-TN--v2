import { createSheetsClient, getSpreadsheetId } from '../google/sheetsClient.js';
import { getVentasFullCache, setVentasFullCache } from './cache.js';

const SHEET_VENTAS = 'VentasTN';
const SHEET_STATUS = 'VentasSyncEstado';
const VENTAS_RANGE = 'VentasTN!A1:R1000';
const TEMP_HARDCODED_SPREADSHEET_ID = ''; // Temporal: pegar aquí el spreadsheetId exacto para pruebas puntuales.

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
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function parseNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/\$/g, '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateFromSheetsSerial(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0) return null;
  const utcDays = Math.floor(numeric - 25569);
  const utcMillis = utcDays * 86400 * 1000;
  const fractional = numeric - Math.floor(numeric);
  const fractionalMillis = Math.round(fractional * 86400 * 1000);
  const date = new Date(utcMillis + fractionalMillis);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateFlexible(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const fromSerial = parseDateFromSheetsSerial(raw);
    if (fromSerial) return fromSerial;
  }

  const latinDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (latinDate) {
    const dd = Number(latinDate[1]);
    const mm = Number(latinDate[2]) - 1;
    const yyyy = Number(latinDate[3]);
    const date = new Date(Date.UTC(yyyy, mm, dd, 12, 0, 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const yyyy = Number(isoDate[1]);
    const mm = Number(isoDate[2]) - 1;
    const dd = Number(isoDate[3]);
    const date = new Date(Date.UTC(yyyy, mm, dd, 12, 0, 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthFromDate(value) {
  const parsed = parseDateFlexible(value);
  if (!parsed) return '';
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

function resolveSpreadsheetId() {
  const hardcoded = String(TEMP_HARDCODED_SPREADSHEET_ID || '').trim();
  if (hardcoded) return hardcoded;
  return getSpreadsheetId();
}

function getValueByAliases(record = {}, aliases = []) {
  for (const key of aliases) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    return value;
  }
  return '';
}

function mapVenta(headers = [], row = []) {
  const byKey = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized) byKey[normalized] = row[index] ?? '';
  });

  const createdAtRaw = getValueByAliases(byKey, ['created_at', 'fecha', 'fecha_venta']);
  const createdAt = parseDateFlexible(createdAtRaw)?.toISOString() || String(createdAtRaw || '').trim();
  const total = parseNumber(getValueByAliases(byKey, ['total_pagado', 'total', 'monto', 'importe']), 0);
  const sellerRaw = String(getValueByAliases(byKey, ['seller', 'vendedora', 'vendedor'])).trim();
  const seller = sellerRaw.toLowerCase() === 'haru'
    ? 'Haru'
    : sellerRaw.toLowerCase() === 'vendedora'
      ? 'Vendedora'
      : '';
  const sellerAssigned = ['true', '1', 'si', 'sí', 'yes'].includes(String(byKey.seller_assigned || sellerRaw).trim().toLowerCase());
  const estadoRaw = String(getValueByAliases(byKey, ['estado', 'status', 'raw_status'])).trim().toLowerCase();
  const paymentStatus = String(getValueByAliases(byKey, ['payment_status'])).trim().toLowerCase() || estadoRaw.split('/')[0] || '';
  const fulfillmentStatus = String(getValueByAliases(byKey, ['fulfillment_status'])).trim().toLowerCase() || estadoRaw.split('/')[1] || '';

  return {
    order_id: String(getValueByAliases(byKey, ['order_id', 'orderid', 'id_orden', 'orden_id'])).trim(),
    ticket_label: String(getValueByAliases(byKey, ['ticket_label', 'ticket', 'numero_ticket'])).trim(),
    ticket_number: String(getValueByAliases(byKey, ['ticket_number', 'ticket_numero', 'numero_ticket'])).trim(),
    created_at: createdAt,
    month_key: String(getValueByAliases(byKey, ['month_key']) || monthFromDate(createdAt)).trim(),
    customer_name: String(getValueByAliases(byKey, ['customer_name', 'cliente', 'nombre_cliente'])).trim(),
    total,
    payment_status: paymentStatus,
    fulfillment_status: fulfillmentStatus,
    seller,
    seller_assigned: sellerAssigned,
    commission_amount: parseNumber(getValueByAliases(byKey, ['commission_amount', 'comision', 'comision_monto']), 0),
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

export async function getVentasFullData(monthValue = '', { forceRefresh = false, debug = false } = {}) {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  if (!forceRefresh && !debug) {
    const cached = getVentasFullCache(monthKey);
    if (cached.hit) {
      console.log('[ventas-full] cache_hit', { mes: monthKey });
      return cached.data;
    }
    console.log('[ventas-full] cache_miss', { mes: monthKey });
  }

  const sheets = createSheetsClient({ readOnly: true });
  const ventasRange = VENTAS_RANGE;
  const statusRange = `${SHEET_STATUS}!A1:C`;
  const spreadsheetId = resolveSpreadsheetId();

  console.log('[ventas-full] sheets_read_start', {
    mes: monthKey,
    spreadsheet_id: spreadsheetId,
    sheet_name: SHEET_VENTAS,
    range: ventasRange,
  });
  const [ventasResponse, statusResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: ventasRange,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: statusRange,
    }),
  ]);
  console.log('[ventas-full] sheets_read_done', { mes: monthKey });

  const ventasRowsRaw = ventasResponse?.data?.values || [];
  const statusRowsRaw = statusResponse?.data?.values || [];

  console.log('[ventas-full] sheets_ventas_debug', {
    spreadsheet_id: spreadsheetId,
    sheet_name: SHEET_VENTAS,
    range: ventasRange,
    values_length: ventasRowsRaw.length,
    values: ventasRowsRaw,
  });

  if (!ventasRowsRaw || ventasRowsRaw.length < 2) {
    throw new Error(`La hoja de ventas "${SHEET_VENTAS}" está vacía o no contiene filas de datos. Verifica permisos del service account y spreadsheetId.`);
  }

  const headers = Array.isArray(ventasRowsRaw[0]) ? ventasRowsRaw[0] : [];
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const requiredHeaders = ['order_id', 'created_at', 'month_key'];
  const missingRequiredHeaders = requiredHeaders.filter((required) => !normalizedHeaders.includes(required));
  if (!headers.length || missingRequiredHeaders.length) {
    throw new Error(`La hoja de ventas "${SHEET_VENTAS}" está vacía o no contiene encabezados válidos (incluyendo "order_id").`);
  }
  const salesRows = headers.length ? ventasRowsRaw.slice(1) : [];
  const mappedHeaders = normalizedHeaders;
  const sampleRows = salesRows.slice(0, 3);
  const ventas = salesRows
    .map((row) => mapVenta(headers, row))
    .filter((venta) => venta.order_id && venta.month_key === monthKey)
    .sort((a, b) => dateDesc(a.created_at, b.created_at));

  const statusRows = (statusRowsRaw || []).slice(1);
  const status = parseStatusRows(statusRows);
  const statusKeys = Object.keys(status).filter((key) => status[key]);
  console.log('[ventas-full] dataset_stats', {
    mes: monthKey,
    spreadsheet_id: spreadsheetId,
    sheet_name: SHEET_VENTAS,
    range: ventasRange,
    total_rows: salesRows.length,
    filtered_rows: ventas.length,
    headers: mappedHeaders,
    sample_rows: sampleRows,
    status_keys: statusKeys,
  });
  const payload = {
    ok: true,
    mes: monthKey,
    resumen: buildResumen(ventas),
    status,
    ventas,
  };
  if (debug) {
    payload.debug = {
      spreadsheet_id: spreadsheetId,
      sheet_name: SHEET_VENTAS,
      total_rows: salesRows.length,
      filtered_rows: ventas.length,
      headers: mappedHeaders,
      sample_rows: sampleRows,
    };
  }

  setVentasFullCache(monthKey, payload);
  return payload;
}

export function getVentasFullStale(monthValue = '') {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const cached = getVentasFullCache(monthKey);
  return cached.stale || null;
}
