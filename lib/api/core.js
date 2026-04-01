import { getCatalogos as getCatalogosRaw } from './catalogos.js';
import { archivePrenda, createPrenda, deletePrenda, generarCodigoPrenda, listPrendas } from './prendas.js';
import { importCorrections, listArchivedPrendas, restorePrenda, updatePrenda } from './prendasAdmin.js';
import {
  appendSheetRowRaw,
  appendSheetRowsRaw,
  assertHeadersExist,
  assertSheetExists,
  createSheetsClient,
  getSpreadsheetId,
  getSpreadsheetSheetNames,
  getSheetHeadersRaw,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';
import { invalidateVentasFullCache } from '../ventas/cache.js';
import { getCurrentMexicoMonthKey, getMexicoDateKey, getMexicoMonthKey } from '../ventas/mexicoDate.js';

export const SELLERS = ['Haru', 'Vendedora'];
export const FIXED_STORE_ID = '6432936';
const VENTAS_ASSIGNMENTS_LOG_SHEET = 'VentasAsignacionesLog';
const VENTAS_ASSIGNMENTS_LOG_HEADERS = ['timestamp', 'order_id', 'seller_anterior', 'seller_nuevo', 'changed_by', 'source', 'month_key', 'nota'];

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
  return getCurrentMexicoMonthKey();
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
  const parsed = Number(String(value)
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeHeaderLoose(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getColumnMap(headers = []) {
  const map = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeaderLoose(header);
    if (!normalized) return;
    map[normalized] = index;
    map[normalized.replace(/\s+/g, '_')] = index;
  });
  return map;
}

function normalizeSheetName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function findSheetByPossibleNames(sheets, names = []) {
  const allSheetNames = await getSpreadsheetSheetNames(sheets);
  const normalizedMap = new Map(
    allSheetNames.map((name) => [normalizeSheetName(name), name]),
  );

  for (const candidate of names) {
    const found = normalizedMap.get(normalizeSheetName(candidate));
    if (found) return found;
  }

  return null;
}

function toDateSafe(value) {
  if (!value) return null;

  if (Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime())) {
    return value;
  }

  const s = String(value).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{4}-\d{2}$/.test(s)) {
    const [yyyy, mm] = s.split('-').map((part) => Number(part));
    const d = new Date(yyyy, (mm || 1) - 1, 1, 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const ddmmyyyy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const dd = Number(ddmmyyyy[1]);
    const mm = Number(ddmmyyyy[2]) - 1;
    const yyyy = Number(ddmmyyyy[3]);
    const d = new Date(yyyy, mm, dd, 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFechaFromRow(row = [], colMap = {}) {
  const candidates = [
    'fecha',
    'fecha_de_venta',
    'created_at',
    'creado',
    'dia',
    'month_key',
  ];

  for (const key of candidates) {
    if (colMap[key] === undefined) continue;
    const date = toDateSafe(row[colMap[key]]);
    if (date) return date;
  }

  return null;
}

function getMontoFromRow(row = [], colMap = {}) {
  const candidates = [
    'total',
    'venta',
    'monto',
    'importe',
    'precio',
    'ticket_total',
    'commissionable_total',
  ];

  for (const key of candidates) {
    if (colMap[key] === undefined) continue;
    const amount = parseNumber(row[colMap[key]], 0);
    if (amount > 0) return amount;
  }

  return 0;
}

function normalizeVentasRows(rows = [], colMap = {}) {
  return rows
    .map((row) => {
      const fecha = getFechaFromRow(row, colMap);
      const monthFromFecha = fecha ? getMexicoMonthKey(fecha) : '';
      const monthKeyValue = String(row[colMap.month_key] || row[colMap.monthkey] || '').trim();
      const monthKey = monthKeyValue || monthFromFecha;
      const total = getMontoFromRow(row, colMap);
      const paymentStatus = String(row[colMap.payment_status] || '').trim().toLowerCase();
      const seller = canonicalSeller(row[colMap.seller]);
      const commissionAmount = parseNumber(row[colMap.commission_amount], 0);
      return {
        fecha,
        month_key: monthKey,
        total,
        paymentStatus,
        seller,
        commissionAmount,
      };
    })
    .filter((item) => item.month_key && Number.isFinite(item.total));
}

function groupVentasByMonth(ventas = [], year, { onlyPaid = true } = {}) {
  const result = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    venta: 0,
    tickets: 0,
    totalHaru: 0,
    totalVendedora: 0,
    sinAsignar: 0,
    comisionTotal: 0,
  }));

  ventas.forEach((venta) => {
    const monthKey = String(venta.month_key || '').trim();
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
    const [yearRaw, monthRaw] = monthKey.split('-');
    const rowYear = Number(yearRaw);
    const rowMonth = Number(monthRaw);
    if (rowYear !== Number(year)) return;
    if (rowMonth < 1 || rowMonth > 12) return;
    if (onlyPaid && venta.paymentStatus && venta.paymentStatus !== 'paid') return;

    const idx = rowMonth - 1;
    result[idx].venta += venta.total;
    result[idx].tickets += 1;
    result[idx].comisionTotal += parseNumber(venta.commissionAmount, 0);
    if (venta.seller === 'Haru') result[idx].totalHaru += venta.total;
    else if (venta.seller === 'Vendedora') result[idx].totalVendedora += venta.total;
    else result[idx].sinAsignar += 1;
  });

  return result.map((item) => ({
    ...item,
    ticketPromedio: item.tickets > 0 ? item.venta / item.tickets : 0,
  }));
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return fallback;
}

