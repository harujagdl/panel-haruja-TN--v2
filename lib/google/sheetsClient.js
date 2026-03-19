import { google } from "googleapis";
import { getGoogleServiceAccountCredentials } from "./service-account.js";

export function getSpreadsheetId() {
  return String(process.env.SHEET_ID || "").trim();
}

export function createSheetsClient({ readOnly = false } = {}) {
  const credentials = getGoogleServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      readOnly
        ? "https://www.googleapis.com/auth/spreadsheets.readonly"
        : "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  return google.sheets({ version: "v4", auth });
}

export async function getSpreadsheetMetadata(sheets) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    includeGridData: false
  });
  return response?.data || {};
}

export async function getSpreadsheetSheetNames(sheets) {
  const metadata = await getSpreadsheetMetadata(sheets);
  return (metadata?.sheets || [])
    .map((sheet) => String(sheet?.properties?.title || "").trim())
    .filter(Boolean);
}

export async function assertSheetExists(sheets, sheetName) {
  const safeName = String(sheetName || "").trim();
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  if (!sheetNames.includes(safeName)) {
    console.error("[Sheets] No existe la hoja:", safeName);
    throw new Error(`No existe la hoja ${safeName}.`);
  }
}

export function assertHeadersExist(headers = [], requiredHeaders = [], sheetName = "") {
  const normalizedHeaders = headers.map((header) => String(header || "").trim().toLowerCase());
  const missing = requiredHeaders.filter((header) => !normalizedHeaders.includes(String(header || "").trim().toLowerCase()));
  if (missing.length > 0) {
    const missingLabel = missing.join(", ");
    console.error("[Sheets] Faltan columnas requeridas", { sheetName, requiredHeaders, missing });
    if (missing.length === 1) {
      throw new Error(`Falta la columna ${missing[0]} en la hoja ${sheetName}.`);
    }
    throw new Error(`Faltan columnas (${missingLabel}) en la hoja ${sheetName}.`);
  }
}

export async function getFirstExistingSheetName(sheets, sheetNames = []) {
  const allSheetNames = await getSpreadsheetSheetNames(sheets);
  for (const candidate of sheetNames) {
    const normalized = String(candidate || "").trim();
    if (!normalized) continue;
    if (allSheetNames.includes(normalized)) return normalized;
  }
  throw new Error(`No existe ninguna de las hojas esperadas: ${sheetNames.join(", ")}.`);
}

export async function readSheetRowsRaw(sheets, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range
  });
  return response?.data?.values || [];
}

export async function readSheetRangesBatchRaw(sheets, ranges = []) {
  const safeRanges = Array.isArray(ranges)
    ? ranges.map((range) => String(range || '').trim()).filter(Boolean)
    : [];
  if (!safeRanges.length) return {};

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: getSpreadsheetId(),
    ranges: safeRanges,
  });

  const valueRanges = Array.isArray(response?.data?.valueRanges) ? response.data.valueRanges : [];
  const byRange = {};
  valueRanges.forEach((item = {}) => {
    const range = String(item.range || '').trim();
    if (!range) return;
    byRange[range] = Array.isArray(item.values) ? item.values : [];
  });
  return byRange;
}

export async function getSheetHeadersRaw(sheets, sheetName) {
  const rows = await readSheetRowsRaw(sheets, `${sheetName}!A1:ZZ1`);
  return (rows[0] || []).map((header) => String(header || "").trim());
}

export async function appendSheetRowRaw(sheets, sheetName, values) {
  return appendSheetRowsRaw(sheets, sheetName, [values]);
}

export async function appendSheetRowsRaw(sheets, sheetName, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      majorDimension: "ROWS",
      values: rows
    }
  });
}

export async function updateSheetRowRaw(sheets, range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      majorDimension: "ROWS",
      values: [values]
    }
  });
}
