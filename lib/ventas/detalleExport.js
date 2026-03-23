import { fetchTiendanubeOrderById, getCatalogos, resolveTiendanubeConnection } from '../api/core.js';

const CACHE_OK_TTL_MS = Number(process.env.VENTAS_DETALLE_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const CACHE_ERROR_TTL_MS = Number(process.env.VENTAS_DETALLE_CACHE_ERROR_TTL_MS || 10 * 60 * 1000);
const MAX_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.VENTAS_DETALLE_CONCURRENCY || 4)));
const MAX_RETRIES = 2;

function getStore() {
  if (!globalThis.__ventasDetalleOrderCache) {
    globalThis.__ventasDetalleOrderCache = new Map();
  }
  return globalThis.__ventasDetalleOrderCache;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDate(value) {
  const d = new Date(value || '');
  if (Number.isNaN(d.getTime())) return String(value || '').trim();
  return d.toISOString().slice(0, 10);
}

function normalizeStatusFromHttp(httpStatus = 0) {
  const status = Number(httpStatus || 0);
  if (status === 404) return 'error_tiendanube_404';
  if (status >= 500) return 'error_tiendanube_5xx';
  return 'error_api';
}

function isSheetsQuotaError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('quota') && text.includes('sheets.googleapis.com');
}

function extractOrderItems(order = {}) {
  const products = Array.isArray(order?.products) ? order.products : [];
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const source = products.length ? products : lineItems;
  return source.map((item) => {
    const quantity = normalizeNumber(item?.quantity ?? item?.qty ?? 1, 1);
    const unitPrice = normalizeNumber(item?.price ?? item?.price_per_unit ?? item?.unit_price ?? 0, 0);
    const subtotal = normalizeNumber(item?.subtotal ?? item?.total ?? (unitPrice * quantity), unitPrice * quantity);
    const sku = String(item?.sku || item?.variant_sku || item?.variant?.sku || '').trim();
    return {
      productName: String(item?.name || item?.title || item?.product_name || '').trim(),
      productId: String(item?.product_id || item?.id || '').trim(),
      variantId: String(item?.variant_id || item?.variant?.id || '').trim(),
      quantity,
      unitPrice,
      subtotal,
      sku,
    };
  });
}

function extraerTallaDesdeSku(sku = '') {
  const clean = String(sku).trim().toUpperCase();
  const match = clean.match(/-([A-Z0-9]+)$/);
  return match ? match[1] : '';
}

function extraerTallaDesdeNombre(name = '') {
  const clean = String(name).trim().toUpperCase();
  if (!clean) return '';
  const wrapped = ` ${clean} `;
  const sizeToken = wrapped.match(/\b(XXL|XL|L|M|S|XS|CH|MED|GDE)\b/);
  if (sizeToken) return sizeToken[1];
  const numericToken = wrapped.match(/\b(\d{2})\b/);
  return numericToken ? numericToken[1] : '';
}

function isCacheEntryFresh(entry = {}) {
  const timestamp = Number(entry.timestamp || 0);
  const age = Date.now() - timestamp;
  const status = String(entry.status || '').toLowerCase();
  const ttl = status === 'ok' || status === 'sin_products' ? CACHE_OK_TTL_MS : CACHE_ERROR_TTL_MS;
  return age >= 0 && age <= ttl;
}

function getCachedOrder(orderId = '') {
  const key = String(orderId || '').trim();
  if (!key) return null;
  const entry = getStore().get(key);
  if (!entry || !isCacheEntryFresh(entry)) return null;
  return entry;
}

function setCachedOrder(orderId = '', value = {}) {
  const key = String(orderId || '').trim();
  if (!key) return;
  getStore().set(key, {
    ...value,
    timestamp: Date.now(),
  });
}

function buildSkuMap(catalogos = {}) {
  const map = new Map();
  const tallas = Array.isArray(catalogos?.tallas) ? catalogos.tallas : [];
  tallas.forEach((item = {}) => {
    const clave = String(item?.clave || '').trim().toUpperCase();
    const valor = String(item?.valor || '').trim();
    if (!clave || !valor) return;
    map.set(clave, valor);
  });
  return map;
}