function getMonthFromDate(value) {
  return getMexicoMonthKey(value) || currentMonthKey();
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

async function readSheetTableIfExists(sheetName, { readOnly = true, requiredHeaders = [] } = {}) {
  try {
    return await readSheetTable(sheetName, { readOnly, requiredHeaders });
  } catch (error) {
    console.warn('[ventas:sheet:optional_missing]', {
      sheet: sheetName,
      message: String(error?.message || error),
    });
    return null;
  }
}

async function ensureSheetExistsWithHeaders(sheets, sheetName, headers = []) {
  const safeName = String(sheetName || '').trim();
  if (!safeName) throw new Error('sheetName es obligatorio.');
  const currentSheets = await getSpreadsheetSheetNames(sheets);
  if (!currentSheets.includes(safeName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: getSpreadsheetId(),
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: safeName },
            },
          },
        ],
      },
    });
  }
  if (Array.isArray(headers) && headers.length) {
    const existingHeaders = await getSheetHeadersRaw(sheets, safeName);
    if (!existingHeaders.length) {
      await updateSheetRowRaw(sheets, `${safeName}!A1:ZZ1`, headers);
    }
  }
}

async function ensureVentasAsignacionesLogHeaders(table) {
  const { sheets, headers } = table;
  if (!headers.length) throw new Error(`La hoja ${VENTAS_ASSIGNMENTS_LOG_SHEET} no tiene encabezados.`);
  const normalized = headers.map((header) => normalizeHeader(header));
  let changed = false;
  VENTAS_ASSIGNMENTS_LOG_HEADERS.forEach((requiredHeader) => {
    if (!normalized.includes(requiredHeader)) {
      headers.push(requiredHeader);
      normalized.push(requiredHeader);
      changed = true;
    }
  });
  if (changed) {
    await updateSheetRowRaw(sheets, `${VENTAS_ASSIGNMENTS_LOG_SHEET}!A1:ZZ1`, headers);
  }
}

function mapAssignmentLogRow(headers = [], row = []) {
  const record = rowToObject(headers, row);
  const sellerNuevo = canonicalSeller(record.seller_nuevo || record.seller || record.vendedora || '');
  const orderId = String(record.order_id || '').trim();
  const timestamp = String(record.timestamp || record.updated_at || record.created_at || '').trim();
  if (!orderId || !sellerNuevo) return null;
  return {
    order_id: orderId,
    seller_nuevo: sellerNuevo,
    seller_anterior: canonicalSeller(record.seller_anterior || ''),
    timestamp,
    month_key: String(record.month_key || '').trim(),
  };
}

