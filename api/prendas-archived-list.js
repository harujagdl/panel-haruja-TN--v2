import { google } from "googleapis";

const ARCHIVE_SHEET = "prendas_admin_archivo";

const createSheetsClient = () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });

  return google.sheets({ version: "v4", auth });
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const sheets = createSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${ARCHIVE_SHEET}!A:ZZ`
    });

    const values = response?.data?.values || [];
    if (!values.length) {
      return res.status(200).json({ ok: true, rows: [] });
    }

    const headers = (values[0] || []).map((header) => String(header || "").trim());
    const rows = values.slice(1).map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        if (!header) return;
        obj[header] = String(row?.[index] || "").trim();
      });
      return obj;
    });

    return res.status(200).json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudo cargar el histórico archivado."
    });
  }
}
