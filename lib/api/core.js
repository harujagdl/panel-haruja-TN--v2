import { getCatalogos as getCatalogosRaw } from './catalogos.js';
import { archivePrenda, createPrenda, deletePrenda, listPrendas } from './prendas.js';
import { importCorrections, listArchivedPrendas, restorePrenda } from './prendasAdmin.js';
import {
  appendSheetRowRaw,
  assertHeadersExist,
  assertSheetExists,
  createSheetsClient,
  getSheetHeadersRaw,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';

export const SELLERS = ['Haru', 'Vendedora'];

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

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return fallback;
}

function getMonthFromDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return currentMonthKey();
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sortDateDesc(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
}

function canonicalSeller(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'haru') return 'Haru';
  if (lower === 'vendedora') return 'Vendedora';
  return '';
}

function normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase();
}

function splitCombinedStatus(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split('/').map((part) => normalizeStatusToken(part)).filter(Boolean);
}

function normalizeVentaStatuses(record = {}) {
  const rawPayment = pickRecordValue(record, ['payment_status']);
  const rawFulfillment = pickRecordValue(record, ['fulfillment_status']);
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

function isPaidVenta(venta = {}) {
  const paymentStatus = String(venta?.payment_status || '').trim().toLowerCase();
  return paymentStatus === 'paid';
}

function normalizeCommissionRate(value, fallback = 0.1) {
  const rate = parseNumber(value, fallback);
  return rate >= 0 ? rate : fallback;
}

async function readSheetTable(sheetName, { readOnly = true, requiredHeaders = [] } = {}) {
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

function mapVentasConfig(record = {}) {
  return {
    store_id: pickRecordValue(record, ['store_id', 'storeid']),
    store_name: pickRecordValue(record, ['store_name', 'storename']),
    app_id: pickRecordValue(record, ['app_id', 'appid']),
    access_token: pickRecordValue(record, ['access_token', 'accesstoken']),
    default_commission_rate: normalizeCommissionRate(record.default_commission_rate, 0.1),
    active: ['false', '0', 'no'].includes(String(record.active ?? '').trim().toLowerCase()) ? false : true,
    connected_at: pickRecordValue(record, ['connected_at']) || null,
    last_sync_at: pickRecordValue(record, ['last_sync_at']) || null,
    created_at: pickRecordValue(record, ['created_at']) || null,
    updated_at: pickRecordValue(record, ['updated_at']) || null,
  };
}

async function ensureVentasConfigHeaders(sheets, headers = []) {
  const requiredHeaders = [
    'store_id',
    'store_name',
    'app_id',
    'access_token',
    'default_commission_rate',
    'active',
    'connected_at',
    'created_at',
    'updated_at',
  ];
  const normalized = headers.map((header) => normalizeHeader(header));
  let changed = false;

  requiredHeaders.forEach((requiredHeader) => {
    if (!normalized.includes(requiredHeader)) {
      headers.push(requiredHeader);
      normalized.push(requiredHeader);
      changed = true;
    }
  });

  if (changed) {
    await updateSheetRowRaw(sheets, 'VentasConfig!A1:ZZ1', headers);
  }

  return headers;
}

function mapVentasResumen(record = {}, monthKey) {
  return {
    month_key: pickRecordValue(record, ['month_key']) || monthKey,
    total_mes: parseNumber(record.total_mes, 0),
    total_haru: parseNumber(record.total_haru, 0),
    total_vendedora: parseNumber(record.total_vendedora, 0),
    sin_asignar: parseNumber(record.sin_asignar, 0),
    comision_total: parseNumber(record.comision_total, 0),
    orders_count: parseNumber(record.orders_count, 0),
    ticket_promedio: parseNumber(record.ticket_promedio, 0),
    updated_at: pickRecordValue(record, ['updated_at']) || null,
  };
}

function defaultVentasResumen(monthKey) {
  return {
    month_key: monthKey,
    total_mes: 0,
    total_haru: 0,
    total_vendedora: 0,
    sin_asignar: 0,
    comision_total: 0,
    orders_count: 0,
    ticket_promedio: 0,
    updated_at: null,
  };
}

function mapVentaTN(record = {}) {
  const total = parseNumber(record.total, 0);
  const commissionableTotal = parseNumber(record.commissionable_total, total);
  const commissionRate = normalizeCommissionRate(record.commission_rate, 0.1);
  const seller = canonicalSeller(record.seller);
  const sellerAssigned = parseBoolean(record.seller_assigned, Boolean(seller));
  const createdAt = pickRecordValue(record, ['created_at']) || '';
  const ticketNumber = parseTicketNumber(
    pickRecordValue(record, ['ticket_number'])
    ?? pickRecordValue(record, ['order_number'])
    ?? pickRecordValue(record, ['number'])
  );
  const storedTicketLabel = pickRecordValue(record, ['ticket_label']);
  const ticketLabel = storedTicketLabel || (ticketNumber ? `#${ticketNumber}` : null);

  const statuses = normalizeVentaStatuses(record);

  return {
    order_id: pickRecordValue(record, ['order_id']),
    ticket_number: ticketNumber,
    ticket_label: ticketLabel,
    created_at: createdAt,
    month_key: pickRecordValue(record, ['month_key']) || getMonthFromDate(createdAt),
    customer_name: pickRecordValue(record, ['customer_name']),
    total,
    subtotal: parseNumber(record.subtotal, total),
    discount: parseNumber(record.discount, 0),
    payment_status: statuses.payment_status,
    fulfillment_status: statuses.fulfillment_status,
    channel: pickRecordValue(record, ['channel']) || 'tiendanube',
    seller,
    seller_assigned: seller ? sellerAssigned : false,
    commissionable_total: commissionableTotal,
    commission_rate: commissionRate,
    commission_amount: parseNumber(record.commission_amount, commissionableTotal * commissionRate),
    raw_status: statuses.raw_status,
    last_sync_at: pickRecordValue(record, ['last_sync_at']) || '',
    updated_at: pickRecordValue(record, ['updated_at']) || '',
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

function mapHeadersToRow(headers = [], record = {}) {
  return headers.map((header) => {
    const key = normalizeHeader(header);
    if (key === 'seller_assigned') return record[key] ? 'TRUE' : 'FALSE';
    return record[key] ?? '';
  });
}

async function updateVentasConfigLastSync(sheets, headers = [], rows = [], value) {
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

function normalizeTiendanubeOrder(order = {}, defaultRate = 0.1) {
  const createdAt = String(order.created_at || order.createdAt || '').trim() || new Date().toISOString();
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
  const ticketLabel = ticketNumber ? `#${ticketNumber}` : null;

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
    month_key: getMonthFromDate(createdAt),
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

function resolveWebhookEvent(reqLike = {}, body = {}) {
  const eventFromHeaders = reqLike?.headers?.['x-tiendanube-event'] || reqLike?.headers?.['x-linkedstore-topic'];
  const eventFromBody = body?.event || body?.topic || body?.name;
  return normalizeStatusToken(eventFromHeaders || eventFromBody);
}

function extractOrderIdFromPayload(payload = {}) {
  const fromOrder = payload?.order?.id ?? payload?.order?.number ?? payload?.order?.order_number;
  const fromDirect = payload?.id ?? payload?.order_id ?? payload?.resource_id;
  const fromResource = String(payload?.resource || payload?.resource_url || '').match(/\/orders\/(\d+)/i)?.[1];
  const value = fromOrder ?? fromDirect ?? fromResource;
  return String(value || '').trim();
}

const TIENDANUBE_WEBHOOK_EVENTS = [
  'order/created',
  'order/updated',
  'order/paid',
  'order/fulfilled',
  'order/cancelled',
  'order/pending',
  'order/voided',
  'order/unpacked',
];

function isOrderWebhookEvent(eventName = '') {
  return normalizeStatusToken(eventName).startsWith('order/');
}

function tiendanubeApiHeaders(accessToken) {
  const userAgent = String(process.env.TIENDANUBE_USER_AGENT || 'Haruja Ventas Sync (harujagdl.ventas@gmail.com)').trim();
  return {
    Authentication: `bearer ${String(accessToken || '').trim()}`,
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
  };
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchTiendanubeOrderById(storeId, accessToken, orderId) {
  const normalizedStoreId = String(storeId || '').trim();
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedStoreId) throw new Error('store_id es obligatorio para consultar orden de Tiendanube.');
  if (!normalizedOrderId) throw new Error('order_id es obligatorio para consultar orden de Tiendanube.');

  const response = await fetch(`https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/orders/${encodeURIComponent(normalizedOrderId)}`, {
    method: 'GET',
    headers: tiendanubeApiHeaders(accessToken),
  });
  const payload = await parseResponseJson(response);

  if (!response.ok || !payload) {
    const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Error consultando orden ${normalizedOrderId} en Tiendanube: ${detail}`);
  }

  return payload;
}

export async function fetchTiendanubeOrders(storeId, providedAccessToken = '') {
  const normalizedStoreId = String(storeId || '').trim();
  if (!normalizedStoreId) throw new Error('store_id es obligatorio para sincronizar.');

  const accessToken = String(
    providedAccessToken
    || process.env.TIENDANUBE_ACCESS_TOKEN
    || process.env.NUVEMSHOP_ACCESS_TOKEN
    || process.env.TIENDANUBE_TOKEN
    || ''
  ).trim();
  if (!accessToken) throw new Error('Falta TIENDANUBE_ACCESS_TOKEN para sincronizar ventas.');

  const maxPages = Math.max(1, parseInt(process.env.TIENDANUBE_SYNC_MAX_PAGES || '5', 10) || 5);
  const perPage = Math.max(1, parseInt(process.env.TIENDANUBE_SYNC_PER_PAGE || '200', 10) || 200);

  const allOrders = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/orders`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: tiendanubeApiHeaders(accessToken),
    });

    const payload = await parseResponseJson(response);

    if (!response.ok) {
      const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`Error consultando Tiendanube: ${detail}`);
    }

    const pageOrders = Array.isArray(payload) ? payload : [];
    allOrders.push(...pageOrders);
    if (pageOrders.length < perPage) break;
  }

  return allOrders;
}

export async function getCatalogos() {
  try {
    return await getCatalogosRaw();
  } catch (error) {
    throw new Error(`No se pudieron cargar los diccionarios desde Sheets. ${error?.message || ''}`.trim());
  }
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
    : normalizeCommissionRate(payload.default_commission_rate, 0.1);
  const active = payload.active === undefined || payload.active === null || payload.active === ''
    ? true
    : !['false', '0', 'no'].includes(String(payload.active).trim().toLowerCase());
  const now = new Date().toISOString();

  const { sheets, headers, rows } = await readSheetTable('VentasConfig', { readOnly: false });
  if (!headers.length) throw new Error('La hoja VentasConfig no tiene encabezados.');
  await ensureVentasConfigHeaders(sheets, headers);

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
    app_id: null,
    access_token: null,
    default_commission_rate: defaultRate,
    active,
    connected_at: null,
    last_sync_at: null,
    created_at: existingCreatedAt || now,
    updated_at: now,
  };
}

export async function saveTiendanubeOAuthConfig(payload = {}) {
  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) throw new Error('No se recibió access_token de Tiendanube.');

  const appId = String(payload.app_id || process.env.TIENDANUBE_APP_ID || '').trim();
  if (!appId) throw new Error('Falta TIENDANUBE_APP_ID para guardar OAuth.');

  const incomingStoreId = String(payload.store_id || '').trim();
  const existingConfig = await getVentasConfig();
  const storeId = incomingStoreId || String(existingConfig?.store_id || '').trim();
  if (!storeId) throw new Error('No se encontró store_id para la tienda. Verifica configuración.');

  const storeName = String(payload.store_name || existingConfig?.store_name || '').trim();
  const defaultRate = normalizeCommissionRate(payload.default_commission_rate ?? existingConfig?.default_commission_rate, 0.1);
  const active = payload.active === undefined
    ? (existingConfig?.active ?? true)
    : !['false', '0', 'no'].includes(String(payload.active).trim().toLowerCase());

  const now = new Date().toISOString();

  const table = await readSheetTable('VentasConfig', { readOnly: false });
  const { sheets, headers, rows } = table;
  if (!headers.length) throw new Error('La hoja VentasConfig no tiene encabezados.');
  await ensureVentasConfigHeaders(sheets, headers);

  const indexByHeader = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  const buildRow = (createdAtValue, lastSyncAtValue = '') => headers.map((header) => {
    const key = normalizeHeader(header);
    if (key === 'store_id') return storeId;
    if (key === 'store_name') return storeName;
    if (key === 'app_id') return appId;
    if (key === 'access_token') return accessToken;
    if (key === 'default_commission_rate') return defaultRate;
    if (key === 'active') return active ? 'TRUE' : 'FALSE';
    if (key === 'connected_at') return now;
    if (key === 'created_at') return createdAtValue || now;
    if (key === 'updated_at') return now;
    if (key === 'last_sync_at') return lastSyncAtValue;
    return '';
  });

  let existingRowNumber = null;
  let existingCreatedAt = '';
  let existingLastSyncAt = '';

  rows.forEach((row, idx) => {
    if (existingRowNumber) return;
    const currentStoreId = String(row?.[indexByHeader.get('store_id')] || '').trim();
    if (!currentStoreId) return;
    existingRowNumber = idx + 2;
    existingCreatedAt = String(row?.[indexByHeader.get('created_at')] || '').trim();
    existingLastSyncAt = String(row?.[indexByHeader.get('last_sync_at')] || '').trim();
  });

  if (existingRowNumber) {
    await updateSheetRowRaw(sheets, `VentasConfig!A${existingRowNumber}:ZZ${existingRowNumber}`, buildRow(existingCreatedAt, existingLastSyncAt));
  } else {
    await appendSheetRowRaw(sheets, 'VentasConfig', buildRow(now, ''));
  }

  return {
    store_id: storeId,
    store_name: storeName,
    app_id: appId,
    access_token: accessToken,
    default_commission_rate: defaultRate,
    active,
    connected_at: now,
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

  const { headers, rows } = await readSheetTable('VentasResumen', { requiredHeaders: ['month_key'] });
  if (!headers.length || !rows.length) return defaultVentasResumen(monthKey);

  const summaryRow = rows.find((row) => {
    const record = rowToObject(headers, row);
    return pickRecordValue(record, ['month_key']) === monthKey;
  });

  if (!summaryRow) return defaultVentasResumen(monthKey);
  return mapVentasResumen(rowToObject(headers, summaryRow), monthKey);
}

export async function getVentasDetalle(monthValue, searchValue = "") {
  const searchTerm = String(searchValue || "").trim().toLowerCase();
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const { headers, rows } = await readSheetTable('VentasTN', { requiredHeaders: ['order_id', 'month_key'] });
  if (!headers.length || !rows.length) return [];

  return rows
    .map((row) => mapVentaTN(rowToObject(headers, row)))
    .filter((venta) => venta.order_id && venta.month_key === monthKey)
    .filter((venta) => {
      if (!searchTerm) return true;
      const searchable = [
        venta.ticket_label,
        venta.ticket_number,
        venta.order_id,
        venta.customer_name,
      ]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      return searchable.includes(searchTerm);
    })
    .sort((a, b) => sortDateDesc(a.created_at, b.created_at));
}

export async function getVentasSinAsignar(monthValue) {
  const ventas = await getVentasDetalle(monthValue);
  return ventas.filter((venta) => !venta.seller || !venta.seller_assigned);
}

export async function upsertVentaTN(venta = {}, context = null) {
  if (!venta || !String(venta.order_id || '').trim()) {
    throw new Error('order_id es obligatorio para upsert en VentasTN.');
  }

  const ventaNormalized = mapVentaTN(venta);
  const table = context || await readSheetTable('VentasTN', { readOnly: false });
  const { sheets, headers, rows } = table;
  if (!headers.length) throw new Error('La hoja VentasTN no tiene encabezados.');

  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  let headersChanged = false;
  ['ticket_number', 'ticket_label'].forEach((requiredHeader) => {
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

  let rowIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i]?.[orderIdx] || '').trim() === ventaNormalized.order_id) {
      rowIndex = i;
      break;
    }
  }

  const rowValues = mapHeadersToRow(headers, ventaNormalized);

  if (rowIndex >= 0) {
    const existingVenta = mapVentaTN(rowToObject(headers, rows[rowIndex] || []));
    if (existingVenta.seller && existingVenta.seller_assigned && (!ventaNormalized.seller || !ventaNormalized.seller_assigned)) {
      ventaNormalized.seller = existingVenta.seller;
      ventaNormalized.seller_assigned = true;
      ventaNormalized.commission_rate = existingVenta.commission_rate || ventaNormalized.commission_rate;
      ventaNormalized.commission_amount = existingVenta.commission_amount || ventaNormalized.commission_amount;
    }

    const rowNumber = rowIndex + 2;
    const rowValues = mapHeadersToRow(headers, ventaNormalized);
    await updateSheetRowRaw(sheets, `VentasTN!A${rowNumber}:ZZ${rowNumber}`, rowValues);
    rows[rowIndex] = rowValues;
    return { action: 'updated', rowNumber, venta: ventaNormalized };
  }

  await appendSheetRowRaw(sheets, 'VentasTN', rowValues);
  rows.push(rowValues);
  return { action: 'inserted', rowNumber: rows.length + 1, venta: ventaNormalized };
}

