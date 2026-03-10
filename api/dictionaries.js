import { google } from "googleapis";

const DICTIONARY_SHEETS = {
  tipos: "diccionario_tipos",
  proveedores: "diccionario_proveedores",
  colores: "diccionario_colores",
  tallas: "diccionario_tallas"
};

const toDictionaryEntries = (rows = []) => {
  return rows
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
};

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

const loadDictionarySheet = async (sheets, sheetName) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${sheetName}!A2:C`
  });
  return toDictionaryEntries(response?.data?.values || []);
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const sheets = createSheetsClient();
    const [tipos, proveedores, colores, tallas] = await Promise.all([
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.tipos),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.proveedores),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.colores),
      loadDictionarySheet(sheets, DICTIONARY_SHEETS.tallas)
    ]);

    return res.status(200).json({ tipos, proveedores, colores, tallas });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudieron cargar los diccionarios desde Google Sheets.",
      error: error?.message || "Unknown error"
    });
  }
}
