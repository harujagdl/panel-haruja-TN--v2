import { createSheetsClient, getSpreadsheetId } from "../google/sheetsClient.js";

const TARGET_SHEET_CANDIDATES = ["prendas_admin", "prendas_admin_activas"];
const TARGET_SHEET = "prendas_admin_activas";
const ARCHIVE_SHEET = "prendas_admin_archivo";
const CODE_COLUMN_INDEX = 1;
const CODE_HEADER = "Código";
const ARCHIVED_AT_HEADER = "ArchivedAt";

const ADMIN_COLUMNS = [
  "Orden", "Código", "Descripción", "Tipo", "Color", "Talla", "Proveedor", "TN", "Status", "Disponibilidad", "Existencia", "Fecha", "Precio", "Costo", "Margen", "Utilidad", "InventorySource", "LastInventorySyncAt"
];

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getNextOrden = async (sheets) => {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A2:A` });
  const rows = response?.data?.values || [];
  const maxOrden = rows.reduce((acc, row) => Math.max(acc, asNumber(row?.[0], 0)), 0);
  return maxOrden + 1;
};

async function getSpreadsheetSheetNames(sheets) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  return (metadata?.data?.sheets || []).map((sheet) => String(sheet?.properties?.title || "").trim()).filter(Boolean);
}


async function getFirstExistingSheetName(sheets, candidates = []) {
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  for (const candidate of candidates) {
    if (sheetNames.includes(candidate)) return candidate;
  }
  throw new Error(`No existe ninguna de las hojas esperadas: ${candidates.join(', ')}.`);
}

async function getSheetHeaders(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A1:ZZ1` });
  return (response?.data?.values?.[0] || []).map((header) => String(header || "").trim());
}

async function readSheetRows(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A:ZZ` });
  const values = response?.data?.values || [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((row, index) => {
    const sourceRowObject = {};
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      sourceRowObject[header] = String(row?.[columnIndex] || "").trim();
    });
    return { rowNumber: index + 2, values: row, sourceRowObject };
  });
  return { headers, rows };
}

async function appendSheetRow(sheets, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { majorDimension: "ROWS", values: [values] }
  });
}

async function getSheetId(sheets, sheetName) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  const targetSheet = (metadata?.data?.sheets || []).find((sheet) => sheet?.properties?.title === sheetName);
  return targetSheet?.properties?.sheetId;
}

async function deleteSheetRow(sheets, sheetName, rowNumber) {
  const sheetId = await getSheetId(sheets, sheetName);
  if (!Number.isInteger(sheetId)) throw new Error(`No se pudo resolver la hoja: ${sheetName}.`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }] }
  });
}

function buildRowByTargetHeaders(sourceRowObject, targetHeaders, extraValues = {}) {
  return (Array.isArray(targetHeaders) ? targetHeaders : []).map((header) => {
    const safeHeader = String(header || "").trim();
    if (!safeHeader) return "";
    if (Object.prototype.hasOwnProperty.call(extraValues, safeHeader)) return extraValues[safeHeader];
    if (Object.prototype.hasOwnProperty.call(sourceRowObject || {}, safeHeader)) return sourceRowObject[safeHeader];
    return "";
  });
}

export async function listPrendas() {
  const sheets = createSheetsClient({ readOnly: true });
  const sheetName = await getFirstExistingSheetName(sheets, TARGET_SHEET_CANDIDATES);
  console.log('[Sheets] hoja consultada prendas:', sheetName);
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A1:R3000` });
  const rows = response?.data?.values || [];
  if (!rows.length) return [];
  const headers = rows[0];
  if (!headers.length) {
    throw new Error(`La hoja ${sheetName} no tiene encabezados.`);
  }
  const requiredHeaders = ["Código"];
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`Falta la columna ${missing[0]} en la hoja ${sheetName}.`);
  }
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => { obj[header] = row[i] ?? ""; });
    return obj;
  });
}

export async function createPrenda(payload = {}) {
  const sheets = createSheetsClient();
  const orden = asNumber(payload.orden, 0) > 0 ? asNumber(payload.orden, 0) : await getNextOrden(sheets);
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const row = [
    orden, codigo, String(payload.descripcion || "").trim(), String(payload.tipo || "").trim(), String(payload.color || "").trim(), String(payload.talla || "").trim(), String(payload.proveedor || "").trim(), String(payload.tn || "N/A").trim(), String(payload.status || "No definido").trim(), String(payload.disponibilidad || "No definido").trim(), asNumber(payload.existencia, 0), String(payload.fecha || "").trim(), String(payload.precio ?? "").trim(), String(payload.costo ?? "").trim(), String(payload.margen ?? "").trim(), String(payload.utilidad ?? "").trim(), String(payload.inventorySource || "manual").trim(), String(payload.lastInventorySyncAt ?? "").trim()
  ];
  await sheets.spreadsheets.values.append({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A:R`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { majorDimension: "ROWS", values: [row] } });
  return { ok: true, codigo, orden, columns: ADMIN_COLUMNS };
}

export async function deletePrenda(payload = {}) {
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const sheets = createSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A2:R` });
  const rows = response?.data?.values || [];
  const rowIndex = rows.findIndex((row) => String(row?.[CODE_COLUMN_INDEX] || "").trim() === codigo);
  if (rowIndex === -1) return { status: 404, body: { ok: false, message: "Código no encontrado." } };
  const targetRowNumber = rowIndex + 2;
  await deleteSheetRow(sheets, TARGET_SHEET, targetRowNumber);
  return { ok: true, codigo, deleted: true };
}

export async function archivePrenda(payload = {}) {
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const sheets = createSheetsClient();
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  if (!sheetNames.includes(TARGET_SHEET)) throw new Error("No existe la hoja prendas_admin_activas");
  if (!sheetNames.includes(ARCHIVE_SHEET)) throw new Error("No existe la hoja prendas_admin_archivo");

  const activeData = await readSheetRows(sheets, TARGET_SHEET);
  const archiveHeaders = await getSheetHeaders(sheets, ARCHIVE_SHEET);
  if (!activeData.headers.includes(CODE_HEADER)) throw new Error('La hoja activa no contiene la columna "Código".');
  if (!archiveHeaders.includes(CODE_HEADER)) throw new Error('La hoja de archivo no contiene la columna "Código".');

  const rowEncontrada = activeData.rows.find((row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo);
  if (!rowEncontrada) return { status: 404, body: { ok: false, message: "Código no encontrado en activas." } };

  const extraValues = {};
  if (archiveHeaders.includes(ARCHIVED_AT_HEADER)) extraValues[ARCHIVED_AT_HEADER] = new Date().toISOString();
  const rowValuesArchivo = buildRowByTargetHeaders(rowEncontrada.sourceRowObject, archiveHeaders, extraValues);
  await appendSheetRow(sheets, ARCHIVE_SHEET, rowValuesArchivo);
  await deleteSheetRow(sheets, TARGET_SHEET, rowEncontrada.rowNumber);
  return { ok: true, codigo, archived: true };
}
