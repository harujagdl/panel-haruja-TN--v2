import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import QRCode from "qrcode";
import {
  createSheetsClient,
  getSpreadsheetId,
  readSheetRows,
  roundMoney,
} from "../../lib/apartados/sheets.js";

const CURRENCY_FORMATTER = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

const TICKET_FOOTER_TEXT = `Gracias por tu compra en HarujaGdl

Todos nuestros productos pasan por inspección para garantizar calidad, talla solicitada y que estén libres de defectos.

CAMBIOS
Solicítalo dentro de 7 días naturales de recibir tu compra.

La prenda debe estar nueva, sin uso, sin lavar y con etiquetas originales.

No aplican cambios en: prendas tejidas, bordadas, con aplicaciones, accesorios, prendas de ropa íntima, trajes de baño,
rebajas o compras con cupón.

Los gastos de envío corren por cuenta del cliente.

Solicita tu cambio por WhatsApp al 33 3033 6506 indicando motivo, prenda y talla deseada.

APARTADOS
Puedes apartar con 25% de anticipo.
Plazo máximo para recoger: 30 días.

Pasado ese tiempo, la prenda vuelve a venta y el anticipo queda como saldo a favor por 3 meses a partir de la fecha inicial
del apartado.

No aplican cambios ni devoluciones en apartados.

No realizamos devoluciones de dinero. Todos los cambios son por producto de igual o mayor valor.

Gracias por elegirnos 💛`;

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtCurrency(value) {
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

function buildTicketFooterHtml() {
  const blocks = TICKET_FOOTER_TEXT.split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const content = escHtml(block).replace(/\n/g, "<br>");
      if (block === "CAMBIOS" || block === "APARTADOS") {
        return `<p class="legal-heading"><strong>${content}</strong></p>`;
      }
      return `<p>${content}</p>`;
    })
    .join("");
}

async function fileToBase64DataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : "application/octet-stream";

  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function getLogoSrc() {
  const candidates = [
    path.join(process.cwd(), "public", "assets", "haruja-logo.png"),
    path.join(process.cwd(), "app", "assets", "haruja-logo.png"),
    path.join(process.cwd(), "assets", "haruja-logo.png"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return await fileToBase64DataUrl(candidate);
    } catch {
      // sigue
    }
  }

  const appUrl = String(process.env.APP_URL || "https://paneltb.harujagdl.com").replace(/\/$/, "");
  return `${appUrl}/assets/haruja-logo.png`;
}

function mapItem(item) {
  const precio = Number(item.Precio ?? item.precio ?? 0) || 0;
  const cantidad = Number(item.Cantidad ?? item.cantidad ?? 1) || 1;

  return {
    codigo: String(item.Codigo ?? item.codigo ?? "").trim(),
    descripcion: String(item.Descripcion ?? item.descripcion ?? "Prenda").trim(),
    precio,
    cantidad,
    subtotal: roundMoney(precio * cantidad),
  };
}

async function readTicketDataByFolio(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();

  const [apartadosRows, itemsRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
  ]);

  const key = String(folio || "").trim().toUpperCase();
  const apartado = apartadosRows.find(
    (row) => String(row.Folio || row.folio || "").trim().toUpperCase() === key
  );

  if (!apartado) {
    throw new Error(`No se encontró el folio ${key}.`);
  }

  const items = itemsRows
    .filter(
      (item) => String(item.Folio || item.folio || "").trim().toUpperCase() === key
    )
    .map(mapItem);

  return {
    folio: String(apartado.Folio ?? apartado.folio ?? "").trim(),
    fecha: normalizeDateValue(apartado.Fecha ?? apartado.fecha),
    cliente: String(apartado.Cliente ?? apartado.cliente ?? "").trim(),
    contacto: String(apartado.Contacto ?? apartado.contacto ?? "").trim(),
    items,
    subtotal: roundMoney(apartado.Subtotal ?? apartado.subtotal ?? 0),
    anticipo: roundMoney(apartado.Anticipo ?? apartado.anticipo ?? 0),
    descuento: roundMoney(apartado.DescuentoMXN ?? apartado.descuento ?? 0),
    total: roundMoney(apartado.Total ?? apartado.total ?? 0),
  };
}

