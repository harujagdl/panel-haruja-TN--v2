import { google } from "googleapis";

export function getSpreadsheetId() {
  return String(process.env.SHEET_ID || "").trim();
}

export function createSheetsClient({ readOnly = false } = {}) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    },
    scopes: [
      readOnly
        ? "https://www.googleapis.com/auth/spreadsheets.readonly"
        : "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  return google.sheets({ version: "v4", auth });
}

export async function readSheetRowsRaw(sheets, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range
  });
  return response?.data?.values || [];
}

export async function getSheetHeadersRaw(sheets, sheetName) {
  const rows = await readSheetRowsRaw(sheets, `${sheetName}!A1:ZZ1`);
  return (rows[0] || []).map((header) => String(header || "").trim());
}

export async function appendSheetRowRaw(sheets, sheetName, values) {
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