async function readLatestSellerAssignmentsByOrder() {
  const logTable = await readSheetTableIfExists(VENTAS_ASSIGNMENTS_LOG_SHEET, { requiredHeaders: ['order_id'] });
  if (!logTable?.headers?.length) return new Map();
  const latestByOrder = new Map();
  logTable.rows.forEach((row, index) => {
    const mapped = mapAssignmentLogRow(logTable.headers, row);
    if (!mapped) return;
    const previous = latestByOrder.get(mapped.order_id);
    const mappedTs = Date.parse(mapped.timestamp);
    const prevTs = Date.parse(previous?.timestamp || '');
    const mappedTsValid = Number.isFinite(mappedTs);
    const prevTsValid = Number.isFinite(prevTs);

    if (!previous) {
      latestByOrder.set(mapped.order_id, { ...mapped, _idx: index });
      return;
    }
    if (mappedTsValid && prevTsValid) {
      if (mappedTs >= prevTs) latestByOrder.set(mapped.order_id, { ...mapped, _idx: index });
      return;
    }
    if (mappedTsValid && !prevTsValid) {
      latestByOrder.set(mapped.order_id, { ...mapped, _idx: index });
      return;
    }
    if (!mappedTsValid && !prevTsValid && index >= (previous?._idx ?? -1)) {
      latestByOrder.set(mapped.order_id, { ...mapped, _idx: index });
    }
  });
  return latestByOrder;
}

async function appendVentaAssignmentLog({
  order_id,
  seller_anterior = '',
  seller_nuevo = '',
  changed_by = '',
  source = '',
  month_key = '',
  nota = '',
}) {
  const sheets = createSheetsClient({ readOnly: false });
  await ensureSheetExistsWithHeaders(sheets, VENTAS_ASSIGNMENTS_LOG_SHEET, VENTAS_ASSIGNMENTS_LOG_HEADERS);
  const logTable = await readSheetTable(VENTAS_ASSIGNMENTS_LOG_SHEET, { readOnly: false });
  await ensureVentasAsignacionesLogHeaders(logTable);
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    order_id: String(order_id || '').trim(),
    seller_anterior: canonicalSeller(seller_anterior),
    seller_nuevo: canonicalSeller(seller_nuevo),
    changed_by: String(changed_by || '').trim() || 'sistema',
    source: String(source || '').trim() || 'ventas_panel',
    month_key: normalizeMonth(month_key) || currentMonthKey(),
    nota: String(nota || '').trim(),
  };
  if (!record.order_id) throw new Error('No se pudo registrar asignación: order_id vacío.');
  if (!record.seller_nuevo) throw new Error('No se pudo registrar asignación: seller_nuevo inválido.');
  await appendSheetRowRaw(logTable.sheets, VENTAS_ASSIGNMENTS_LOG_SHEET, mapHeadersToRow(logTable.headers, record));
  return record;
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
  const fechaOperativa = pickRecordValue(record, ['fecha_operativa']) || getMexicoDateKey(createdAt);
  const ticketNumber = parseTicketNumber(
    pickRecordValue(record, ['ticket_number'])
    ?? pickRecordValue(record, ['order_number'])
    ?? pickRecordValue(record, ['number'])
  );
  const storedTicketLabel = pickRecordValue(record, ['ticket_label']);
  const ticketLabel = storedTicketLabel || (ticketNumber ? `#${ticketNumber}` : null) || pickRecordValue(record, ['order_id']);

  const statuses = normalizeVentaStatuses(record);

  return {
    order_id: pickRecordValue(record, ['order_id']),
    ticket_number: ticketNumber,
    ticket_label: ticketLabel,
    created_at: createdAt,
    fecha_operativa: fechaOperativa,
    month_key: pickRecordValue(record, ['month_key', 'monthkey']) || getMonthFromDate(createdAt),
    monthKey: pickRecordValue(record, ['month_key', 'monthkey']) || getMonthFromDate(createdAt),
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


async function readVentasRowsFromSheet() {
  const { headers, rows } = await readSheetTable('VentasTN', { requiredHeaders: ['total'] });
  return { headers, rows, colMap: getColumnMap(headers) };
}


function buildVentasResumenFromGrouped(groupedMonth = {}, monthKey = currentMonthKey()) {
  const now = new Date().toISOString();
  return {
    month_key: monthKey,
    total_mes: parseNumber(groupedMonth.venta, 0),
    total_haru: parseNumber(groupedMonth.totalHaru, 0),
    total_vendedora: parseNumber(groupedMonth.totalVendedora, 0),
    sin_asignar: parseNumber(groupedMonth.sinAsignar, 0),
    comision_total: parseNumber(groupedMonth.comisionTotal, 0),
    orders_count: parseNumber(groupedMonth.tickets, 0),
    ticket_promedio: parseNumber(groupedMonth.ticketPromedio, 0),
    updated_at: now,
  };
}

async function getSharedVentasByMonth(year) {
  const ventasDetalle = await getVentasDetalle();
  const ventas = (ventasDetalle || []).map((venta) => ({
    fecha: toDateSafe(venta.created_at),
    total: parseNumber(venta.total, 0),
    paymentStatus: String(venta.payment_status || '').trim().toLowerCase(),
    seller: canonicalSeller(venta.seller),
    commissionAmount: parseNumber(venta.commission_amount, 0),
  }));
  return groupVentasByMonth(ventas, year, { onlyPaid: true });
}

function parseTicketNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const clean = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(clean)) return null;
  return Number(clean);
}



