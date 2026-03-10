import { google } from "googleapis";

const ACTIVE_SHEET = "prendas_admin_activas";
const ARCHIVE_SHEET = "prendas_admin_archivo";
const CODE_HEADER = "Código";

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
    console.log("[prendas-restore] codigo recibido:", codigo);
    if (!codigo) {
      return res.status(400).json({ ok: false, message: "El campo 'codigo' es obligatorio." });
    }

    const sheets = createSheetsClient();
    const archivedData = await readSheetRows(sheets, ARCHIVE_SHEET);

    if (!archivedData.headers.includes(CODE_HEADER)) {
      return res.status(500).json({ ok: false, message: "La hoja de archivo no contiene columna 'Código'." });
    }

    const activeHeaders = await getSheetHeaders(sheets, ACTIVE_SHEET);
    if (!activeHeaders.length) {
      return res.status(500).json({ ok: false, message: "La hoja activa no contiene encabezados válidos." });
    }

    const archivedRow = archivedData.rows.find(
      (row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo
    );
    console.log("[prendas-restore] fila encontrada en archivo:", Boolean(archivedRow));

    if (!archivedRow) {
      return res.status(404).json({ ok: false, message: "Código no encontrado en archivo." });
    }

    const restoreRowValues = buildRowByTargetHeaders(archivedRow.sourceRowObject, activeHeaders);
    await appendSheetRow(sheets, ACTIVE_SHEET, restoreRowValues);
    console.log("[prendas-restore] append realizado en activas");

    const restoredExists = await verifyRowExistsByCodigo(sheets, ACTIVE_SHEET, codigo);
    console.log("[prendas-restore] verificación append exitosa:", restoredExists);

    if (!restoredExists) {
      return res.status(500).json({
        ok: false,
        message: "No se pudo restaurar el registro."
      });
    }

    await deleteSheetRow(sheets, ARCHIVE_SHEET, archivedRow.rowNumber);
    console.log("[prendas-restore] delete realizado en archivo");

    return res.status(200).json({ ok: true, codigo, restored: true });
  } catch (error) {
    console.error("[prendas-restore] error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      message: "No se pudo restaurar el registro."
    });
  }
}
