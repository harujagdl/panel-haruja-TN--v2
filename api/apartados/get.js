import { createSheetsClient, getSpreadsheetId, readSheetRows, roundMoney } from "./_sheets.js";

function normalizeStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "ACTIVO";
  return status;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const folio = String(req.query.folio || "").trim().toUpperCase();
    if (!folio) {
      throw new Error("Debes indicar un folio.");
    }

    const sheets = createSheetsClient();
    const spreadsheetId = getSpreadsheetId();

    const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
      readSheetRows(sheets, spreadsheetId, "apartados"),
      readSheetRows(sheets, spreadsheetId, "apartados_items"),
      readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
    ]);

    const apartado = apartadosRows.find(
      (row) => String(row.Folio || "").trim().toUpperCase() === folio
    );

    if (!apartado) {
      throw new Error("No se encontró el folio solicitado.");
    }

    const items = itemsRows
      .filter((item) => String(item.Folio || "").trim().toUpperCase() === folio)
      .map((item) => ({
        codigo: String(item.Codigo || "").trim(),
        descripcion: String(item.Descripcion || "").trim(),
        precio: roundMoney(item.Precio),
      }));

    const abonos = abonosRows
      .filter((row) => String(row.Folio || "").trim().toUpperCase() === folio)
      .map((row) => ({
        fecha: String(row.Fecha || "").trim(),
        monto: roundMoney(row.Monto),
        metodo: String(row.Metodo || "").trim(),
        comentario: String(row.Comentario || "").trim(),
      }));

    const appUrl = process.env.APP_URL || `http://${req.headers.host}`;
    const publicUrl = `${appUrl}/apartado/${encodeURIComponent(folio)}`;

    return res.status(200).json({
      ok: true,
      item: {
        folio,
        fecha: String(apartado.Fecha || "").trim(),
        cliente: String(apartado.Cliente || "").trim(),
        contacto: String(apartado.Contacto || "").trim(),
        subtotal: roundMoney(apartado.Subtotal),
        anticipo: roundMoney(apartado.Anticipo),
        descuento: roundMoney(apartado.DescuentoMXN),
        total: roundMoney(apartado.Total),
        saldoPendiente: roundMoney(apartado.Saldo),
        status: normalizeStatus(apartado.Estado),
        fechaLimite: String(apartado.FechaLimite || "").trim(),
        paymentUrl: String(apartado.PaymentUrl || "").trim(),
        qrUrl: String(apartado.QrUrl || "").trim() || publicUrl,
        publicUrl,
        pdfUrl: String(apartado.PdfUrl || "").trim() || `${appUrl}/api/apartados/pdf?folio=${encodeURIComponent(folio)}`,
        items,
        abonos,
      },
    });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "No se pudo consultar el apartado." });
  }
}
