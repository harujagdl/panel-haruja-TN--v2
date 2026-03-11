import { google } from "googleapis";

const ACTIVE_SHEET = "prendas_admin_activas";
const ARCHIVE_SHEET = "prendas_admin_archivo";
const CODE_HEADER = "Código";
const ARCHIVED_AT_HEADER = "ArchivedAt";

const createSheetsClient = () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
};

const getSpreadsheetId = () => String(process.env.SHEET_ID || "").trim();

const getSheetHeaders = async (sheets, sheetName) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A1:ZZ1`
  });
  return (response?.data?.values?.[0] || []).map((header) => String(header || "").trim());
};

const getSpreadsheetSheetNames = async (sheets) => {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    includeGridData: false
  });

  return (metadata?.data?.sheets || [])
    .map((sheet) => String(sheet?.properties?.title || "").trim())
    .filter(Boolean);
};

const readSheetRows = async (sheets, sheetName) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:ZZ`
  });
  const values = response?.data?.values || [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((row, index) => {
    const sourceRowObject = {};
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      sourceRowObject[header] = String(row?.[columnIndex] || "").trim();
    });
    return {
      rowNumber: index + 2,
      values: row,
      sourceRowObject
    };
  });

  return { headers, rows };
};

const appendSheetRow = async (sheets, sheetName, values) => {
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      majorDimension: "ROWS",
      values: [values]
    }
  });
};

const verifyRowExistsByCodigo = async (sheets, sheetName, codigo) => {
  const { rows } = await readSheetRows(sheets, sheetName);
  return rows.some((row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo);
};

const getSheetId = async (sheets, sheetName) => {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    includeGridData: false
  });
  const targetSheet = (metadata?.data?.sheets || []).find(
    (sheet) => sheet?.properties?.title === sheetName
  );
  return targetSheet?.properties?.sheetId;
};

const deleteSheetRow = async (sheets, sheetName, rowNumber) => {
  const sheetId = await getSheetId(sheets, sheetName);
  if (!Number.isInteger(sheetId)) {
    throw new Error(`No se pudo resolver la hoja: ${sheetName}.`);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber
            }
          }
        }
      ]
    }
  });
};

const buildRowByTargetHeaders = (sourceRowObject, targetHeaders, extraValues = {}) => {
  return (Array.isArray(targetHeaders) ? targetHeaders : []).map((header) => {
    const safeHeader = String(header || "").trim();
    if (!safeHeader) return "";
    if (Object.prototype.hasOwnProperty.call(extraValues, safeHeader)) {
      return extraValues[safeHeader];
    }
    if (Object.prototype.hasOwnProperty.call(sourceRowObject || {}, safeHeader)) {
      return sourceRowObject[safeHeader];
    }
    return "";
  });
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const codigo = String(req.body?.codigo || "").trim();
    console.log("[archive] payload codigo:", codigo);
    if (!codigo) {
      return res.status(400).json({ ok: false, message: "El campo 'codigo' es obligatorio." });
    }

    const sheets = createSheetsClient();
    const sheetNames = await getSpreadsheetSheetNames(sheets);
    if (!sheetNames.includes(ACTIVE_SHEET)) {
      throw new Error("No existe la hoja prendas_admin_activas");
    }
    if (!sheetNames.includes(ARCHIVE_SHEET)) {
      throw new Error("No existe la hoja prendas_admin_archivo");
    }

    console.log("[archive] leyendo hoja activas");
    const activeData = await readSheetRows(sheets, ACTIVE_SHEET);
    console.log("[archive] leyendo hoja archivo");
    const archiveHeaders = await getSheetHeaders(sheets, ARCHIVE_SHEET);
    console.log("[archive] headers activas:", activeData.headers);
    console.log("[archive] headers archivo:", archiveHeaders);

    if (!activeData.headers.includes(CODE_HEADER)) {
      throw new Error('La hoja activa no contiene la columna "Código".');
    }

    if (!archiveHeaders.includes(CODE_HEADER)) {
      throw new Error('La hoja de archivo no contiene la columna "Código".');
    }

    const rowEncontrada = activeData.rows.find(
      (row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo
    );
    console.log("[archive] row encontrada:", rowEncontrada);

    if (!rowEncontrada) {
      return res.status(404).json({ ok: false, message: "Código no encontrado en activas." });
    }

    const sheetRowNumber = rowEncontrada.rowNumber;
    console.log("[archive] rowNumber activa:", sheetRowNumber);

    const extraValues = {};
    if (archiveHeaders.includes(ARCHIVED_AT_HEADER)) {
      extraValues[ARCHIVED_AT_HEADER] = new Date().toISOString();
    }

    const rowValuesArchivo = buildRowByTargetHeaders(
      rowEncontrada.sourceRowObject,
      archiveHeaders,
      extraValues
    );
    console.log("[archive] values para archivo:", rowValuesArchivo);

    await appendSheetRow(sheets, ARCHIVE_SHEET, rowValuesArchivo);

    const archivedExists = await verifyRowExistsByCodigo(sheets, ARCHIVE_SHEET, codigo);

    if (!archivedExists) {
      throw new Error("No se pudo verificar el guardado en archivo; no se eliminará de activas.");
    }

    await deleteSheetRow(sheets, ACTIVE_SHEET, sheetRowNumber);

    return res.status(200).json({ ok: true, codigo, archived: true });
  } catch (error) {
    console.error("[prendas-archive] error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      message: "Error archivando registro.",
      error: error.message
    });
  }
}
