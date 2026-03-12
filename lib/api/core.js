import { getCatalogos as getCatalogosRaw } from './catalogos.js';
import { archivePrenda, createPrenda, deletePrenda, listPrendas } from './prendas.js';
import { importCorrections, listArchivedPrendas, restorePrenda } from './prendasAdmin.js';
import {
  appendSheetRowRaw,
  createSheetsClient,
  getSheetHeadersRaw,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function safeJson(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error(text || `Respuesta inválida del backend (${response.status}).`);
  }
  return JSON.parse(text || '{}');
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  if (!month) return '';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Mes inválido. Usa formato YYYY-MM.');
  return month;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function rowToObject(headers = [], row = []) {
  const record = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    record[normalized] = row?.[index] ?? '';
  });
  return record;
}

function pickRecordValue(record = {}, keys = []) {
  for (const key of keys) {
    const value = record?.[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readSheetTable(sheetName, { readOnly = true } = {}) {
  const sheets = createSheetsClient({ readOnly });
  const headers = await getSheetHeadersRaw(sheets, sheetName);
  if (!headers.length) return { sheets, headers: [], rows: [] };
  const values = await readSheetRowsRaw(sheets, `${sheetName}!A2:ZZ`);
  return { sheets, headers, rows: values };
}

function mapVentasConfig(record = {}) {
  return {
    store_id: pickRecordValue(record, ['store_id', 'storeid']),
    store_name: pickRecordValue(record, ['store_name', 'storename']),
    default_commission_rate: parseNumber(record.default_commission_rate, 0.1),
    active: ['false', '0', 'no'].includes(String(record.active ?? '').trim().toLowerCase()) ? false : true,
    last_sync_at: pickRecordValue(record, ['last_sync_at']) || null,
    created_at: pickRecordValue(record, ['created_at']) || null,
    updated_at: pickRecordValue(record, ['updated_at']) || null,
  };
}

function mapVentasResumen(record = {}, monthKey) {
  return {
    month_key: pickRecordValue(record, ['month_key']) || monthKey,
    total_mes: parseNumber(record.total_mes, 0),
    total_sam: parseNumber(record.total_sam, 0),
    total_haru: parseNumber(record.total_haru, 0),
    sin_asignar: parseNumber(record.sin_asignar, 0),
    comision_total: parseNumber(record.comision_total, 0),
    orders_count: parseNumber(record.orders_count, 0),
    updated_at: pickRecordValue(record, ['updated_at']) || null,
  };
}

function defaultVentasResumen(monthKey) {
  return {
    month_key: monthKey,
    total_mes: 0,
    total_sam: 0,
    total_haru: 0,
    sin_asignar: 0,
    comision_total: 0,
    orders_count: 0,
    updated_at: null,
  };
}

export async function getCatalogos() {
  return getCatalogosRaw();
}

export { listPrendas, createPrenda, deletePrenda, archivePrenda, listArchivedPrendas, restorePrenda, importCorrections };

export async function getVentasConfig() {
  const { headers, rows } = await readSheetTable('VentasConfig');
  if (!headers.length || !rows.length) return null;
  for (const row of rows) {
    const mapped = mapVentasConfig(rowToObject(headers, row));
    if (mapped.store_id) return mapped;
  }
  return null;
}

export async function saveVentasConfig(payload = {}) {
  const storeId = String(payload.store_id || '').trim();
  if (!storeId) throw new Error('store_id es obligatorio.');

  const storeName = String(payload.store_name || '').trim();
  const defaultRate = payload.default_commission_rate === undefined || payload.default_commission_rate === null || payload.default_commission_rate === ''
    ? 0.1
    : parseNumber(payload.default_commission_rate, 0.1);
  const active = payload.active === undefined || payload.active === null || payload.active === ''
    ? true
    : !['false', '0', 'no'].includes(String(payload.active).trim().toLowerCase());
  const now = new Date().toISOString();

  const { sheets, headers, rows } = await readSheetTable('VentasConfig', { readOnly: false });
  if (!headers.length) throw new Error('La hoja VentasConfig no tiene encabezados.');

  const indexByHeader = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  const rowValuesFromPayload = (createdAtValue) => headers.map((header) => {
    const normalized = normalizeHeader(header);
    if (normalized === 'store_id') return storeId;
    if (normalized === 'store_name') return storeName;
    if (normalized === 'default_commission_rate') return defaultRate;
    if (normalized === 'active') return active ? 'TRUE' : 'FALSE';
    if (normalized === 'created_at') return createdAtValue || now;
    if (normalized === 'updated_at') return now;
    if (normalized === 'last_sync_at') return '';
    return '';
  });

  let existingRowNumber = null;
  let existingCreatedAt = '';
  rows.forEach((row, idx) => {
    if (existingRowNumber) return;
    const currentStoreId = String(row?.[indexByHeader.get('store_id')] || '').trim();
    if (currentStoreId) {
      existingRowNumber = idx + 2;
      existingCreatedAt = String(row?.[indexByHeader.get('created_at')] || '').trim();
    }
  });

  if (existingRowNumber) {
    await updateSheetRowRaw(sheets, `VentasConfig!A${existingRowNumber}:ZZ${existingRowNumber}`, rowValuesFromPayload(existingCreatedAt));
  } else {
    await appendSheetRowRaw(sheets, 'VentasConfig', rowValuesFromPayload(now));
  }

  return {
    store_id: storeId,
    store_name: storeName,
    default_commission_rate: defaultRate,
    active,
    last_sync_at: null,
    created_at: existingCreatedAt || now,
    updated_at: now,
  };
}

export async function getVentasResumen(monthValue) {
  let monthKey = '';
  try {
    monthKey = normalizeMonth(monthValue) || currentMonthKey();
  } catch {
    monthKey = currentMonthKey();
  }

  const { headers, rows } = await readSheetTable('VentasResumen');
  if (!headers.length || !rows.length) return defaultVentasResumen(monthKey);

  const summaryRow = rows.find((row) => {
    const record = rowToObject(headers, row);
    return pickRecordValue(record, ['month_key']) === monthKey;
  });

  if (!summaryRow) return defaultVentasResumen(monthKey);
  return mapVentasResumen(rowToObject(headers, summaryRow), monthKey);
}

export async function getVentasComisiones(params = {}, reqLike = {}) {
  const storeId = String(params.storeId || '').trim();
  const month = normalizeMonth(params.month);
  if (!storeId) throw new Error('storeId es requerido.');

  const baseUrl = getBaseUrl(reqLike);
  if (!baseUrl) throw new Error('No se pudo resolver la URL base de la app.');

  const url = new URL('/dashboard/sales-details', baseUrl);
  url.searchParams.set('storeId', storeId);
  if (month) url.searchParams.set('month', month);

  const response = await fetch(url.toString(), { method: 'GET' });
  const payload = await safeJson(response);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || 'No se pudieron cargar ventas.');
  }

  return {
    summary: {
      totalMes: Number(payload?.totalMes) || 0,
      totalSinAsignar: Number(payload?.totalSinAsignar) || 0,
      totalPorVendedora: Array.isArray(payload?.totalPorVendedora) ? payload.totalPorVendedora : [],
    },
    orders: Array.isArray(payload?.orders) ? payload.orders : [],
  };
}

export async function updateVentasComisiones(payload = {}, reqLike = {}) {
  const orderId = String(payload.orderId || '').trim();
  const seller = String(payload.seller || '').trim();
  if (!orderId) throw new Error('orderId es requerido.');

  const baseUrl = getBaseUrl(reqLike);
  if (!baseUrl) throw new Error('No se pudo resolver la URL base de la app.');

  const url = new URL('/dashboard/order-seller', baseUrl);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, seller }),
  });
  const result = await safeJson(response);
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || 'No se pudo guardar la vendedora.');
  }

  return { orderId, seller };
}
