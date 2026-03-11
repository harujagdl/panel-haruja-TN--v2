import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createSheetsClient, getSpreadsheetId, readSheetRows, roundMoney } from "../../lib/apartados/sheets.js";

const PAGE_WIDTH = 420;
const PAGE_HEIGHT = 760;
const MARGIN_X = 28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const CURRENCY_FORMATTER = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

function toMoney(value) {
  return `$${CURRENCY_FORMATTER.format(roundMoney(value))}`;
}

function normalizeDateValue(value) {
  if (value === null || value === undefined) return "-";
  const raw = String(value).trim();
  if (!raw) return "-";

  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial)) {
      const utcMs = EXCEL_EPOCH_UTC_MS + Math.round(serial) * 86400000;
      return new Date(utcMs).toISOString().slice(0, 10);
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return raw;
}

function drawHeader(page, bold, folio) {
  page.drawText("HARUJA", { x: MARGIN_X, y: PAGE_HEIGHT - 36, size: 19, font: bold });
  page.drawText(`Ticket ${folio}`, { x: PAGE_WIDTH - 178, y: PAGE_HEIGHT - 34, size: 14, font: bold });
  page.drawLine({
    start: { x: MARGIN_X, y: PAGE_HEIGHT - 46 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - 46 },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  });
}