async function fetchOrderByIdWithRetry({ storeId, accessToken, orderId }) {
  let lastError = null;
  const totalAttempts = MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const order = await fetchTiendanubeOrderById(storeId, accessToken, orderId);
      return {
        ok: true,
        order,
        status: 'ok',
        httpStatus: 200,
        errorMessage: '',
        source: 'tiendanube',
      };
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || 'Error consultando Tiendanube').trim();
      const statusMatch = message.match(/\bHTTP\s*(\d{3})\b/i);
      const httpStatus = normalizeNumber(error?.httpStatus || error?.http_status || statusMatch?.[1], 0);
      const isRetryable = httpStatus >= 500 || httpStatus === 0;
      if (attempt >= totalAttempts || !isRetryable) {
        return {
          ok: false,
          order: null,
          status: normalizeStatusFromHttp(httpStatus),
          httpStatus,
          errorMessage: message,
          source: 'tiendanube',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  return {
    ok: false,
    order: null,
    status: 'error_api',
    httpStatus: normalizeNumber(lastError?.httpStatus || lastError?.http_status, 0),
    errorMessage: String(lastError?.message || lastError || 'Error consultando Tiendanube').trim(),
    source: 'tiendanube',
  };
}

function splitInChunks(items = [], chunkSize = 1) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function uniqueVentasByOrderId(ventas = []) {
  const map = new Map();
  ventas.forEach((venta = {}) => {
    const orderId = String(venta?.order_id || '').trim();
    if (!orderId) return;
    if (!map.has(orderId)) map.set(orderId, venta);
  });
  return map;
}

export async function buildVentasDetalleExport({ ventas = [] } = {}) {
  const resumen = {
    total_ventas_leidas: Array.isArray(ventas) ? ventas.length : 0,
    total_ordenes_consultadas: 0,
    total_ordenes_resueltas_cache: 0,
    total_ordenes_consultadas_tiendanube: 0,
    total_errores_sheets: 0,
    total_errores_tiendanube: 0,
  };

  let catalogos = {};
  let connection;
  const [catalogosResult, connectionResult] = await Promise.allSettled([
    getCatalogos(),
    resolveTiendanubeConnection(),
  ]);

  if (catalogosResult.status === 'fulfilled') {
    catalogos = catalogosResult.value || {};
  } else if (isSheetsQuotaError(catalogosResult.reason)) {
    resumen.total_errores_sheets += 1;
  } else {
    throw catalogosResult.reason;
  }

  if (connectionResult.status === 'fulfilled') {
    connection = connectionResult.value;
  } else if (isSheetsQuotaError(connectionResult.reason)) {
    resumen.total_errores_sheets += 1;
    return {
      ok: false,
      code: 'SHEETS_QUOTA_EXCEEDED',
      detalle_estado: 'error_sheets_quota',
      message: 'Se excedió la cuota de lectura de Google Sheets al resolver configuración de Tiendanube.',
      headers: [],
      rows: [],
      resumen,
    };
  } else {
    throw connectionResult.reason;
  }

  const storeId = String(connection?.storeId || '').trim();
  const accessToken = String(connection?.accessToken || '').trim();
  if (!storeId || !accessToken) {
    throw new Error('Falta configuración de Tiendanube (store_id o access_token).');
  }

  const skuMap = buildSkuMap(catalogos);
  const ventasMap = uniqueVentasByOrderId(ventas);
  const orderIds = Array.from(ventasMap.keys());
  resumen.total_ordenes_consultadas = orderIds.length;

  const resolvedOrdersMap = new Map();
  const uncachedOrderIds = [];

  orderIds.forEach((orderId) => {
    const cached = getCachedOrder(orderId);
    if (cached) {
      resolvedOrdersMap.set(orderId, { ...cached, source: 'cache' });
      resumen.total_ordenes_resueltas_cache += 1;
      return;
    }
    uncachedOrderIds.push(orderId);
  });

  for (const chunk of splitInChunks(uncachedOrderIds, MAX_CONCURRENCY)) {
    const results = await Promise.all(chunk.map(async (orderId) => {
      const fetched = await fetchOrderByIdWithRetry({
        storeId,
        accessToken,
        orderId,
      });
      if (fetched.ok) {
        const items = extractOrderItems(fetched.order || {});
        const value = {
          orderId,
          products: items,
          status: items.length ? 'ok' : 'sin_products',
          errorMessage: '',
          httpStatus: fetched.httpStatus || 200,
          resolvedAt: new Date().toISOString(),
          source: fetched.source || 'tiendanube',
        };
        setCachedOrder(orderId, value);
        return value;
      }

      const value = {
        orderId,
        products: [],
        status: fetched.status || 'error_api',
        errorMessage: fetched.errorMessage || 'Error consultando Tiendanube',
        httpStatus: fetched.httpStatus || '',
        resolvedAt: new Date().toISOString(),
        source: fetched.source || 'tiendanube',
      };
      setCachedOrder(orderId, value);
      return value;
    }));

    results.forEach((result) => {
      resolvedOrdersMap.set(result.orderId, result);
      resumen.total_ordenes_consultadas_tiendanube += 1;
      if (String(result.status || '').startsWith('error_tiendanube') || result.status === 'error_api') {
        resumen.total_errores_tiendanube += 1;
      }
    });
  }

  const headers = [
    'fecha',
    'ticket',
    'order_id',
    'cliente',
    'producto',
    'product_id',
    'variant_id',
    'sku',
    'talla',
    'cantidad',
    'precio_unitario',
    'subtotal_item',
    'estado',
    'vendedora',
    'detalle_estado',
    'detalle_error',
    'fuente_detalle',
    'http_status',
  ];

  const rows = [];

  orderIds.forEach((orderId) => {
    const venta = ventasMap.get(orderId) || {};
    const resolved = resolvedOrdersMap.get(orderId);
    if (!resolved) return;

    const baseRow = [
      normalizeDate(venta.created_at),
      String(venta.ticket_label || venta.ticket_number || orderId),
      orderId,
      String(venta.customer_name || ''),
    ];

    if (resolved.status !== 'ok' && resolved.status !== 'sin_products') {
      rows.push([
        ...baseRow,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        String(venta.payment_status || ''),
        String(venta.seller || ''),
        resolved.status,
        resolved.errorMessage || '',
        resolved.source || 'tiendanube',
        resolved.httpStatus || '',
      ]);
      return;
    }

    const products = Array.isArray(resolved.products) ? resolved.products : [];
    if (!products.length) {
      rows.push([
        ...baseRow,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        String(venta.payment_status || ''),
        String(venta.seller || ''),
        'sin_products',
        '',
        resolved.source || 'tiendanube',
        resolved.httpStatus || 200,
      ]);
      return;
    }

    products.forEach((item = {}) => {
      const sku = String(item.sku || '').trim();
      const tallaFromSku = extraerTallaDesdeSku(sku);
      const tallaFromNombre = extraerTallaDesdeNombre(item.productName);
      const talla = (skuMap.get(String(tallaFromSku || '').toUpperCase()) || tallaFromSku || tallaFromNombre || '');
      rows.push([
        ...baseRow,
        String(item.productName || ''),
        String(item.productId || ''),
        String(item.variantId || ''),
        sku,
        talla,
        normalizeNumber(item.quantity, 1),
        normalizeNumber(item.unitPrice, 0).toFixed(2),
        normalizeNumber(item.subtotal, 0).toFixed(2),
        String(venta.payment_status || ''),
        String(venta.seller || ''),
        resolved.status === 'ok' ? 'ok' : 'sin_products',
        '',
        resolved.source || 'tiendanube',
        resolved.httpStatus || 200,
      ]);
    });
  });

  return {
    ok: true,
    headers,
    rows,
    resumen,
  };
}
