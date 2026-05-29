import { appendSheetRowsRaw } from '../google/sheetsClient.js';
import {
  collectExistingOrderIds,
  ensureVentasTNHeaders,
  fetchTiendanubeOrders,
  mapHeadersToRow,
  normalizeCommissionRate,
  normalizeTiendanubeOrder,
  readSheetTable,
  rebuildVentasResumen,
  resolveTiendanubeConnection,
  updateVentasConfigLastSync,
} from './syncHelpers.js';

export async function syncVentasFromTiendanube(options = {}) {
  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'sync:start',
  });

  const connection = await resolveTiendanubeConnection();
  const config = connection.config;
  const storeId = connection.storeId;
  const defaultRate = normalizeCommissionRate(config?.default_commission_rate, 0.1);
  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'fetch:orders:start',
  });

  const rawOrders = await fetchTiendanubeOrders(storeId, connection.accessToken || '', {
    tokenSource: connection.tokenSource,
    storeSource: connection.storeSource,
    configStoreId: connection?.config?.store_id,
  });
  const normalizedOrders = rawOrders
    .map((order) => normalizeTiendanubeOrder(order, defaultRate))
    .filter(Boolean);

  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'fetch:orders:done',
    orders: Array.isArray(rawOrders) ? rawOrders.length : 0,
  });

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

  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'sheets:write:start',
  });

  if (rowsToAppend.length > 0) {
    await appendSheetRowsRaw(sheets, 'VentasTN', rowsToAppend);
    rows.push(...rowsToAppend);
  }

  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'sheets:write:done',
  });

  const monthsRebuilt = [];
  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'summary:rebuild:start',
  });
  for (const monthKey of monthsTouched) {
    try {
      await rebuildVentasResumen(monthKey);
      monthsRebuilt.push(monthKey);
    } catch (error) {
      console.error('[ventas.summary.rebuild.failed]', {
        message: error?.message || '',
        stack: error?.stack || '',
      });
    }
  }

  console.log('[ventas.sync.step]', {
    traceId: options?.traceId || '',
    step: 'summary:rebuild:done',
  });

  const configTable = await readSheetTable('VentasConfig', { readOnly: false });
  await updateVentasConfigLastSync(configTable.sheets, configTable.headers, configTable.rows, new Date().toISOString());

  return {
    synced: normalizedOrders.length,
    inserted: rowsToAppend.length,
    updated: 0,
    months_rebuilt: monthsRebuilt,
  };
}
