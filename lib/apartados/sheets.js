import { google } from "googleapis";

const APARTADOS_HEADERS = [
  "Folio",
  "Fecha",
  "Cliente",
  "Contacto",
  "Subtotal",
  "DescuentoTipo",
  "DescuentoValor",
  "DescuentoMXN",
  "Total",
  "Anticipo",
  "Saldo",
  "Estado",
  "FechaCreacion",
  "UltimoMovimiento",
  "GenerarTicket",
  "PdfUrl",
];

const APARTADOS_ITEMS_HEADERS = [
  "Folio",
  "Codigo",
  "Descripcion",
  "Tipo",
  "Color",
  "Talla",
  "Proveedor",
  "Precio",
  "FechaCreacion",
];

const APARTADOS_ABONOS_HEADERS = [
  "Folio",
  "Fecha",
  "Monto",
  "Metodo",
  "Comentario",
  "FechaCreacion",
];

const REQUIRED_SHEETS = [
  { name: "apartados", headers: APARTADOS_HEADERS },
  { name: "apartados_items", headers: APARTADOS_ITEMS_HEADERS },
  { name: "apartados_abonos", headers: APARTADOS_ABONOS_HEADERS },
];

export function getSpreadsheetId() {
  return process.env.SHEET_ID;
}

export function createSheetsClient() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function columnToLetter(columnNumber) {
  let current = columnNumber;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

export async function ensureSheetsSetup(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Map(
    (meta.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet.properties?.sheetId])
  );

  const addRequests = REQUIRED_SHEETS.filter(({ name }) => !existing.has(name)).map(({ name }) => ({
    addSheet: {
      properties: {
        title: name,
      },
    },
  }));

  if (addRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: addRequests,
      },
    });
  }

  for (const { name, headers } of REQUIRED_SHEETS) {
    const currentHeaders = await getSheetHeaders(sheets, spreadsheetId, name);
    const headersMismatch = currentHeaders.length !== headers.length || headers.some((header, idx) => currentHeaders[idx] !== header);
    if (currentHeaders.length === 0 || headersMismatch) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${name}!A1:${columnToLetter(headers.length)}1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [headers],
        },
      });
    }
  }
}

export async function getSheetHeaders(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });
  return (response.data.values && response.data.values[0]) || [];
}

export async function readSheetRows(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:ZZ`,
  });
  const rows = response.data.values || [];
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];
  return rows.slice(1).map((row, rowIndex) => {
    const rowObject = { __rowNumber: rowIndex + 2 };
    headers.forEach((header, index) => {
      rowObject[header] = row[index] ?? "";
    });
    return rowObject;
  });
}

export async function appendSheetRow(sheets, spreadsheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });
}

export async function updateSheetRow(sheets, spreadsheetId, sheetName, rowNumber, values) {
  const endColumn = columnToLetter(values.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${rowNumber}:${endColumn}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

export function buildRowByTargetHeaders(sourceRowObject, targetHeaders, extraValues = {}) {
  const normalizedSource = new Map();
  Object.entries(sourceRowObject || {}).forEach(([key, value]) => {
    normalizedSource.set(normalizeKey(key), value);
  });

  return targetHeaders.map((header) => {
    if (Object.prototype.hasOwnProperty.call(extraValues, header)) {
      return extraValues[header];
    }
    const normalizedHeader = normalizeKey(header);
    if (normalizedSource.has(normalizedHeader)) {
      return normalizedSource.get(normalizedHeader);
    }
    return "";
  });
}

export function parseCurrencyNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const normalized = String(value || "").replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundMoney(value) {
  return Number(parseCurrencyNumber(value).toFixed(2));
}

export function nowIso() {
  return new Date().toISOString();
}

export const SHEET_HEADERS = {
  apartados: APARTADOS_HEADERS,
  apartados_items: APARTADOS_ITEMS_HEADERS,
  apartados_abonos: APARTADOS_ABONOS_HEADERS,
};
