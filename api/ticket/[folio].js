import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createSheetsClient, getSpreadsheetId, readSheetRows, roundMoney } from "../../lib/apartados/sheets.js";

const PAGE_WIDTH = 420;
const PAGE_HEIGHT = 842;
const MARGIN_X = 28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const CURRENCY_FORMATTER = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TICKET_FOOTER_TEXT = [
  "Gracias por tu compra en HarujaGdl",
  "",
  "CAMBIOS",
  "• Tienes 5 dias naturales para cambios a partir de tu fecha de compra.",
  "• Es indispensable presentar ticket y que la prenda conserve etiqueta.",
  "• No hay cambios en prendas blancas, bodys, accesorios, rebajas o promociones.",
  "• Los cambios se realizan por talla, color o por otra prenda con diferencia a favor.",
  "",
  "APARTADOS",
  "• Vigencia maxima de 30 dias naturales desde la fecha del ticket.",
  "• Después de 30 dias sin liquidar, el apartado se cancela automaticamente.",
  "• El anticipo no es reembolsable ni transferible.",
  "• Si liquidas dentro de vigencia, respetamos precio y existencia apartada.",
];

function toMoney(value) {
  return `$${CURRENCY_FORMATTER.format(roundMoney(value || 0))}`;
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

function mapItem(item) {
  return {
    codigo: String(item.Codigo ?? item.codigo ?? "").trim(),
    descripcion: String(item.Descripcion ?? item.descripcion ?? "Prenda").trim(),
    precio: Number(item.Precio ?? item.precio ?? 0) || 0,
    cantidad: Number(item.Cantidad ?? item.cantidad ?? 1) || 1,
  };
}

function drawSeparator(page, y) {
  page.drawLine({
    start: { x: MARGIN_X, y },
    end: { x: PAGE_WIDTH - MARGIN_X, y },
    thickness: 0.8,
    color: rgb(0.86, 0.86, 0.86),
  });
}

function drawHeader(page, bold, folio) {
  page.drawText("HARUJA", { x: MARGIN_X, y: PAGE_HEIGHT - 42, size: 20, font: bold });
  page.drawText("TICKET DE APARTADO", { x: MARGIN_X, y: PAGE_HEIGHT - 58, size: 10.5, font: bold });
  page.drawText(`#${folio}`, { x: PAGE_WIDTH - 130, y: PAGE_HEIGHT - 44, size: 15, font: bold });
  drawSeparator(page, PAGE_HEIGHT - 68);
}

function drawMetaBlock(page, { font, bold, yStart, fecha, cliente, contacto }) {
  let y = yStart;
  const pairs = [
    ["Fecha", fecha],
    ["Cliente", cliente || "-"],
    ["Contacto", contacto || "-"],
  ];

  for (const [label, value] of pairs) {
    page.drawText(`${label}:`, { x: MARGIN_X, y, size: 9.6, font: bold });
    page.drawText(String(value || "-"), { x: MARGIN_X + 72, y, size: 9.6, font });
    y -= 13;
  }

  return y - 4;
}

function drawItemsTable(page, { font, bold, yStart, items }) {
  let y = yStart;
  const col = {
    code: MARGIN_X + 6,
    desc: MARGIN_X + 70,
    qty: MARGIN_X + 244,
    pu: MARGIN_X + 272,
    imp: MARGIN_X + 332,
  };

  page.drawText("DETALLE", { x: MARGIN_X, y, size: 10.5, font: bold });
  y -= 12;
  drawSeparator(page, y);
  y -= 10;

  page.drawText("CODIGO", { x: col.code, y, size: 8.5, font: bold });
  page.drawText("DESCRIPCION", { x: col.desc, y, size: 8.5, font: bold });
  page.drawText("CANT", { x: col.qty, y, size: 8.5, font: bold });
  page.drawText("P.U.", { x: col.pu, y, size: 8.5, font: bold });
  page.drawText("IMPORTE", { x: col.imp, y, size: 8.5, font: bold });
  y -= 9;
  drawSeparator(page, y);
  y -= 10;

  for (const item of items) {
    const importe = item.precio * item.cantidad;
    page.drawText(item.codigo.slice(0, 12), { x: col.code, y, size: 8.4, font: bold });
    page.drawText(item.descripcion.slice(0, 38), { x: col.desc, y, size: 8.4, font });
    page.drawText(String(item.cantidad), { x: col.qty + 4, y, size: 8.4, font });
    page.drawText(toMoney(item.precio), { x: col.pu, y, size: 8.4, font });
    page.drawText(toMoney(importe), { x: col.imp, y, size: 8.4, font });
    y -= 12;
  }

  drawSeparator(page, y + 3);
  return y - 8;
}

function drawTotals(page, { font, bold, yStart, subtotal, anticipo, descuento, total }) {
  const labelX = MARGIN_X + 200;
  const valueX = PAGE_WIDTH - MARGIN_X - 88;
  let y = yStart;

  const rows = [
    ["Subtotal", subtotal],
    ["Anticipo", anticipo],
    ["Descuento", descuento],
  ];

  for (const [label, value] of rows) {
    page.drawText(`${label}:`, { x: labelX, y, size: 9.4, font: bold });
    page.drawText(toMoney(value), { x: valueX, y, size: 9.4, font, color: rgb(0.07, 0.07, 0.07) });
    y -= 12;
  }

  drawSeparator(page, y + 4);
  y -= 10;
  page.drawText("TOTAL", { x: labelX, y, size: 11.2, font: bold });
  page.drawText(toMoney(total), { x: valueX, y, size: 11.2, font: bold });

  return y - 14;
}

function drawFooterPolicies(page, { font, bold, yStart }) {
  let y = yStart;
  drawSeparator(page, y + 8);

  for (const line of TICKET_FOOTER_TEXT) {
    if (!line) {
      y -= 6;
      continue;
    }

    const isTitle = line === "CAMBIOS" || line === "APARTADOS" || line.startsWith("Gracias");
    page.drawText(line, {
      x: MARGIN_X,
      y,
      size: isTitle ? 8.6 : 7.8,
      font: isTitle ? bold : font,
    });
    y -= isTitle ? 10 : 9;
  }

  return y - 2;
}

function drawFinalBlock(page, { font, bold, yStart, folio, fecha, cliente, contacto }) {
  let y = yStart;
  drawSeparator(page, y + 10);
  y -= 2;

  const rows = [
    ["Pedido", folio],
    ["Fecha", fecha],
    ["Cliente", cliente || "-"],
    ["Contacto", contacto || "-"],
  ];

  for (const [label, value] of rows) {
    page.drawText(`${label}:`, { x: MARGIN_X, y, size: 9.4, font: bold });
    page.drawText(String(value), { x: MARGIN_X + 74, y, size: 9.4, font });
    y -= 12;
  }

  return y;
}

async function drawQr(page, pdfDoc, { folio, yTop }) {
  const appUrl = String(process.env.APP_URL || "").trim().replace(/\/$/, "");
  const baseUrl = appUrl || "https://paneltb.harujagdl.com";
  const qrTarget = `${baseUrl}/apartado/${encodeURIComponent(String(folio || "").trim())}`;
  const qrService = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&margin=0&data=${encodeURIComponent(qrTarget)}`;

  const response = await fetch(qrService);
  if (!response.ok) throw new Error("No se pudo generar el QR del apartado.");

  const bytes = await response.arrayBuffer();
  const qrImage = await pdfDoc.embedPng(bytes);
  const size = 84;
  const x = PAGE_WIDTH - MARGIN_X - size;
  const y = yTop - size + 8;

  page.drawImage(qrImage, { x, y, width: size, height: size });
  page.drawText("Escanea para ver tu apartado", {
    x: x - 10,
    y: y - 9,
    size: 6.7,
    font: await pdfDoc.embedFont(StandardFonts.Helvetica),
  });
}

async function buildPdfBuffer({ folio, fecha, cliente, contacto, items, subtotal, anticipo, descuento, total }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const safeFecha = normalizeDateValue(fecha);
  const mappedItems = (Array.isArray(items) ? items : []).map(mapItem);

  drawHeader(page, bold, folio);
  let y = PAGE_HEIGHT - 86;
  y = drawMetaBlock(page, { font, bold, yStart: y, fecha: safeFecha, cliente, contacto });
  y = drawItemsTable(page, { font, bold, yStart: y, items: mappedItems });
  y = drawTotals(page, { font, bold, yStart: y, subtotal, anticipo, descuento, total });
  y = drawFooterPolicies(page, { font, bold, yStart: y });
  y = drawFinalBlock(page, { font, bold, yStart: y, folio, fecha: safeFecha, cliente, contacto });

  await drawQr(page, pdfDoc, { folio, yTop: y + 58 });

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
  const apartado = apartadosRows.find((row) => String(row.Folio || row.folio || "").trim().toUpperCase() === key);
  if (!apartado) throw new Error("No se encontró el folio solicitado.");

  return {
    folio: apartado.Folio ?? apartado.folio,
    fecha: apartado.Fecha ?? apartado.fecha,
    cliente: apartado.Cliente ?? apartado.cliente,
    contacto: apartado.Contacto ?? apartado.contacto,
    items: itemsRows.filter((item) => String(item.Folio || item.folio || "").trim().toUpperCase() === key),
    subtotal: apartado.Subtotal ?? apartado.subtotal,
    anticipo: apartado.Anticipo ?? apartado.anticipo,
    descuento: apartado.DescuentoMXN ?? apartado.descuento ?? 0,
    total: apartado.Total ?? apartado.total,
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
