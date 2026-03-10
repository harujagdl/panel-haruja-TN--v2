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

const readSheetAsObjects = async (sheets, sheetName) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!A:ZZ`
  });

  const values = response?.data?.values || [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = (values.slice(1) || []).map((row, index) => {
    const obj = {};
    headers.forEach((header, headerIndex) => {
      if (!header) return;
      obj[header] = String(row?.[headerIndex] || "").trim();
    });
    return {
      rowNumber: index + 2,
      values: row,
      obj
    };
  });

  return { headers, rows };
};

const appendRow = async (sheets, sheetName, values) => {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      majorDimension: "ROWS",
      values: [values]
    }
  });
};

const getSheetId = async (sheets, sheetName) => {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
    includeGridData: false
  });
  const targetSheet = (metadata?.data?.sheets || []).find(
    (sheet) => sheet?.properties?.title === sheetName
  );
  return targetSheet?.properties?.sheetId;
};

const deleteRow = async (sheets, sheetName, rowNumber) => {
  const sheetId = await getSheetId(sheets, sheetName);
  if (!Number.isInteger(sheetId)) {
    throw new Error(`No se pudo resolver la hoja: ${sheetName}.`);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
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

const ensureArchiveSheet = async (sheets, activeHeaders = []) => {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
    includeGridData: false
  });
  const archiveExists = (metadata?.data?.sheets || []).some(
    (sheet) => sheet?.properties?.title === ARCHIVE_SHEET
  );

  if (!archiveExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: ARCHIVE_SHEET } } }]
      }
    });

    const headers = [...activeHeaders];
    if (!headers.includes(ARCHIVED_AT_HEADER)) {
      headers.push(ARCHIVED_AT_HEADER);
    }
    if (headers.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SHEET_ID,
        range: `${ARCHIVE_SHEET}!A1`,
        valueInputOption: "RAW",
        requestBody: {
          majorDimension: "ROWS",
          values: [headers]
        }
      });
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const codigo = String(req.body?.codigo || "").trim();
    if (!codigo) {
      return res.status(400).json({ ok: false, message: "El campo 'codigo' es obligatorio." });
    }

    const sheets = createSheetsClient();
    const activeData = await readSheetAsObjects(sheets, ACTIVE_SHEET);
    const codeColumnExists = activeData.headers.includes(CODE_HEADER);
    if (!codeColumnExists) {
      return res.status(500).json({ ok: false, message: "La hoja activa no contiene columna 'Código'." });
    }

    const activeRow = activeData.rows.find(
      (row) => String(row?.obj?.[CODE_HEADER] || "").trim() === codigo
    );
    if (!activeRow) {
      return res.status(404).json({ ok: false, message: "Código no encontrado en activas." });
    }

    await ensureArchiveSheet(sheets, activeData.headers);
    const archiveData = await readSheetAsObjects(sheets, ARCHIVE_SHEET);
    const archiveHeaders = archiveData.headers || [];
    const archivedAtColumnIndex = archiveHeaders.indexOf(ARCHIVED_AT_HEADER);

    const rowToArchive = [...(activeRow.values || [])];
    if (archivedAtColumnIndex >= 0) {
      while (rowToArchive.length <= archivedAtColumnIndex) {
        rowToArchive.push("");
      }
      rowToArchive[archivedAtColumnIndex] = new Date().toISOString();
    }

    await appendRow(sheets, ARCHIVE_SHEET, rowToArchive);
    await deleteRow(sheets, ACTIVE_SHEET, activeRow.rowNumber);

    return res.status(200).json({ ok: true, codigo, archived: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudo archivar el registro.",
      error: error?.message || "Unknown error"
    });
  }
}