async function ensureVentasTNHeaders(table) {
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

function collectExistingOrderIds(rows = [], orderIdx = 0) {
  const orderIds = new Set();
  rows.forEach((row) => {
    const orderId = String(row?.[orderIdx] || '').trim();
    if (orderId) orderIds.add(orderId);
  });
  return orderIds;
}
function mapHeadersToRow(headers = [], record = {}) {
  return headers.map((header) => {
    const key = normalizeHeader(header);
    if (key === 'seller_assigned') return record[key] ? 'TRUE' : 'FALSE';
    return record[key] ?? '';
  });
}

function ventaFingerprint(venta = {}) {
  const safe = mapVentaTN(venta);
  return [
    safe.order_id,
    safe.total,
    safe.subtotal,
    safe.discount,
    safe.payment_status,
    safe.fulfillment_status,
    safe.raw_status,
    safe.updated_at,
  ]
    .map((value) => String(value ?? '').trim())
    .join('::');
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

export async function resolveTiendanubeConnection() {
  let config = null;
  try {
    config = await getVentasConfig();
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

  const requestUrl = `https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/orders/${encodeURIComponent(normalizedOrderId)}`;
  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: tiendanubeApiHeaders(accessToken),
  });
  const payload = await parseResponseJson(response);

  if (!response.ok || !payload) {
    const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
    const error = new Error(`Error consultando orden ${normalizedOrderId} en Tiendanube: ${detail}`);
    error.httpStatus = response.status;
    error.http_status = response.status;
    error.details = {
      store_id: normalizedStoreId,
      order_id: normalizedOrderId,
      request_url: requestUrl,
      status: response.status,
    };
    throw error;
  }

  return payload;
}

export async function fetchTiendanubeVariantById(storeId, accessToken, variantId) {
  const normalizedStoreId = String(storeId || '').trim();
  const normalizedVariantId = String(variantId || '').trim();
  if (!normalizedStoreId) throw new Error('store_id es obligatorio para consultar variante de Tiendanube.');
  if (!normalizedVariantId) throw new Error('variant_id es obligatorio para consultar variante de Tiendanube.');

  const endpoints = [
    `https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/variants/${encodeURIComponent(normalizedVariantId)}`,
    `https://api.tiendanube.com/v1/${encodeURIComponent(normalizedStoreId)}/products/variants/${encodeURIComponent(normalizedVariantId)}`,
  ];

  let lastErrorDetail = 'sin detalle';
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: tiendanubeApiHeaders(accessToken),
    });
    const payload = await parseResponseJson(response);

    if (response.ok && payload) return payload;
    lastErrorDetail = payload?.message || payload?.error || `HTTP ${response.status}`;
  }

  throw new Error(`Error consultando variante ${normalizedVariantId} en Tiendanube: ${lastErrorDetail}`);
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

export async function getCatalogos() {
  try {
    return await getCatalogosRaw();
  } catch (error) {
    throw new Error(`No se pudieron cargar los diccionarios desde Sheets. ${error?.message || ''}`.trim());
  }
}

