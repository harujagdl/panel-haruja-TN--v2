import { google } from "googleapis";

const TARGET_SHEET = "prendas_admin_activas";
const ADMIN_COLUMNS = [
  "Orden",
  "Código",
  "Descripción",
  "Tipo",
  "Color",
  "Talla",
  "Proveedor",
  "TN",
  "Status",
  "Disponibilidad",
  "Existencia",
  "Fecha",
  "Precio",
  "Costo",
  "Margen",
  "Utilidad",
  "InventorySource",
  "LastInventorySyncAt"
];

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

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getNextOrden = async (sheets) => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${TARGET_SHEET}!A2:A`
  });
  const rows = response?.data?.values || [];
  const maxOrden = rows.reduce((acc, row) => {
    const next = asNumber(row?.[0], 0);
    return next > acc ? next : acc;
  }, 0);
  return maxOrden + 1;
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const payload = req.body || {};
    const sheets = createSheetsClient();
    const orden = asNumber(payload.orden, 0) > 0 ? asNumber(payload.orden, 0) : await getNextOrden(sheets);
    const codigo = String(payload.codigo || "").trim();

    if (!codigo) {
      return res.status(400).json({ ok: false, message: "El campo 'codigo' es obligatorio." });
    }

    const row = [
      orden,
      codigo,
      String(payload.descripcion || "").trim(),
      String(payload.tipo || "").trim(),
      String(payload.color || "").trim(),
      String(payload.talla || "").trim(),
      String(payload.proveedor || "").trim(),
      String(payload.tn || "N/A").trim(),
      String(payload.status || "No definido").trim(),
      String(payload.disponibilidad || "No definido").trim(),
      asNumber(payload.existencia, 0),
      String(payload.fecha || "").trim(),
      String(payload.precio ?? "").trim(),
      String(payload.costo ?? "").trim(),
      String(payload.margen ?? "").trim(),
      String(payload.utilidad ?? "").trim(),
      String(payload.inventorySource || "manual").trim(),
      String(payload.lastInventorySyncAt ?? "").trim()
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: `${TARGET_SHEET}!A:R`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        majorDimension: "ROWS",
        values: [row]
      }
    });

    return res.status(200).json({ ok: true, codigo, orden, columns: ADMIN_COLUMNS });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "No se pudo guardar la prenda en Google Sheets.",
      error: error?.message || "Unknown error"
    });
  }
}
