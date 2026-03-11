import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createSheetsClient, getSpreadsheetId, readSheetRows, roundMoney } from "../../lib/apartados/sheets.js";

function drawLabelValue(page, { x, y, label, value, font, bold, size = 10 }) {
  page.drawText(`${label}:`, { x, y, size, font: bold, color: rgb(0.2, 0.2, 0.2) });
  page.drawText(String(value || "-"), { x: x + 72, y, size, font, color: rgb(0.1, 0.1, 0.1) });
}

async function buildPdfBuffer({ folio, fecha, cliente, contacto, items, subtotal, anticipo, descuento, total }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([420, 600]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 560;

  page.drawText("HARUJA", { x: 40, y, size: 19, font: bold });
  page.drawText(`Ticket ${folio}`, { x: 235, y, size: 16, font: bold });

  y -= 26;
  page.drawLine({ start: { x: 40, y }, end: { x: 380, y }, thickness: 1, color: rgb(0.85, 0.85, 0.85) });

  y -= 24;
  drawLabelValue(page, { x: 40, y, label: "Fecha", value: fecha, font, bold });
  y -= 16;
  drawLabelValue(page, { x: 40, y, label: "Cliente", value: cliente, font, bold });
  y -= 16;
  drawLabelValue(page, { x: 40, y, label: "Contacto", value: contacto, font, bold });

  y -= 24;
  page.drawText("DETALLES DEL PEDIDO", { x: 40, y, size: 11, font: bold });

  y -= 14;
  page.drawLine({ start: { x: 40, y }, end: { x: 380, y }, thickness: 0.8, color: rgb(0.85, 0.85, 0.85) });

  y -= 18;
  for (const item of items || []) {
    const codigo = String(item.codigo || item.Codigo || "");
    const descripcion = String(item.descripcion || item.Descripcion || "Prenda");
    const precio = roundMoney(item.precio ?? item.Precio ?? 0);

    page.drawText(codigo, { x: 40, y, size: 9, font: bold });
    page.drawText(descripcion.slice(0, 33), { x: 110, y, size: 9, font });
    page.drawText(`$${precio.toFixed(2)}`, { x: 320, y, size: 9, font });
    y -= 14;

    if (y < 130) break;
  }

  y -= 12;
  page.drawLine({ start: { x: 40, y }, end: { x: 380, y }, thickness: 0.8, color: rgb(0.85, 0.85, 0.85) });

  y -= 18;
  drawLabelValue(page, { x: 40, y, label: "Subtotal", value: `$${roundMoney(subtotal).toFixed(2)}`, font, bold });
  y -= 15;
  drawLabelValue(page, { x: 40, y, label: "Anticipo", value: `$${roundMoney(anticipo).toFixed(2)}`, font, bold });
  y -= 15;
  drawLabelValue(page, { x: 40, y, label: "Descuento", value: `$${roundMoney(descuento).toFixed(2)}`, font, bold });
  y -= 18;

  page.drawText(`Total de cuenta: $${roundMoney(total).toFixed(2)}`, {
    x: 40,
    y,
    size: 12,
    font: bold,
  });

  y -= 34;
  page.drawText("Política de cambios:", { x: 40, y, size: 9.5, font: bold });
  y -= 13;
  page.drawText("Solo cambios por talla o defecto en los primeros 5 días.", { x: 40, y, size: 8.8, font });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

async function readTicketDataByFolio(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();

  const [apartadosRows, itemsRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
  ]);

  const apartado = apartadosRows.find(
    (row) => String(row.Folio || "").trim().toUpperCase() === String(folio || "").trim().toUpperCase()
  );

  if (!apartado) {
    throw new Error("No se encontró el folio solicitado.");
  }

  const items = itemsRows.filter(
    (item) => String(item.Folio || "").trim().toUpperCase() === String(folio || "").trim().toUpperCase()
  );

  return {
    folio: apartado.Folio,
    fecha: apartado.Fecha,
    cliente: apartado.Cliente,
    contacto: apartado.Contacto,
    items,
    subtotal: apartado.Subtotal,
    anticipo: apartado.Anticipo,
    descuento: apartado.DescuentoMXN,
    total: apartado.Total,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const pdfBuffer = await buildPdfBuffer(req.body || {});
      res.setHeader("Content-Type", "application/pdf");
      return res.status(200).send(pdfBuffer);
    }

    if (req.method === "GET") {
      const ticketData = await readTicketDataByFolio(req.query.folio);
      const pdfBuffer = await buildPdfBuffer(ticketData);
      res.setHeader("Content-Type", "application/pdf");
      return res.status(200).send(pdfBuffer);
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "No se pudo generar el PDF." });
  }
}
