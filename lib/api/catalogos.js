import { createSheetsClient } from "../google/sheetsClient.js";

const DICTIONARY_SHEETS = {
  tipos: "diccionario_tipos",
  proveedores: "diccionario_proveedores",
  colores: "diccionario_colores",
  tallas: "diccionario_tallas"
};



const REQUIRED_DICTIONARY_HEADERS = ['Orden', 'Clave', 'Valor'];

const normalizeHeader = (value) => String(value || '').trim().toLowerCase();

const assertHeadersExist = (headers = [], requiredHeaders = [], sheetName = '') => {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const missing = requiredHeaders.filter((header) => !normalizedHeaders.includes(normalizeHeader(header)));
  if (!missing.length) return;
  if (missing.length === 1) throw new Error(`Falta la columna ${missing[0]} en la hoja ${sheetName}.`);
  throw new Error(`Faltan columnas (${missing.join(', ')}) en la hoja ${sheetName}.`);
};

const assertSheetExists = async (sheets, sheetName) => {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID, includeGridData: false });
  const names = (metadata?.data?.sheets || []).map((sheet) => String(sheet?.properties?.title || '').trim());
  if (!names.includes(sheetName)) throw new Error(`No existe la hoja ${sheetName}.`);
};

const toDictionaryEntries = (rows = []) => rows
  .map((row = []) => {
    const ordenValue = Number.parseInt(String(row[0] ?? "").trim(), 10);
    const clave = String(row[1] ?? "").trim();
    const valor = String(row[2] ?? "").trim();
    if (!clave && !valor) return null;
    return {
      orden: Number.isFinite(ordenValue) ? ordenValue : Number.MAX_SAFE_INTEGER,
      clave,
      valor
    };
  })
  .filter((entry) => entry && (entry.clave || entry.valor))
  .sort((a, b) => a.orden - b.orden)
  .map((entry) => ({
    orden: Number.isFinite(entry.orden) && entry.orden !== Number.MAX_SAFE_INTEGER ? entry.orden : 999999,
    clave: entry.clave,
    valor: entry.valor
  }));

const loadDictionarySheet = async (sheets, sheetName) => {
  await assertSheetExists(sheets, sheetName);
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!A1:C1`
  });
  const headers = (headerResponse?.data?.values?.[0] || []).map((header) => String(header || '').trim());
  if (!headers.length) throw new Error(`La hoja ${sheetName} no tiene encabezados.`);
  assertHeadersExist(headers, REQUIRED_DICTIONARY_HEADERS, sheetName);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!A2:C`
  });
  return toDictionaryEntries(response?.data?.values || []);
};

export async function getCatalogos() {
  const sheets = createSheetsClient({ readOnly: true });
  try {
    const [tipos, proveedores, colores, tallas] = await Promise.all([
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.tipos),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.proveedores),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.colores),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.tallas)
    ]);

    return { tipos, proveedores, colores, tallas };
  } catch (error) {
    throw new Error(`No se pudieron cargar los diccionarios desde Sheets. ${error?.message || ''}`.trim());
  }
}
