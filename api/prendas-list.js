import { google } from "googleapis";

export default async function handler(req, res) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "prendas_admin_activas!A1:R3000",
    });

    const rows = response.data.values || [];
    if (!rows.length) {
      return res.status(200).json([]);
    }

    const headers = rows[0];
    const data = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] ?? "";
      });
      return obj;
    });

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
    });
  }
}