export { listPrendas, createPrenda, deletePrenda, archivePrenda, generarCodigoPrenda, listArchivedPrendas, restorePrenda, importCorrections, updatePrenda };

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
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const [yearRaw, monthRaw] = monthKey.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return defaultVentasResumen(monthKey);

  const grouped = await getSharedVentasByMonth(year);
  const groupedMonth = grouped[month - 1] || {};
  return mapVentasResumen(buildVentasResumenFromGrouped(groupedMonth, monthKey), monthKey);
}

export async function getVentasMiniPublic(monthValue) {
  const [summary, config] = await Promise.all([
    getVentasResumen(monthValue),
    getVentasConfig().catch(() => null),
  ]);
  return {
    storeConfigured: Boolean(String(config?.store_id || '').trim()),
    total_mes: Number(summary?.total_mes) || 0,
    total_haru: Number(summary?.total_haru) || 0,
    total_vendedora: Number(summary?.total_vendedora) || 0,
    sin_asignar: Number(summary?.sin_asignar) || 0,
  };
}

export async function getVentasDetalle(monthValue, searchValue = "") {
  const searchTerm = String(searchValue || "").trim().toLowerCase();
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const [ventasTable, assignmentMap] = await Promise.all([
    readSheetTable('VentasTN', { requiredHeaders: ['order_id', 'month_key'] }),
    readLatestSellerAssignmentsByOrder(),
  ]);
  const { headers, rows } = ventasTable;
  if (!headers.length || !rows.length) return [];

  return rows
    .map((row) => {
      const venta = mapVentaTN(rowToObject(headers, row));
      const assignment = assignmentMap.get(venta.order_id);
      if (assignment?.seller_nuevo) {
        venta.seller = assignment.seller_nuevo;
        venta.seller_assigned = true;
      }
      return venta;
    })
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

  const { orderIdx } = await ensureVentasTNHeaders(table);

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
    const incomingFingerprint = ventaFingerprint(ventaNormalized);
    const existingFingerprint = ventaFingerprint(existingVenta);
    if (incomingFingerprint === existingFingerprint) {
      return { action: 'no_relevant_change', rowNumber: rowIndex + 2, venta: existingVenta };
    }

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

async function upsertVentasBatch(ventas = [], table) {
  if (!Array.isArray(ventas) || !ventas.length) return { inserted: 0, updated: 0, monthsTouched: [] };
  const ensured = await ensureVentasTNHeaders(table);
  const { sheets, headers, rows } = table;
  const orderIdx = ensured.orderIdx;
  const rowByOrderId = new Map();

  rows.forEach((row = [], index) => {
    const orderId = String(row[orderIdx] || '').trim();
    if (!orderId) return;
    rowByOrderId.set(orderId, { rowIndex: index, row });
  });

  let inserted = 0;
  let updated = 0;
  const monthsTouched = new Set();

  for (const rawVenta of ventas) {
    const venta = mapVentaTN(rawVenta);
    if (!venta.order_id) continue;
    monthsTouched.add(venta.month_key);
    const existing = rowByOrderId.get(venta.order_id);

    if (existing) {
      const existingVenta = mapVentaTN(rowToObject(headers, existing.row || []));
      if (existingVenta.seller && existingVenta.seller_assigned && (!venta.seller || !venta.seller_assigned)) {
        venta.seller = existingVenta.seller;
        venta.seller_assigned = true;
        venta.commission_rate = existingVenta.commission_rate || venta.commission_rate;
        venta.commission_amount = existingVenta.commission_amount || venta.commission_amount;
      }
      const rowValues = mapHeadersToRow(headers, venta);
      const rowNumber = existing.rowIndex + 2;
      await updateSheetRowRaw(sheets, `VentasTN!A${rowNumber}:ZZ${rowNumber}`, rowValues);
      rows[existing.rowIndex] = rowValues;
      updated += 1;
      continue;
    }

    const rowValues = mapHeadersToRow(headers, venta);
    await appendSheetRowRaw(sheets, 'VentasTN', rowValues);
    rows.push(rowValues);
    rowByOrderId.set(venta.order_id, { rowIndex: rows.length - 1, row: rowValues });
    inserted += 1;
  }

  return { inserted, updated, monthsTouched: Array.from(monthsTouched) };
}

export async function rebuildVentasResumen(monthValue) {
  const monthKey = normalizeMonth(monthValue) || currentMonthKey();
  const [yearRaw, monthRaw] = monthKey.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error('Mes inválido para recalcular VentasResumen.');
  }

  const grouped = await getSharedVentasByMonth(year);
  const groupedMonth = grouped[month - 1] || {};
  const summary = buildVentasResumenFromGrouped(groupedMonth, monthKey);

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


export async function syncVentasFromTiendanube() {
  const connection = await resolveTiendanubeConnection();
  const config = connection.config;
  const storeId = connection.storeId;
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  const rawOrders = await fetchTiendanubeOrders(storeId, connection.accessToken || '', {
    tokenSource: connection.tokenSource,
    storeSource: connection.storeSource,
    configStoreId: connection?.config?.store_id,
  });
  const normalizedOrders = rawOrders
    .map((order) => normalizeTiendanubeOrder(order, defaultRate))
    .filter(Boolean);

  const table = await readSheetTable('VentasTN', { readOnly: false });
  const { sheets, headers, rows } = table;
  const { orderIdx } = await ensureVentasTNHeaders(table);
  const existingOrderIds = collectExistingOrderIds(rows, orderIdx);

  const rowsToAppend = [];
  const monthsTouched = new Set();
  const seenInBatch = new Set();

  normalizedOrders.forEach((venta) => {
    if (!venta?.order_id) return;
    if (existingOrderIds.has(venta.order_id)) return;
    if (seenInBatch.has(venta.order_id)) return;
    seenInBatch.add(venta.order_id);
    rowsToAppend.push(mapHeadersToRow(headers, venta));
    monthsTouched.add(venta.month_key);
  });

  if (rowsToAppend.length > 0) {
    await appendSheetRowsRaw(sheets, 'VentasTN', rowsToAppend);
    rows.push(...rowsToAppend);
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
    inserted: rowsToAppend.length,
    updated: 0,
    months_rebuilt: monthsRebuilt,
  };
}

export async function syncVentasFromTiendanubeIncremental(options = {}) {
  const connection = await resolveTiendanubeConnection();
  const config = connection.config;
  const storeId = connection.storeId;
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  const rawOrders = await fetchTiendanubeOrders(storeId, connection.accessToken || '', {
    ...(options || {}),
    tokenSource: connection.tokenSource,
    storeSource: connection.storeSource,
    configStoreId: connection?.config?.store_id,
  });
  const normalizedOrders = rawOrders
    .map((order) => normalizeTiendanubeOrder(order, defaultRate))
    .filter(Boolean);
  let lastCreatedAtMax = String(options.createdAtMin || '').trim();
  let lastUpdatedAtMax = String(options.updatedAtMin || '').trim();
  normalizedOrders.forEach((item = {}) => {
    const createdAt = String(item.created_at || '').trim();
    const updatedAt = String(item.updated_at || '').trim();
    if (createdAt && (!lastCreatedAtMax || new Date(createdAt).getTime() > new Date(lastCreatedAtMax).getTime())) {
      lastCreatedAtMax = createdAt;
    }
    if (updatedAt && (!lastUpdatedAtMax || new Date(updatedAt).getTime() > new Date(lastUpdatedAtMax).getTime())) {
      lastUpdatedAtMax = updatedAt;
    }
  });

  const table = await readSheetTable('VentasTN', { readOnly: false });
  const byOrderId = new Map();
  normalizedOrders.forEach((venta) => byOrderId.set(venta.order_id, venta));
  const batchResult = await upsertVentasBatch(Array.from(byOrderId.values()), table);
  const inserted = batchResult.inserted;
  const updated = batchResult.updated;
  const monthsTouched = new Set(batchResult.monthsTouched);

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
    last_created_at_max: lastCreatedAtMax,
    last_updated_at_max: lastUpdatedAtMax,
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

  const connection = await resolveTiendanubeConnection();
  const config = connection.config;
  const storeId = connection.storeId;
  const accessToken = String(connection.accessToken || '').trim();
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  if (!storeId || !accessToken) throw new Error('Falta configuración de tienda para procesar webhooks.');

  const orderId = extractOrderIdFromPayload(payload);
  if (!orderId) throw new Error('Webhook sin order_id.');

  const orderPayload = payload?.order && typeof payload.order === 'object' ? payload.order : await fetchTiendanubeOrderById(storeId, accessToken, orderId);
  const normalizedVenta = normalizeTiendanubeOrder(orderPayload, defaultRate);
  if (!normalizedVenta) throw new Error('No se pudo normalizar la orden de webhook.');

  const result = await upsertVentaTN(normalizedVenta);
  return {
    event,
    order_id: result.venta.order_id,
    month_key: result.venta.month_key,
    action: result.action,
    resumen_updated_at: new Date().toISOString(),
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
  const latestAssignments = await readLatestSellerAssignmentsByOrder();
  const latestForOrder = latestAssignments.get(orderId);
  const sellerAnterior = latestForOrder?.seller_nuevo || venta.seller || '';
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

  await appendVentaAssignmentLog({
    order_id: orderId,
    seller_anterior: sellerAnterior,
    seller_nuevo: seller,
    changed_by: payload.changed_by || payload.changedBy || '',
    source: payload.source || 'ventas_html',
    month_key: updatedVenta.month_key,
    nota: payload.nota || '',
  });

  let result = { venta: updatedVenta };
  try {
    result = await upsertVentaTN(updatedVenta, table);
  } catch (error) {
    console.warn('[ventas:assign:upsert_warning]', {
      order_id: orderId,
      seller_nuevo: seller,
      sheet: 'VentasTN',
      message: String(error?.message || error),
    });
  }
  invalidateVentasFullCache(updatedVenta.month_key);
  await rebuildVentasResumen(updatedVenta.month_key);

  console.log('[ventas:assign:ok]', {
    order_id: orderId,
    seller_nuevo: seller,
    seller_anterior: sellerAnterior,
    log_sheet: VENTAS_ASSIGNMENTS_LOG_SHEET,
    ventas_sheet: 'VentasTN',
    month_key: updatedVenta.month_key,
  });

  return {
    order_id: result.venta.order_id,
    seller: result.venta.seller,
    seller_assigned: result.venta.seller_assigned,
    month_key: result.venta.month_key,
  };
}


export async function repairVentasMonthKeys({ dryRun = true } = {}) {
  const table = await readSheetTable('VentasTN', { readOnly: false, requiredHeaders: ['order_id', 'created_at'] });
  const { sheets, headers, rows } = table;
  await ensureVentasTNHeaders(table);

  const idxCreatedAt = headers.findIndex((header) => normalizeHeader(header) === 'created_at');
  const idxMonthKey = headers.findIndex((header) => normalizeHeader(header) === 'month_key');
  const idxFechaOperativa = headers.findIndex((header) => normalizeHeader(header) === 'fecha_operativa');
  if (idxCreatedAt < 0 || idxMonthKey < 0 || idxFechaOperativa < 0) {
    throw new Error('No se encontraron columnas required: created_at, month_key, fecha_operativa.');
  }

  const fixes = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const createdAt = String(row[idxCreatedAt] || '').trim();
    if (!createdAt) continue;
    const expectedMonthKey = getMexicoMonthKey(createdAt);
    const expectedFechaOperativa = getMexicoDateKey(createdAt);
    if (!expectedMonthKey || !expectedFechaOperativa) continue;
    const currentMonthKey = String(row[idxMonthKey] || '').trim();
    const currentFechaOperativa = String(row[idxFechaOperativa] || '').trim();
    if (currentMonthKey === expectedMonthKey && currentFechaOperativa === expectedFechaOperativa) continue;

    const rowRecord = rowToObject(headers, row);
    rowRecord.month_key = expectedMonthKey;
    rowRecord.fecha_operativa = expectedFechaOperativa;
    fixes.push({ rowIndex: i, rowNumber: i + 2, rowRecord, from: { currentMonthKey, currentFechaOperativa }, to: { expectedMonthKey, expectedFechaOperativa } });
  }

  if (!dryRun) {
    for (const fix of fixes) {
      await updateSheetRowRaw(sheets, `VentasTN!A${fix.rowNumber}:ZZ${fix.rowNumber}`, mapHeadersToRow(headers, fix.rowRecord));
      rows[fix.rowIndex] = mapHeadersToRow(headers, fix.rowRecord);
    }
  }

  return {
    dry_run: dryRun,
    inconsistencias: fixes.length,
    rows_updated: dryRun ? 0 : fixes.length,
    sample: fixes.slice(0, 20).map((item) => ({ row: item.rowNumber, from: item.from, to: item.to })),
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

function readMetasByMonth(rows = [], colMap = {}, year) {
  const result = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, meta: 0 }));

  rows.forEach((row) => {
    const yearCol = colMap.ano ?? colMap['año'] ?? colMap.year;
    const monthCol = colMap.mes ?? colMap.month;
    const metaCol = colMap.meta;

    const rowYear = Number(row[yearCol] ?? 0);
    const rowMonth = Number(row[monthCol] ?? 0);
    const rowMeta = parseNumber(row[metaCol] ?? 0, 0);

    if (rowYear === Number(year) && rowMonth >= 1 && rowMonth <= 12) {
      result[rowMonth - 1].meta = rowMeta;
    }
  });

  return result;
}

