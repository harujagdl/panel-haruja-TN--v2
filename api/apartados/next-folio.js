import { createSheetsClient, ensureSheetsSetup, getSpreadsheetId, readSheetRows } from "./_sheets.js";

function buildNextFolio(folios) {
  const year2 = String(new Date().getFullYear()).slice(-2);
  const pattern = new RegExp(`^HARUJA${year2}-(\\d{3})$`);
  const maxConsecutive = folios.reduce((acc, folio) => {
    const match = String(folio || "").trim().match(pattern);
    if (!match) {
      return acc;
    }
    const current = Number(match[1]);
    return Number.isFinite(current) && current > acc ? current : acc;
  }, 0);

  return `HARUJA${year2}-${String(maxConsecutive + 1).padStart(3, "0")}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const spreadsheetId = getSpreadsheetId();
    const sheets = createSheetsClient();

    await ensureSheetsSetup(sheets, spreadsheetId);

    const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
    const folios = apartadosRows.map((row) => row.Folio);
    const folio = buildNextFolio(folios);

    return res.status(200).json({ ok: true, folio });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || "No se pudo generar folio." });
  }
}
