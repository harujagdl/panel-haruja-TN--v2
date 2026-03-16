/**
 * Web App para generar y persistir el PDF oficial de apartados.
 *
 * Deploy:
 * - Ejecutar como: propietario del script.
 * - Acceso: usuarios autorizados o "Cualquiera con el vínculo" según operación.
 */
const APARTADOS_SHEET_NAME = 'apartados';
const APARTADOS_ITEMS_SHEET_NAME = 'apartados_items';
const DRIVE_FOLDER_ID = '1y3l0r-4XnSsicnuSeVaATSh3rC89j-If';

function doPost(e) {
  try {
    const payload = parseRequestBody_(e);
    if (payload.action !== 'generar_pdf_apartado') {
      return jsonResponse_({ ok: false, message: 'Operación inválida' });
    }

    const folio = normalize_(payload.folio);
    if (!folio) return jsonResponse_({ ok: false, message: 'Folio inválido' });

    const apartadoData = getApartadoByFolio_(folio);
    if (!apartadoData) {
      return jsonResponse_({ ok: false, message: 'Apartado no encontrado' });
    }

    const pdfFile = generateAndStorePdf_(folio, apartadoData);
    const pdfUrl = `https://drive.google.com/file/d/${pdfFile.getId()}/view`;

    updateApartadoPdfMetadata_(apartadoData.rowIndex, {
      pdfFileId: pdfFile.getId(),
      pdfUrl,
      pdfUpdatedAt: new Date().toISOString(),
      hasOfficialPdf: true,
    });

    return jsonResponse_({
      ok: true,
      folio,
      fileId: pdfFile.getId(),
      folderId: DRIVE_FOLDER_ID,
      pdfUrl,
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      message: 'No se pudo generar el PDF',
      details: error && error.message ? error.message : String(error),
    });
  }
}

function parseRequestBody_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  return JSON.parse(raw);
}

function normalize_(value) {
  return String(value || '').trim().toUpperCase();
}

function getApartadoByFolio_(folio) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const apartadosSheet = ss.getSheetByName(APARTADOS_SHEET_NAME);
  const itemsSheet = ss.getSheetByName(APARTADOS_ITEMS_SHEET_NAME);
  if (!apartadosSheet || !itemsSheet) throw new Error('No se encontraron hojas de apartados.');

  const apartados = readRows_(apartadosSheet);
  const items = readRows_(itemsSheet);

  const match = apartados.find((row) => normalize_(row.Folio) === folio);
  if (!match) return null;

  return {
    rowIndex: match.__rowIndex,
    folio,
    fecha: match.Fecha || match.fecha || '',
    cliente: match.Cliente || match.cliente || '',
    contacto: match.Contacto || match.contacto || match.Telefono || match.telefono || '',
    subtotal: toMoney_(match.Subtotal || match.subtotal),
    descuento: toMoney_(match.DescuentoMXN || match.descuento || match.Descuento || 0),
    anticipo: toMoney_(match.Anticipo || match.anticipo),
    total: toMoney_(match.Total || match.total),
    saldo: toMoney_(match.Saldo || match.saldoPendiente || match.saldo),
    estatus: String(match.Estado || match.status || match.estatus || 'ACTIVO').toUpperCase(),
    items: items
      .filter((item) => normalize_(item.Folio) === folio)
      .map((item) => ({
        codigo: item.Codigo || item.codigo || '',
        descripcion: item.Descripcion || item.descripcion || 'Prenda',
        cantidad: Number(item.Cantidad || item.cantidad || 1),
        precio: toMoney_(item.Precio || item.precio),
      })),
  };
}

function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map((h) => String(h || '').trim());
  return values.slice(1).map((row, index) => {
    const obj = { __rowIndex: index + 2 };
    headers.forEach((header, col) => {
      obj[header] = row[col];
    });
    return obj;
  });
}

function toMoney_(value) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function generateAndStorePdf_(folio, apartado) {
  const html = buildTicketHtml_(apartado);
  const blob = Utilities.newBlob(html, 'text/html', `${folio}.html`).getAs('application/pdf').setName(`${folio}.pdf`);
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  const existing = folder.getFilesByName(`${folio}.pdf`);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  return folder.createFile(blob);
}

function buildTicketHtml_(apartado) {
  const itemsHtml = (apartado.items || [])
    .map((item) => `<tr><td>${escape_(item.codigo)}</td><td>${escape_(item.descripcion)}</td><td style="text-align:center">${item.cantidad}</td><td style="text-align:right">$${item.precio.toFixed(2)}</td></tr>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        @page { size: letter; margin: 16mm; }
        body { font-family: Arial, sans-serif; color: #0f172a; font-size: 12px; }
        h1 { font-size: 18px; margin: 0 0 10px; }
        .meta { margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #dbe2ee; padding: 6px; font-size: 11px; }
        th { background: #f8fbff; text-align: left; }
        .totals { margin-top: 12px; width: 260px; margin-left: auto; }
        .totals-row { display: flex; justify-content: space-between; padding: 2px 0; }
      </style>
    </head>
    <body>
      <h1>Ticket oficial de apartado</h1>
      <div class="meta"><b>Folio:</b> ${escape_(apartado.folio)}<br/><b>Fecha:</b> ${escape_(apartado.fecha)}<br/><b>Cliente:</b> ${escape_(apartado.cliente)}<br/><b>Contacto:</b> ${escape_(apartado.contacto)}<br/><b>Estatus:</b> ${escape_(apartado.estatus)}</div>
      <table>
        <thead><tr><th>Código</th><th>Descripción</th><th>Cant.</th><th>Precio</th></tr></thead>
        <tbody>${itemsHtml || '<tr><td colspan="4">Sin productos</td></tr>'}</tbody>
      </table>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><b>$${apartado.subtotal.toFixed(2)}</b></div>
        <div class="totals-row"><span>Descuento</span><b>$${apartado.descuento.toFixed(2)}</b></div>
        <div class="totals-row"><span>Anticipo</span><b>$${apartado.anticipo.toFixed(2)}</b></div>
        <div class="totals-row"><span>Total</span><b>$${apartado.total.toFixed(2)}</b></div>
        <div class="totals-row"><span>Saldo</span><b>$${apartado.saldo.toFixed(2)}</b></div>
      </div>
    </body>
  </html>`;
}

function updateApartadoPdfMetadata_(rowIndex, metadata) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(APARTADOS_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h || '').trim());

  setCellByHeader_(sheet, headers, rowIndex, 'PdfFileId', metadata.pdfFileId);
  setCellByHeader_(sheet, headers, rowIndex, 'PdfUrl', metadata.pdfUrl);
  setCellByHeader_(sheet, headers, rowIndex, 'PdfUpdatedAt', metadata.pdfUpdatedAt);
  setCellByHeader_(sheet, headers, rowIndex, 'HasOfficialPdf', metadata.hasOfficialPdf ? 'true' : 'false');
}

function setCellByHeader_(sheet, headers, rowIndex, headerName, value) {
  const col = headers.indexOf(headerName);
  if (col === -1) return;
  sheet.getRange(rowIndex, col + 1).setValue(value);
}

function escape_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