function buildMetaVsVentaRows({ ventasByMonth, metasByMonth, fromMonth, toMonth }) {
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const rows = [];

  for (let m = Number(fromMonth); m <= Number(toMonth); m += 1) {
    const venta = parseNumber(ventasByMonth[m - 1]?.venta, 0);
    const meta = parseNumber(metasByMonth[m - 1]?.meta, 0);
    const cumplimiento = meta > 0 ? (venta / meta) * 100 : 0;
    const barPercent = Math.max(0, Math.min(100, cumplimiento));
    rows.push({
      month: m,
      monthLabel: monthNames[m - 1],
      venta,
      meta,
      cumplimiento,
      barPercent,
      ticketPromedio: parseNumber(ventasByMonth[m - 1]?.ticketPromedio, 0),
      tickets: parseNumber(ventasByMonth[m - 1]?.tickets, 0),
    });
  }

  return rows;
}

function buildMetaVsVentaAnnual({ ventasByMonth, metasByMonth }) {
  const ventaAnual = ventasByMonth.reduce((acc, item) => acc + Number(item?.venta || 0), 0);
  const metaAnual = metasByMonth.reduce((acc, item) => acc + Number(item?.meta || 0), 0);
  const cumplimiento = metaAnual > 0 ? (ventaAnual / metaAnual) * 100 : 0;
  const barPercent = Math.max(0, Math.min(100, cumplimiento));

  return [{
    month: 0,
    monthLabel: 'Anual',
    venta: ventaAnual,
    meta: metaAnual,
    cumplimiento,
    barPercent,
  }];
}

