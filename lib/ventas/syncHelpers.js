import {
  appendSheetRowRaw,
  assertHeadersExist,
  assertSheetExists,
  createSheetsClient,
  getSheetHeadersRaw,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';
import { getCurrentMexicoMonthKey, getMexicoDateKey, getMexicoMonthKey } from './mexicoDate.js';

const FIXED_STORE_ID = '6432936';

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

function parseNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value)
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim());
  return Number.isFinite(parsed) ? parsed : fallback;
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

function toDateSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMonthFromDate(value) {
  const date = toDateSafe(value) || new Date();
  return getMexicoMonthKey(date);
}

function normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function splitCombinedStatus(value = '') {
  const raw = String(value || '');
  if (!raw.includes('/')) return ['', ''];
  return raw.split('/').map((part) => normalizeStatusToken(part)).filter(Boolean);
}

function normalizeVentaStatuses(record = {}) {
  const rawPayment = pickRecordValue(record, ['payment_status', 'estado_pago', 'pago', 'payment']);
  const rawFulfillment = pickRecordValue(record, ['fulfillment_status', 'estado_envio', 'envio', 'fulfillment']);
  const rawStatus = pickRecordValue(record, ['raw_status', 'status']);

  let paymentStatus = normalizeStatusToken(rawPayment);
  let fulfillmentStatus = normalizeStatusToken(rawFulfillment);

  if (paymentStatus.includes('/')) {
    const [paymentPart, fulfillmentPart] = splitCombinedStatus(paymentStatus);
    paymentStatus = paymentPart || '';
    if (!fulfillmentStatus && fulfillmentPart) fulfillmentStatus = fulfillmentPart;
  }

  if (fulfillmentStatus.includes('/')) {
    const [, fulfillmentPart] = splitCombinedStatus(fulfillmentStatus);
    fulfillmentStatus = fulfillmentPart || fulfillmentStatus;
  }

  if (!paymentStatus || !fulfillmentStatus) {
    const [paymentFromRaw, fulfillmentFromRaw] = splitCombinedStatus(rawStatus);
    if (!paymentStatus && paymentFromRaw) paymentStatus = paymentFromRaw;
    if (!fulfillmentStatus && fulfillmentFromRaw) fulfillmentStatus = fulfillmentFromRaw;
  }

  return {
    payment_status: paymentStatus,
    fulfillment_status: fulfillmentStatus,
    raw_status: normalizeStatusToken(rawStatus),
  };
}

function parseTicketNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const clean = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(clean)) return null;
  return Number(clean);
}

function isPaidVenta(venta = {}) {
  const paymentStatus = String(venta?.payment_status || '').trim().toLowerCase();
  return paymentStatus === 'paid';
}

function mapVentasConfig(record = {}) {
  return {
    store_id: pickRecordValue(record, ['store_id', 'storeid', 'tiendanube_store_id', 'user_id']),
    user_id: pickRecordValue(record, ['user_id', 'userid']),
    store_name: pickRecordValue(record, ['store_name', 'nombre_tienda']),
    app_id: pickRecordValue(record, ['app_id', 'client_id']),
    client_id: pickRecordValue(record, ['client_id', 'app_id']),
    access_token: pickRecordValue(record, ['access_token', 'token']),
    scope: pickRecordValue(record, ['scope']),
    default_commission_rate: normalizeCommissionRate(record.default_commission_rate, 0.1),
    active: !['false', '0', 'no'].includes(String(record.active ?? 'true').trim().toLowerCase()),
    connected_at: pickRecordValue(record, ['connected_at']),
    last_sync_at: pickRecordValue(record, ['last_sync_at']),
    created_at: pickRecordValue(record, ['created_at']),
    updated_at: pickRecordValue(record, ['updated_at']),
  };
}

function tiendanubeApiHeaders(accessToken) {
  const userAgent = String(process.env.TIENDANUBE_USER_AGENT || 'Haruja Ventas Sync (harujagdl.ventas@gmail.com)').trim();
  const token = String(accessToken || '').trim();

  return {
    Authentication: `bearer ${token}`,
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
  };
}

function tokenPreview(token) {
  const normalized = String(token || '').trim();
  return normalized ? `${normalized.slice(0, 6)}...` : 'EMPTY';
}