function renderTicketHtml({
  folio,
  fecha,
  cliente,
  contacto,
  items,
  subtotal,
  anticipo,
  descuento,
  total,
  logoSrc,
  qrSrc,
}) {
  const rowsHtml = (items || [])
    .map(
      (item) => `
        <tr>
          <td class="code">${escHtml(item.codigo)}</td>
          <td class="desc">${escHtml(item.descripcion)}</td>
          <td class="qty">${Number(item.cantidad) || 1}</td>
          <td class="price">${fmtCurrency(item.precio)}</td>
          <td class="amount">${fmtCurrency(item.subtotal)}</td>
        </tr>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Ticket ${escHtml(folio)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #111111;
      background: #ffffff;
    }

    body {
      padding: 26px 26px 18px;
    }

    .ticket {
      width: 100%;
    }

    .logo-wrap {
      text-align: center;
      margin-bottom: 8px;
    }

    .logo {
      width: 290px;
      max-width: 100%;
      height: auto;
      object-fit: contain;
      display: inline-block;
    }

    .top-line {
      border: 0;
      border-top: 5px solid #000;
      margin: 10px 0 22px;
    }

    .top-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 12px;
      margin-bottom: 14px;
    }

    .ticket-title {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: .2px;
      margin: 0 0 6px;
      text-transform: uppercase;
    }

    .folio {
      font-size: 18px;
      font-weight: 800;
      white-space: nowrap;
      margin-top: 2px;
    }

    .meta {
      display: grid;
      grid-template-columns: 84px 1fr;
      row-gap: 3px;
      column-gap: 10px;
      margin-bottom: 16px;
      font-size: 13px;
    }

    .meta .label,
    .final-info .label {
      font-weight: 700;
    }

    .section-title {
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
      margin: 14px 0 8px;
    }

    table.items {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-bottom: 8px;
      border-top: 1px solid #d8d8d8;
    }

    table.items thead th {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      text-align: left;
      padding: 7px 8px;
      border-bottom: 1px solid #d8d8d8;
    }

    table.items tbody td {
      font-size: 12px;
      padding: 8px 8px;
      border-bottom: 1px solid #e6e6e6;
      vertical-align: top;
    }

    table.items .code   { width: 18%; font-weight: 700; }
    table.items .desc   { width: 46%; }
    table.items .qty    { width: 9%; text-align: center; }
    table.items .price  { width: 13%; text-align: right; }
    table.items .amount { width: 14%; text-align: right; }

    .totals {
      width: 260px;
      margin-left: auto;
      margin-top: 6px;
      border-collapse: collapse;
    }

    .totals td {
      font-size: 12px;
      padding: 2px 0;
    }

    .totals .label {
      text-align: left;
      font-weight: 700;
      padding-right: 12px;
    }

    .totals .value {
      text-align: right;
      width: 110px;
    }

    .totals .grand {
      border-top: 1px solid #d8d8d8;
    }

    .totals .grand td {
      padding-top: 8px;
      font-size: 14px;
      font-weight: 800;
    }

    .notes {
      margin-top: 18px;
      font-size: 12px;
      font-weight: 700;
    }

    .legal {
      margin-top: 8px;
      font-size: 11px;
      line-height: 1.32;
    }

    .legal p {
      margin: 0 0 8px;
    }

    .legal .legal-heading {
      margin-top: 10px;
      margin-bottom: 4px;
      font-size: 12px;
    }

    .bottom {
      margin-top: 14px;
      display: grid;
      grid-template-columns: 1fr 135px;
      gap: 14px;
      align-items: end;
    }

    .final-info {
      display: grid;
      grid-template-columns: 84px 1fr;
      column-gap: 10px;
      row-gap: 3px;
      font-size: 13px;
      align-self: start;
    }

    .qr-wrap {
      text-align: center;
      align-self: end;
    }

    .qr {
      width: 115px;
      height: 115px;
      object-fit: contain;
      display: block;
      margin: 0 auto 5px;
    }

    .qr-caption {
      font-size: 10px;
      color: #111;
    }
  </style>
</head>
<body>
  <div class="ticket">
    <div class="logo-wrap">
      <img class="logo" src="${escHtml(logoSrc)}" alt="HarujaGdl" />
    </div>
    <hr class="top-line" />

    <div class="top-row">
      <div>
        <div class="ticket-title">Ticket de apartado</div>
      </div>
      <div class="folio">#${escHtml(folio)}</div>
    </div>

    <div class="meta">
      <div class="label">Fecha:</div><div>${escHtml(fecha)}</div>
      <div class="label">Cliente:</div><div>${escHtml(cliente || "-")}</div>
      <div class="label">Contacto:</div><div>${escHtml(contacto || "-")}</div>
    </div>

    <div class="section-title">Detalle</div>

    <table class="items">
      <thead>
        <tr>
          <th class="code">Código</th>
          <th class="desc">Descripción</th>
          <th class="qty">Cant</th>
          <th class="price">P.U.</th>
          <th class="amount">Importe</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <table class="totals">
      <tr>
        <td class="label">Subtotal:</td>
        <td class="value">${fmtCurrency(subtotal)}</td>
      </tr>
      <tr>
        <td class="label">Anticipo:</td>
        <td class="value">${fmtCurrency(anticipo)}</td>
      </tr>
      <tr>
        <td class="label">Descuento:</td>
        <td class="value">${fmtCurrency(descuento)}</td>
      </tr>
      <tr class="grand">
        <td class="label">TOTAL</td>
        <td class="value">${fmtCurrency(total)}</td>
      </tr>
    </table>

    <div class="notes">Gracias por tu compra en HarujaGdl</div>
    <section class="legal">
      ${buildTicketFooterHtml()}
    </section>

    <div class="bottom">
      <div class="final-info">
        <div class="label">Pedido:</div><div>${escHtml(folio)}</div>
        <div class="label">Fecha:</div><div>${escHtml(fecha)}</div>
        <div class="label">Cliente:</div><div>${escHtml(cliente || "-")}</div>
        <div class="label">Contacto:</div><div>${escHtml(contacto || "-")}</div>
      </div>

      <div class="qr-wrap">
        <img class="qr" src="${escHtml(qrSrc)}" alt="QR apartado" />
        <div class="qr-caption">Escanea para ver tu apartado</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function generatePdfFromHtml(html) {
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 900, height: 1400, deviceScaleFactor: 1.5 },
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "16px",
        right: "16px",
        bottom: "16px",
        left: "16px",
      },
    });
  } finally {
    await browser.close();
  }
}

async function buildPdfBuffer(ticketData) {
  const appUrl = String(process.env.APP_URL || "https://paneltb.harujagdl.com").replace(/\/$/, "");
  const folio = String(ticketData.folio || "").trim();
  const qrTarget = `${appUrl}/apartado/${encodeURIComponent(folio)}`;

  const [logoSrc, qrSrc] = await Promise.all([
    getLogoSrc(),
    QRCode.toDataURL(qrTarget, {
      errorCorrectionLevel: "M",
      margin: 0,
      width: 180,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    }),
  ]);

  const html = renderTicketHtml({
    ...ticketData,
    logoSrc,
    qrSrc,
  });

  return await generatePdfFromHtml(html);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const folio = String(req.query.folio || "").trim();
    if (!folio) {
      return res.status(400).json({ ok: false, message: "Folio requerido." });
    }

    const ticketData = await readTicketDataByFolio(folio);
    const pdfBuffer = await buildPdfBuffer(ticketData);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ticket-${encodeURIComponent(ticketData.folio)}.pdf"`);

    return res.status(200).send(Buffer.from(pdfBuffer));
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error?.message || "No se pudo generar el PDF.",
    });
  }
}