export async function getMetaVsVentaData(params = {}) {
  // Fuente de verdad de Meta vs Venta: una sola hoja de cálculo (ventas + metas).
  const year = Number(params.year || new Date().getFullYear());
  const view = String(params.view || '').toLowerCase() === 'annual' ? 'annual' : 'monthly';
  const fromMonth = Math.max(1, Math.min(12, Number(params.fromMonth || 1)));
  const toMonth = Math.max(fromMonth, Math.min(12, Number(params.toMonth || 12)));

  const ventasByMonth = await getSharedVentasByMonth(year);

  const sheets = createSheetsClient({ readOnly: true });
  const metasSheetName = await findSheetByPossibleNames(sheets, [
    'Metas',
    'Meta',
    'Meta vs Venta',
    'meta-vs-venta',
    'Objetivos',
  ]);

  let metasByMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, meta: 0 }));
  if (metasSheetName) {
    const metasTable = await readSheetTable(metasSheetName);
    metasByMonth = readMetasByMonth(metasTable.rows || [], getColumnMap(metasTable.headers || []), year);
  }

  const rows = view === 'annual'
    ? buildMetaVsVentaAnnual({ ventasByMonth, metasByMonth })
    : buildMetaVsVentaRows({ ventasByMonth, metasByMonth, fromMonth, toMonth });

  return {
    year,
    view,
    fromMonth,
    toMonth,
    rows,
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