export async function rebuildVentasResumen(monthValue) {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const now = new Date().toISOString();

  const { headers: ventasHeaders, rows: ventasRows } = await readSheetTable('VentasTN', { requiredHeaders: ['order_id', 'month_key', 'total'] });
  const monthRows = (ventasRows || [])
    .map((row) => mapVentaTN(rowToObject(ventasHeaders, row)))
    .filter((venta) => venta.order_id && venta.month_key === monthKey);

  const paidRows = monthRows.filter((venta) => isPaidVenta(venta));

  const summary = {
    month_key: monthKey,
    total_mes: 0,
    total_haru: 0,
    total_vendedora: 0,
    sin_asignar: 0,
    comision_total: 0,
    orders_count: paidRows.length,
    ticket_promedio: 0,
    updated_at: now,
  };

  paidRows.forEach((venta) => {
    const total = parseNumber(venta.total, 0);
    const commissionAmount = parseNumber(venta.commission_amount, 0);
    summary.total_mes += total;
    summary.comision_total += commissionAmount;

    const seller = canonicalSeller(venta.seller);

    if (seller === 'Haru') summary.total_haru += total;
    if (seller === 'Vendedora') summary.total_vendedora += total;
    if (!seller) summary.sin_asignar += 1;
  });

  summary.ticket_promedio = summary.orders_count > 0 ? (summary.total_mes / summary.orders_count) : 0;

  console.log('[ventas-resumen]', {
    monthKey,
    monthRows: monthRows.length,
    paidRows: paidRows.length,
    total_mes: summary.total_mes,
    total_haru: summary.total_haru,
    total_vendedora: summary.total_vendedora,
    sin_asignar: summary.sin_asignar,
    comision_total: summary.comision_total,
    orders_count: summary.orders_count,
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
    console.log('[ventas-resumen] updated month:', monthKey);
  } else {
    await appendSheetRowRaw(sheets, 'VentasResumen', rowValues);
    console.log('[ventas-resumen] inserted month:', monthKey);
  }

  return summary;
}

export async function syncVentasFromTiendanube() {
  const config = await getVentasConfig();
  const storeId = String(config?.store_id || process.env.TIENDANUBE_STORE_ID || '').trim();
  if (!storeId) throw new Error('No hay store_id configurado en VentasConfig.');

  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  const rawOrders = await fetchTiendanubeOrders(storeId, config?.access_token || '');
  const normalizedOrders = rawOrders
    .map((order) => normalizeTiendanubeOrder(order, defaultRate))
    .filter(Boolean);

  const table = await readSheetTable('VentasTN', { readOnly: false });

  let inserted = 0;
  let updated = 0;
  const monthsTouched = new Set();

  for (const venta of normalizedOrders) {
    const result = await upsertVentaTN(venta, table);
    if (result.action === 'inserted') inserted += 1;
    if (result.action === 'updated') updated += 1;
    monthsTouched.add(result.venta.month_key);
  }

  const monthsRebuilt = [];
  for (const monthKey of monthsTouched) {
    await rebuildVentasResumen(monthKey);
    monthsRebuilt.push(monthKey);
  }

  const configTable = await readSheetTable('VentasConfig', { readOnly: false });
  await updateVentasConfigLastSync(configTable.sheets, configTable.headers, configTable.rows, new Date().toISOString());

  return {
    synced: normalizedOrders.length,
    inserted,
    updated,
    months_rebuilt: monthsRebuilt,
  };
}

async function listTiendanubeWebhooks(storeId, accessToken) {
  const response = await fetch(`https://api.tiendanube.com/v1/${encodeURIComponent(storeId)}/webhooks`, {
    method: 'GET',
    headers: tiendanubeApiHeaders(accessToken),
  });
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Error listando webhooks de Tiendanube: ${detail}`);
  }
  return Array.isArray(payload) ? payload : [];
}

async function createTiendanubeWebhook(storeId, accessToken, event, url) {
  const response = await fetch(`https://api.tiendanube.com/v1/${encodeURIComponent(storeId)}/webhooks`, {
    method: 'POST',
    headers: tiendanubeApiHeaders(accessToken),
    body: JSON.stringify({ event, url }),
  });
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Error creando webhook (${event}): ${detail}`);
  }
  return payload;
}

export async function registerTiendanubeWebhooks(baseUrlValue = '') {
  const config = await getVentasConfig();
  const storeId = String(config?.store_id || '').trim();
  const accessToken = String(config?.access_token || '').trim();
  if (!storeId) throw new Error('No hay store_id configurado en VentasConfig.');
  if (!accessToken) throw new Error('No hay access_token configurado en VentasConfig.');

  const baseUrl = String(baseUrlValue || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('No se pudo determinar APP_URL para registrar webhooks.');
  const webhookUrl = `${baseUrl}/api/tiendanube/webhook`;

  const existing = await listTiendanubeWebhooks(storeId, accessToken);
  const normalizedTarget = webhookUrl.toLowerCase();
  const existingByKey = new Set(existing.map((item) => `${normalizeStatusToken(item?.event || item?.topic)}::${String(item?.url || '').trim().toLowerCase()}`));

  let created = 0;
  let skipped = 0;

  for (const event of TIENDANUBE_WEBHOOK_EVENTS) {
    const key = `${event}::${normalizedTarget}`;
    if (existingByKey.has(key)) {
      skipped += 1;
      continue;
    }
    await createTiendanubeWebhook(storeId, accessToken, event, webhookUrl);
    created += 1;
  }

  return {
    webhook_url: webhookUrl,
    events: TIENDANUBE_WEBHOOK_EVENTS,
    created,
    skipped,
  };
}

export async function processTiendanubeWebhook(payload = {}, reqLike = {}) {
  const event = resolveWebhookEvent(reqLike, payload);
  if (!event) {
    throw new Error('Evento de webhook inválido o ausente.');
  }
  if (!isOrderWebhookEvent(event)) {
    return { ignored: true, event };
  }

  const config = await getVentasConfig();
  const storeId = String(config?.store_id || '').trim();
  const accessToken = String(config?.access_token || '').trim();
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  if (!storeId || !accessToken) throw new Error('Falta configuración de tienda para procesar webhooks.');

  const orderId = extractOrderIdFromPayload(payload);
  if (!orderId) throw new Error('Webhook sin order_id.');

  const orderPayload = payload?.order && typeof payload.order === 'object' ? payload.order : await fetchTiendanubeOrderById(storeId, accessToken, orderId);
  const normalizedVenta = normalizeTiendanubeOrder(orderPayload, defaultRate);
  if (!normalizedVenta) throw new Error('No se pudo normalizar la orden de webhook.');

  const result = await upsertVentaTN(normalizedVenta);
  const summary = await rebuildVentasResumen(result.venta.month_key);
  return {
    event,
    order_id: result.venta.order_id,
    month_key: result.venta.month_key,
    action: result.action,
    resumen_updated_at: summary.updated_at,
  };
}

export async function assignVentaSeller(payload = {}) {
  const orderId = String(payload.order_id || payload.orderId || '').trim();
  const sellerInput = String(payload.seller || '').trim();
  if (!orderId) throw new Error('order_id es obligatorio.');
  if (!sellerInput) throw new Error('seller es obligatorio.');

  const seller = canonicalSeller(sellerInput);
  if (!SELLERS.includes(seller)) {
    throw new Error('seller inválido. Valores permitidos: Haru, Vendedora.');
  }

  const config = await getVentasConfig();
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);

  const table = await readSheetTable('VentasTN', { readOnly: false });
  const { headers, rows } = table;
  if (!headers.length) throw new Error('La hoja VentasTN no tiene encabezados.');

  const orderIdx = headers.findIndex((header) => normalizeHeader(header) === 'order_id');
  if (orderIdx < 0) throw new Error('La hoja VentasTN no tiene la columna order_id.');

  let foundRow = null;
  for (const row of rows) {
    if (String(row?.[orderIdx] || '').trim() === orderId) {
      foundRow = row;
      break;
    }
  }
  if (!foundRow) throw new Error(`No se encontró la venta ${orderId}.`);

  const venta = mapVentaTN(rowToObject(headers, foundRow));
  const commissionableTotal = parseNumber(venta.commissionable_total, venta.total);
  const commissionAmount = commissionableTotal * defaultRate;

  const updatedVenta = {
    ...venta,
    seller,
    seller_assigned: true,
    commission_rate: defaultRate,
    commission_amount: commissionAmount,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = await upsertVentaTN(updatedVenta, table);
  await rebuildVentasResumen(updatedVenta.month_key);

  return {
    order_id: result.venta.order_id,
    seller: result.venta.seller,
    seller_assigned: result.venta.seller_assigned,
    month_key: result.venta.month_key,
  };
}

export async function getVentasComisiones(params = {}, reqLike = {}) {
  const requestedMonth = normalizeMonth(params.month);
  const config = await getVentasConfig();
  const summary = await getVentasResumen(requestedMonth);
  const orders = await getVentasDetalle(requestedMonth);

  return {
    storeId: config?.store_id || '',
    month: summary?.month_key || requestedMonth || normalizeMonth(),
    totalMes: Number(summary?.total_mes) || 0,
    totalHaru: Number(summary?.total_haru) || 0,
    totalVendedora: Number(summary?.total_vendedora) || 0,
    sinAsignar: Number(summary?.sin_asignar) || 0,
    ordersCount: Number(summary?.orders_count) || 0,
    summary: {
      totalMes: Number(summary?.total_mes) || 0,
      totalSinAsignar: Number(summary?.sin_asignar) || 0,
      totalPorVendedora: [
        { seller: 'Haru', total: Number(summary?.total_haru) || 0 },
        { seller: 'Vendedora', total: Number(summary?.total_vendedora) || 0 },
      ],
    },
    orders: Array.isArray(orders) ? orders : [],
  };
}

export async function updateVentasComisiones(payload = {}, reqLike = {}) {
  const orderId = String(payload.order_id || payload.orderId || '').trim();
  const seller = String(payload.seller || '').trim();
  if (!orderId) throw new Error('orderId es requerido.');
  const result = await assignVentaSeller({ order_id: orderId, seller });

  return {
    orderId: result?.order_id || orderId,
    seller: result?.seller || seller,
    seller_assigned: Boolean(result?.seller_assigned),
    month: result?.month_key || null,
  };
}
