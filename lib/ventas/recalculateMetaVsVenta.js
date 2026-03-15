import {
  appendSheetRowRaw,
  createSheetsClient,
  getSheetHeadersRaw,
  readSheetRowsRaw,
  updateSheetRowRaw,
} from '../google/sheetsClient.js';

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

export async function recalculateMetaVsVenta(monthKey) {
  const sheets = createSheetsClient({ readOnly: false });

  let metaHeaders;
  try {
    metaHeaders = await getSheetHeadersRaw(sheets, 'MetaVsVenta');
  } catch {
    return { skipped: true, reason: 'MetaVsVenta sheet not found' };
  }

  const resumenHeaders = await getSheetHeadersRaw(sheets, 'VentasResumen');
  const resumenRows = await readSheetRowsRaw(sheets, 'VentasResumen!A2:ZZ');
  const resumenRecord = resumenRows
    .map((row) => rowToRecord(resumenHeaders, row))
    .find((record) => String(record.month_key || '').trim() === String(monthKey || '').trim());

  if (!resumenRecord) return { skipped: true, reason: 'resumen not found' };

  const ventasTotales = parseNumber(resumenRecord.total_mes, 0);
  const metaRows = await readSheetRowsRaw(sheets, 'MetaVsVenta!A2:ZZ');
  const monthIndex = metaHeaders.findIndex((header) => normalizeHeader(header) === 'month_key');
  if (monthIndex < 0) return { skipped: true, reason: 'month_key missing in MetaVsVenta' };

  const rowIndex = metaRows.findIndex((row) => String(row?.[monthIndex] || '').trim() === String(monthKey || '').trim());

  const rowRecord = rowIndex >= 0 ? rowToRecord(metaHeaders, metaRows[rowIndex] || []) : {};
  rowRecord.month_key = String(monthKey || '').trim();
  rowRecord.avance_mensual = ventasTotales;

  const monthlyGoal = parseNumber(rowRecord.meta_mensual || rowRecord.meta || 0, 0);
  rowRecord.porcentaje_meta = monthlyGoal > 0 ? (ventasTotales / monthlyGoal) * 100 : 0;
  rowRecord.faltante = Math.max(monthlyGoal - ventasTotales, 0);
  rowRecord.ventas_por_vendedora = JSON.stringify({
    Haru: parseNumber(resumenRecord.total_haru, 0),
    Vendedora: parseNumber(resumenRecord.total_vendedora, 0),
  });

  if (rowIndex >= 0) {
    await updateSheetRowRaw(sheets, `MetaVsVenta!A${rowIndex + 2}:ZZ${rowIndex + 2}`, mapHeadersToRow(metaHeaders, rowRecord));
    return { skipped: false, updated: true };
  }

  await appendSheetRowRaw(sheets, 'MetaVsVenta', mapHeadersToRow(metaHeaders, rowRecord));
  return { skipped: false, updated: true };
}
