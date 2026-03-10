import { google } from "googleapis";

const TARGET_SHEET = "prendas_admin_activas";
const CODE_COLUMN_INDEX = 1;

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
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${TARGET_SHEET}!A2:R`
    });

    const rows = response?.data?.values || [];
    const rowIndex = rows.findIndex((row) => String(row?.[CODE_COLUMN_INDEX] || "").trim() === codigo);

    if (rowIndex === -1) {
      return res.status(404).json({ ok: false, message: "Código no encontrado." });
    }

    const sheetMeta = await sheets.spreadsheets.get({
      spreadsheetId: process.env.SHEET_ID,
      ranges: [TARGET_SHEET],
      includeGridData: false
    });

    const targetSheet = (sheetMeta?.data?.sheets || []).find(
      (sheet) => sheet?.properties?.title === TARGET_SHEET
    );

    const sheetId = targetSheet?.properties?.sheetId;
    if (!Number.isInteger(sheetId)) {
      return res.status(500).json({ ok: false, message: "No se pudo resolver la hoja de prendas." });
    }

    const targetRowNumber = rowIndex + 2;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: targetRowNumber - 1,
                endIndex: targetRowNumber
              }
            }
          }
        ]
      }
    });

    return res.status(200).json({ ok: true, codigo, deleted: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudo eliminar el registro.",
      error: error?.message || "Unknown error"
    });
  }
}
