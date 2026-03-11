import { createSheetsClient, ensureSheetsSetup, getSpreadsheetId, readSheetRows } from "./_sheets.js";

function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTimestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapApartado(row) {
  return {
    folio: String(row.Folio || "").trim(),
    fecha: String(row.Fecha || "").trim(),
    cliente: String(row.Cliente || "").trim(),
    contacto: String(row.Contacto || "").trim(),
    total: toNumber(row.Total),
    anticipo: toNumber(row.Anticipo),
    saldo: toNumber(row.Saldo),
    estado: String(row.Estado || "").trim(),
    pdfUrl: String(row.PdfUrl || "").trim(),
    ultimoMovimiento: String(row.UltimoMovimiento || "").trim(),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const spreadsheetId = getSpreadsheetId();
    const sheets = createSheetsClient();

    await ensureSheetsSetup(sheets, spreadsheetId);

    const rows = await readSheetRows(sheets, spreadsheetId, "apartados");
    const apartados = rows
      .map(mapApartado)
      .sort((a, b) => {
        const aTs = toTimestamp(a.ultimoMovimiento) || toTimestamp(a.fecha);
        const bTs = toTimestamp(b.ultimoMovimiento) || toTimestamp(b.fecha);
        return bTs - aTs;
      });

    return res.status(200).json({ ok: true, apartados });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || "No se pudo obtener el historial." });
  }
}