function buildTiendanubeError({ code = 'TIENDANUBE_ERROR', message = 'Error consultando Tiendanube', status = 500, details = {} } = {}) {
  const error = new Error(message);
  error.code = code;
  error.http_status = status;
  error.details = details;
  return error;
}

function getTiendanubeCredentials(providedAccessToken = '') {
  const tokenFromConfig = String(providedAccessToken || '').trim();
  if (tokenFromConfig) {
    return { accessToken: tokenFromConfig, tokenSource: 'VentasConfig.access_token' };
  }

  const tokenFromEnv = String(process.env.TIENDANUBE_ACCESS_TOKEN || '').trim();
  if (tokenFromEnv) {
    return { accessToken: tokenFromEnv, tokenSource: 'TIENDANUBE_ACCESS_TOKEN' };
  }

  return { accessToken: '', tokenSource: 'none' };
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getVentasConfigForSync() {
  const { headers, rows } = await readSheetTable('VentasConfig');
  if (!headers.length || !rows.length) return null;
  const selected = rows
    .map((row) => mapVentasConfig(rowToObject(headers, row)))
    .filter((config) => config.active !== false)
    .filter((config) => String(config.access_token || '').trim())
    .filter((config) => String(config.store_id || config.user_id || '').trim())
    .sort((a, b) => {
      const aTime = new Date(a.connected_at || a.updated_at || a.created_at || 0).getTime() || 0;
      const bTime = new Date(b.connected_at || b.updated_at || b.created_at || 0).getTime() || 0;
      return bTime - aTime;
    })[0] || null;
  if (!selected) return null;
  console.log('[ventas.config.selected]', {
    store_id: selected?.store_id || selected?.user_id || '',
    accessTokenPrefix: String(selected?.access_token || '').slice(0, 8),
    connected_at: selected?.connected_at || '',
    updated_at: selected?.updated_at || '',
  });
  return {
    ...selected,
    client_id: selected.client_id || String(process.env.TIENDANUBE_CLIENT_ID || process.env.TIENDANUBE_APP_ID || '').trim(),
    app_id: selected.app_id || String(process.env.TIENDANUBE_APP_ID || process.env.TIENDANUBE_CLIENT_ID || '').trim(),
    store_id: selected.store_id || selected.user_id || '',
  };
}

export function normalizeCommissionRate(value, fallback = 0.1) {
  const rate = parseNumber(value, fallback);
  return rate >= 0 ? rate : fallback;
}

export async function readSheetTable(sheetName, { readOnly = true, requiredHeaders = [] } = {}) {
  const sheets = createSheetsClient({ readOnly });
  await assertSheetExists(sheets, sheetName);
  console.log('[Sheets] Leyendo hoja:', sheetName, 'requiredHeaders:', requiredHeaders);
  const headers = await getSheetHeadersRaw(sheets, sheetName);
  if (!headers.length) {
    throw new Error(`La hoja ${sheetName} no tiene encabezados.`);
  }
  if (requiredHeaders.length) {
    assertHeadersExist(headers, requiredHeaders, sheetName);
  }
  const values = await readSheetRowsRaw(sheets, `${sheetName}!A2:ZZ`);
  return { sheets, headers, rows: values };
}

export async function ensureVentasTNHeaders(table) {
  const { sheets, headers } = table;
  if (!headers.length) throw new Error('La hoja VentasTN no tiene encabezados.');

  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const requiredHeaders = ['ticket_number', 'ticket_label', 'order_id', 'month_key', 'fecha_operativa'];
  let headersChanged = false;
  requiredHeaders.forEach((requiredHeader) => {
    if (!normalizedHeaders.includes(requiredHeader)) {
      headers.push(requiredHeader);
      normalizedHeaders.push(requiredHeader);
      headersChanged = true;
    }
  });

  if (headersChanged) {
    await updateSheetRowRaw(sheets, 'VentasTN!A1:ZZ1', headers);
  }

  const orderIdx = headers.findIndex((header) => normalizeHeader(header) === 'order_id');
  if (orderIdx < 0) throw new Error('La hoja VentasTN no tiene la columna order_id.');

  return { orderIdx };
}

export function collectExistingOrderIds(rows = [], orderIdx = 0) {
  const orderIds = new Set();
  rows.forEach((row) => {
    const orderId = String(row?.[orderIdx] || '').trim();
    if (orderId) orderIds.add(orderId);
  });
  return orderIds;
}

export function mapHeadersToRow(headers = [], record = {}) {
  return headers.map((header) => {
    const key = normalizeHeader(header);
    if (key === 'seller_assigned') return record[key] ? 'TRUE' : 'FALSE';
    return record[key] ?? '';
  });
}

export async function updateVentasConfigLastSync(sheets, headers = [], rows = [], value) {
  if (!headers.length || !rows.length) return;
  const idxStoreId = headers.findIndex((header) => normalizeHeader(header) === 'store_id');
  if (idxStoreId < 0) return;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || [];
    if (!String(row[idxStoreId] || '').trim()) continue;
    const rowNum = i + 2;
    const rowObj = rowToObject(headers, row);
    rowObj.last_sync_at = value;
    rowObj.updated_at = value;
    await updateSheetRowRaw(sheets, `VentasConfig!A${rowNum}:ZZ${rowNum}`, mapHeadersToRow(headers, rowObj));
    return;
  }
}