function drawLabelValue(page, { y, label, value, font, bold, labelWidth = 68 }) {
  page.drawText(`${label}:`, { x: MARGIN_X, y, size: 9.5, font: bold, color: rgb(0.2, 0.2, 0.2) });
  page.drawText(String(value || "-"), {
    x: MARGIN_X + labelWidth,
    y,
    size: 9.5,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
}

function drawItemsTable(page, { yStart, items, font, bold }) {
  const tableX = MARGIN_X;
  const tableYTop = yStart;
  const rowHeight = 14;
  const colCodeX = tableX + 8;
  const colDescX = tableX + 78;
  const colPriceX = tableX + 278;
  const colImpX = tableX + 340;

  page.drawText("DETALLE", { x: tableX, y: tableYTop + 6, size: 10.5, font: bold });

  const headerY = tableYTop - 14;
  page.drawLine({
    start: { x: tableX, y: headerY + 16 },
    end: { x: tableX + CONTENT_WIDTH, y: headerY + 16 },
    thickness: 0.8,
    color: rgb(0.85, 0.85, 0.85),
  });
  page.drawText("CODIGO", { x: colCodeX, y: headerY, size: 8.5, font: bold });
  page.drawText("DESCRIPCION", { x: colDescX, y: headerY, size: 8.5, font: bold });
  page.drawText("P.U.", { x: colPriceX, y: headerY, size: 8.5, font: bold });
  page.drawText("IMP", { x: colImpX, y: headerY, size: 8.5, font: bold });

  let y = headerY - 12;
  const normalizedItems = Array.isArray(items) ? items : [];
  for (const item of normalizedItems) {
    page.drawText(String(item.Codigo || ""), { x: colCodeX, y, size: 8.5, font: bold });
    page.drawText(String(item.Descripcion || "Prenda").slice(0, 40), { x: colDescX, y, size: 8.5, font });
    const precio = toMoney(item.Precio);
    page.drawText(precio, { x: colPriceX, y, size: 8.5, font });
    page.drawText(precio, { x: colImpX, y, size: 8.5, font });
    y -= rowHeight;
  }

  page.drawLine({
    start: { x: tableX, y: y + 4 },
    end: { x: tableX + CONTENT_WIDTH, y: y + 4 },
    thickness: 0.8,
    color: rgb(0.85, 0.85, 0.85),
  });

  return y - 10;
}

function drawTotals(page, { yStart, font, bold, subtotal, anticipo, descuento, total }) {
  let y = yStart;
  drawLabelValue(page, { y, label: "Subtotal", value: toMoney(subtotal), font, bold, labelWidth: 80 });
  y -= 13;
  drawLabelValue(page, { y, label: "Anticipo", value: toMoney(anticipo), font, bold, labelWidth: 80 });
  y -= 13;
  drawLabelValue(page, { y, label: "Descuento", value: toMoney(descuento), font, bold, labelWidth: 80 });
  y -= 15;
  page.drawText(`Total: ${toMoney(total)}`, { x: MARGIN_X, y, size: 11.5, font: bold });
  return y - 14;
}

function drawPolicies(page, { yStart, font, bold }) {
  const lines = [
    "POLITICAS DE APARTADO:",
    "1) Vigencia maxima de 30 dias naturales desde la fecha del ticket.",
    "2) Despues de 30 dias sin liquidar, el apartado se cancela automaticamente.",
    "3) El anticipo no es reembolsable; aplica solo para cambios segun politicas vigentes.",
    "4) Cambios por talla o defecto dentro de los primeros 5 dias con ticket.",
  ];

  let y = yStart;
  page.drawLine({
    start: { x: MARGIN_X, y: y + 8 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: y + 8 },
    thickness: 0.8,
    color: rgb(0.85, 0.85, 0.85),
  });

  for (let index = 0; index < lines.length; index += 1) {
    page.drawText(lines[index], {
      x: MARGIN_X,
      y,
      size: index === 0 ? 8.8 : 8.2,
      font: index === 0 ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= index === 0 ? 11 : 10;
  }

  return y - 2;
}

function drawFinalBlock(page, { yStart, font, bold, folio, fecha, cliente, contacto }) {
  let y = yStart;
  page.drawLine({
    start: { x: MARGIN_X, y: y + 8 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: y + 8 },
    thickness: 0.8,
    color: rgb(0.85, 0.85, 0.85),
  });

  drawLabelValue(page, { y, label: "Pedido", value: folio, font, bold, labelWidth: 72 });
  y -= 12;
  drawLabelValue(page, { y, label: "Fecha", value: fecha, font, bold, labelWidth: 72 });
  y -= 12;
  drawLabelValue(page, { y, label: "Cliente", value: cliente, font, bold, labelWidth: 72 });
  y -= 12;
  drawLabelValue(page, { y, label: "Contacto", value: contacto, font, bold, labelWidth: 72 });

  return y - 2;
}

async function drawQr(page, pdfDoc, { folio, yStart }) {
  const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");
  const fallbackHost = "https://paneltb.harujagdl.com";
  const baseUrl = appUrl || fallbackHost;
  const qrTarget = `${baseUrl}/apartado/${encodeURIComponent(String(folio || "").trim())}`;
  const qrService = `https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(qrTarget)}`;

  const response = await fetch(qrService);
  if (!response.ok) throw new Error("No se pudo generar el QR del apartado.");
  const bytes = await response.arrayBuffer();
  const image = await pdfDoc.embedPng(bytes);
  const qrSize = 82;
  const qrX = PAGE_WIDTH - MARGIN_X - qrSize;

  page.drawImage(image, { x: qrX, y: yStart - qrSize + 4, width: qrSize, height: qrSize });
  page.drawText("Escanea para ver tu apartado", {
    x: qrX - 14,
    y: yStart - qrSize - 7,
    size: 6.7,
    font: await pdfDoc.embedFont(StandardFonts.Helvetica),
  });
}

async function buildPdfBuffer({ folio, fecha, cliente, contacto, items, subtotal, anticipo, descuento, total }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  drawHeader(page, bold, folio);

  let y = PAGE_HEIGHT - 70;
  drawLabelValue(page, { y, label: "Fecha", value: normalizeDateValue(fecha), font, bold });
  y -= 12;
  drawLabelValue(page, { y, label: "Cliente", value: cliente, font, bold });
  y -= 12;
  drawLabelValue(page, { y, label: "Contacto", value: contacto, font, bold });

  y = drawItemsTable(page, { yStart: y - 16, items, font, bold });
  y = drawTotals(page, { yStart: y, font, bold, subtotal, anticipo, descuento, total });
  y = drawPolicies(page, { yStart: y, font, bold });
  const finalBlockTop = drawFinalBlock(page, {
    yStart: y,
    font,
    bold,
    folio,
    fecha: normalizeDateValue(fecha),
    cliente,
    contacto,
  });

  await drawQr(page, pdfDoc, { folio, yStart: finalBlockTop + 38 });

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

  const key = String(folio || "").trim().toUpperCase();
  const apartado = apartadosRows.find((row) => String(row.Folio || "").trim().toUpperCase() === key);
  if (!apartado) throw new Error("No se encontró el folio solicitado.");

  return {
    folio: apartado.Folio,
    fecha: apartado.Fecha,
    cliente: apartado.Cliente,
    contacto: apartado.Contacto,
    items: itemsRows.filter((item) => String(item.Folio || "").trim().toUpperCase() === key),
    subtotal: apartado.Subtotal,
    anticipo: apartado.Anticipo,
    descuento: apartado.DescuentoMXN,
    total: apartado.Total,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed" });

  try {
    const ticketData = await readTicketDataByFolio(req.query.folio);
    const pdfBuffer = await buildPdfBuffer(ticketData);
    res.setHeader("Content-Type", "application/pdf");
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "No se pudo generar el PDF." });
  }
}