export function normalizeTiendanubeOrder(order = {}, defaultRate = 0.1) {
  const createdAt = String(order.created_at || order.createdAt || '').trim() || new Date().toISOString();
  const fechaOperativa = getMexicoDateKey(createdAt);
  const monthKey = getMonthFromDate(createdAt);
  const total = parseNumber(order.total || order.total_paid || order.total_amount, 0);
  const subtotal = parseNumber(order.subtotal || order.subtotal_amount, total);
  const discount = parseNumber(order.discount || order.discount_total || order.promotional_discount || 0, 0);
  const firstName = String(order?.customer?.first_name || order?.customer?.name || '').trim();
  const lastName = String(order?.customer?.last_name || '').trim();
  const customerName = `${firstName} ${lastName}`.trim();
  const orderIdRaw = order.id ?? order.number ?? order.order_number;
  const orderId = String(orderIdRaw || '').trim();
  if (!orderId) return null;
  const ticketNumber = parseTicketNumber(order.number ?? order.order_number ?? order.number_as_string ?? null);
  const ticketLabel = ticketNumber ? `#${ticketNumber}` : orderId;

  const commissionRate = normalizeCommissionRate(defaultRate, 0.1);
  const commissionableTotal = total;
  const commissionAmount = normalizeStatusToken(order.payment_status) === 'paid'
    ? (commissionableTotal * commissionRate)
    : 0;

  const statuses = normalizeVentaStatuses({
    payment_status: order.payment_status || order.gateway || order.payment_details || '',
    fulfillment_status: order.fulfillment_status || order.shipping_status || '',
    raw_status: order.status || order.payment_status || '',
  });

  return {
    order_id: orderId,
    ticket_number: ticketNumber,
    ticket_label: ticketLabel,
    created_at: createdAt,
    fecha_operativa: fechaOperativa,
    month_key: monthKey,
    monthKey,
    customer_name: customerName,
    total,
    subtotal,
    discount,
    payment_status: statuses.payment_status,
    fulfillment_status: statuses.fulfillment_status,
    channel: 'tiendanube',
    seller: '',
    seller_assigned: false,
    commissionable_total: commissionableTotal,
    commission_rate: commissionRate,
    commission_amount: commissionAmount,
    raw_status: statuses.raw_status,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function resolveTiendanubeConnection() {
  let config = null;
  try {
    config = await getVentasConfigForSync();
  } catch (error) {
    console.warn('[tiendanube:config-read-warning]', {
      message: String(error?.message || error),
    });
  }
  const envStoreId = String(process.env.TIENDANUBE_STORE_ID || '').trim();
  const configStoreId = String(config?.store_id || '').trim();
  const storeId = configStoreId || envStoreId || FIXED_STORE_ID;

  const envToken = String(process.env.TIENDANUBE_ACCESS_TOKEN || '').trim();
  const configToken = String(config?.access_token || '').trim();
  const accessToken = configToken || envToken;
  const tokenSource = configToken ? 'VentasConfig.access_token' : (envToken ? 'TIENDANUBE_ACCESS_TOKEN' : 'none');
  const storeSource = configStoreId ? 'VentasConfig.store_id' : (envStoreId ? 'TIENDANUBE_STORE_ID' : 'FIXED_STORE_ID');

  if (envStoreId && configStoreId && envStoreId !== configStoreId) {
    console.warn('[tiendanube:store-mismatch]', {
      env_store_id: envStoreId,
      config_store_id: configStoreId,
      selected_store_id: storeId,
      selected_source: storeSource,
    });
  }

  return {
    config,
    storeId,
    accessToken,
    tokenSource,
    storeSource,
  };
}

export async function fetchTiendanubeOrders(storeId, providedAccessToken = '', options = {}) {
  const normalizedStoreId = String(storeId || '').trim();
  if (!normalizedStoreId) throw new Error('store_id es obligatorio para sincronizar.');

  const envStoreId = String(process.env.TIENDANUBE_STORE_ID || '').trim();
  const configStoreId = String(options?.configStoreId || '').trim();
  const selectedStoreSource = String(options?.storeSource || '').trim() || (envStoreId ? 'TIENDANUBE_STORE_ID' : 'FIXED_STORE_ID');
  const selectedTokenSource = String(options?.tokenSource || '').trim();

  const { accessToken, tokenSource } = getTiendanubeCredentials(providedAccessToken);
  const effectiveTokenSource = selectedTokenSource || tokenSource;

  console.log('[tiendanube:credentials]', {
    token_exists: Boolean(accessToken),
    token_preview: tokenPreview(accessToken),
    token_source: effectiveTokenSource,
    store_source: selectedStoreSource,
    store_id: normalizedStoreId,
    env_store_id: envStoreId || 'EMPTY',
    config_store_id: configStoreId || 'EMPTY',
  });

  if (envStoreId && configStoreId && envStoreId !== configStoreId) {
    console.warn('[tiendanube:credentials-mismatch]', {
      reason: 'Store ID de entorno difiere de VentasConfig.store_id; se prioriza VentasConfig.store_id.',
      env_store_id: envStoreId,
      config_store_id: configStoreId,
      selected_store_id: normalizedStoreId,
      store_source: selectedStoreSource,
      token_source: effectiveTokenSource,
    });
  }

  if (!accessToken) {
    throw new Error('Falta TIENDANUBE_ACCESS_TOKEN en variables de entorno (Production) o en VentasConfig.access_token.');
  }

  const maxPages = Math.max(1, parseInt(process.env.TIENDANUBE_SYNC_MAX_PAGES || '5', 10) || 5);
  const perPage = Math.max(1, parseInt(process.env.TIENDANUBE_SYNC_PER_PAGE || '200', 10) || 200);

  const allOrders = [];
  const updatedAtMin = String(options.updatedAtMin || '').trim();
  const createdAtMin = String(options.createdAtMin || '').trim();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/orders`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    if (updatedAtMin) url.searchParams.set('updated_at_min', updatedAtMin);
    if (createdAtMin) url.searchParams.set('created_at_min', createdAtMin);
    console.log('TN sync URL', url.toString());
    console.log('TN storeId', normalizedStoreId);
    console.log('TN token exists', Boolean(accessToken));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: tiendanubeApiHeaders(accessToken),
    });

    const payload = await parseResponseJson(response);

    console.log('[tiendanube:orders:response]', {
      status: response.status,
      ok: response.ok,
      page,
      store_id: normalizedStoreId,
      body_preview: payload ? JSON.stringify(payload).slice(0, 400) : 'EMPTY',
    });

    if (!response.ok) {
      const errorBody = payload ? JSON.stringify(payload) : '';
      console.error('TN sync failed', {
        status: response.status,
        body: errorBody,
      });
      const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
      const endpoint = '/orders';
      const errorDetails = {
        store_id: normalizedStoreId,
        endpoint,
        request_url: url.toString(),
        params: {
          page,
          per_page: perPage,
          updated_at_min: updatedAtMin || '',
          created_at_min: createdAtMin || '',
        },
        status: response.status,
        body_preview: payload ? JSON.stringify(payload).slice(0, 500) : '',
      };
      if (response.status === 401) {
        throw buildTiendanubeError({
          code: 'TIENDANUBE_AUTH_ERROR',
          status: 401,
          message: `No fue posible autenticar con Tiendanube. Revisa token o variables del servidor. Detalle: ${detail}`,
          details: errorDetails,
        });
      }
      if (response.status === 404) {
        throw buildTiendanubeError({
          code: 'TIENDANUBE_NOT_FOUND',
          status: 404,
          message: 'Recurso no encontrado en Tiendanube',
          details: errorDetails,
        });
      }
      throw buildTiendanubeError({
        code: 'TIENDANUBE_REQUEST_FAILED',
        status: response.status,
        message: `Error consultando Tiendanube: ${detail}`,
        details: errorDetails,
      });
    }

    const pageOrders = Array.isArray(payload) ? payload : [];
    allOrders.push(...pageOrders);
    if (pageOrders.length < perPage) break;
  }

  return allOrders;
}

export async function rebuildVentasResumen(monthValue) {
  const monthKey = String(monthValue || '').trim() || getCurrentMexicoMonthKey();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('Mes inválido para recalcular VentasResumen.');

  const ventasTable = await readSheetTable('VentasTN');
  const ventasHeaders = ventasTable.headers;
  const ventas = ventasTable.rows
    .map((row) => rowToObject(ventasHeaders, row))
    .filter((venta) => String(venta.month_key || getMonthFromDate(venta.created_at) || '').trim() === monthKey)
    .filter((venta) => isPaidVenta(venta));

  const totalMes = ventas.reduce((acc, venta) => acc + parseNumber(venta.total_pagado ?? venta.total_paid ?? venta.total ?? venta.venta, 0), 0);
  const totalHaru = ventas
    .filter((venta) => String(venta.seller || '').trim().toLowerCase() === 'haru')
    .reduce((acc, venta) => acc + parseNumber(venta.total_pagado ?? venta.total_paid ?? venta.total ?? venta.venta, 0), 0);
  const totalVendedora = ventas
    .filter((venta) => String(venta.seller || '').trim().toLowerCase() === 'vendedora')
    .reduce((acc, venta) => acc + parseNumber(venta.total_pagado ?? venta.total_paid ?? venta.total ?? venta.venta, 0), 0);
  const sinAsignar = ventas.filter((venta) => !String(venta.seller || '').trim()).length;
  const comisionTotal = ventas.reduce((acc, venta) => acc + parseNumber(venta.commission_amount, 0), 0);
  const ordersCount = ventas.length;
  const now = new Date().toISOString();

  const summary = {
    month_key: monthKey,
    total_mes: totalMes,
    total_haru: totalHaru,
    total_vendedora: totalVendedora,
    sin_asignar: sinAsignar,
    comision_total: comisionTotal,
    orders_count: ordersCount,
    ticket_promedio: ordersCount ? totalMes / ordersCount : 0,
    updated_at: now,
  };

  console.log('[ventas.resumen.rebuild.result]', {
    monthKey,
    total_mes: summary.total_mes,
    orders_count: summary.orders_count,
    sin_asignar: summary.sin_asignar,
    total_haru: summary.total_haru,
    total_vendedora: summary.total_vendedora,
    ticket_promedio: summary.ticket_promedio,
  });

  const resumenTable = await readSheetTable('VentasResumen', { readOnly: false, requiredHeaders: ['month_key'] });
  const { sheets, headers, rows } = resumenTable;
  if (!headers.length) throw new Error('La hoja VentasResumen no tiene encabezados.');

  const idxMonth = headers.findIndex((header) => normalizeHeader(header) === 'month_key');
  if (idxMonth < 0) throw new Error('La hoja VentasResumen no tiene la columna month_key.');

  const requiredResumenHeaders = ['month_key', 'total_mes', 'total_haru', 'total_vendedora', 'sin_asignar', 'comision_total', 'orders_count', 'ticket_promedio', 'updated_at'];
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  let headersChanged = false;
  requiredResumenHeaders.forEach((requiredHeader) => {
    if (!normalizedHeaders.includes(requiredHeader)) {
      headers.push(requiredHeader);
      normalizedHeaders.push(requiredHeader);
      headersChanged = true;
    }
  });
  if (headersChanged) {
    await updateSheetRowRaw(sheets, 'VentasResumen!A1:ZZ1', headers);
  }

  const rowValues = mapHeadersToRow(headers, summary);
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i]?.[idxMonth] || '').trim() === monthKey) {
      rowIndex = i;
      break;
    }
  }

  if (rowIndex >= 0) {
    const rowNumber = rowIndex + 2;
    await updateSheetRowRaw(sheets, `VentasResumen!A${rowNumber}:ZZ${rowNumber}`, rowValues);
  } else {
    await appendSheetRowRaw(sheets, 'VentasResumen', rowValues);
  }

  return summary;
}
