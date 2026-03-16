/**
 * Web App para generar y persistir el PDF oficial de apartados.
 *
 * Deploy:
 * - Ejecutar como: propietario del script.
 * - Acceso: usuarios autorizados o "Cualquiera con el vínculo" según operación.
 */
const APARTADOS_SHEET_NAME = 'apartados';
const APARTADOS_ITEMS_SHEET_NAME = 'apartados_items';
const APARTADOS_ABONOS_SHEET_NAME = 'apartados_abonos';
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
  const abonosSheet = ss.getSheetByName(APARTADOS_ABONOS_SHEET_NAME);
  if (!apartadosSheet || !itemsSheet) throw new Error('No se encontraron hojas de apartados.');

  const apartados = readRows_(apartadosSheet);
  const items = readRows_(itemsSheet);
  const abonos = abonosSheet ? readRows_(abonosSheet) : [];

  const match = apartados.find((row) => normalize_(row.Folio) === folio);
  if (!match) return null;

  const itemsByFolio = items.filter((item) => normalize_(item.Folio) === folio);
  const abonosByFolio = abonos
    .filter((abono) => normalize_(abono.Folio) === folio)
    .map((abono) => ({
      fecha: String(abono.Fecha || abono.fecha || '').trim(),
      monto: toMoney_(abono.Monto || abono.monto || 0),
      metodo: String(abono.Metodo || abono.metodo || '').trim(),
      comentario: String(abono.Comentario || abono.comentario || '').trim(),
    }));

  const parsedSubtotal = toMoney_(match.Subtotal || match.subtotal);
  const parsedDescuento = toMoney_(match.DescuentoMXN || match.descuento || match.Descuento || 0);
  const parsedAnticipo = toMoney_(match.Anticipo || match.anticipo);
  const parsedTotal = toMoney_(match.Total || match.total);
  const parsedSaldo = toMoney_(match.Saldo || match.saldoPendiente || match.saldo);

  const mappedItems = itemsByFolio.map((item) => {
    const cantidad = Number(item.Cantidad || item.cantidad || 1);
    const precioUnitario = toMoney_(item.Precio || item.precio);
    const importe = toMoney_(item.Importe || item.importe || cantidad * precioUnitario);
    return {
      codigo: item.Codigo || item.codigo || '',
      descripcion: item.Descripcion || item.descripcion || 'Prenda',
      cantidad: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
      precioUnitario,
      importe,
    };
  });

  const subtotalFromItems = mappedItems.reduce((acc, item) => acc + toMoney_(item.importe), 0);
  const subtotal = mappedItems.length ? subtotalFromItems : parsedSubtotal;
  const total = parsedTotal || toMoney_(subtotal - parsedDescuento);
  const saldo = parsedSaldo || toMoney_(total - parsedAnticipo);

  const hasRealItems = mappedItems.length > 0;

  return {
    rowIndex: match.__rowIndex,
    folio,
    fecha: match.Fecha || match.fecha || '',
    cliente: match.Cliente || match.cliente || '',
    contacto: match.Contacto || match.contacto || match.Telefono || match.telefono || '',
    subtotal,
    descuento: parsedDescuento,
    anticipo: parsedAnticipo,
    total,
    saldo,
    estatus: String(match.Estado || match.status || match.estatus || 'ACTIVO').toUpperCase(),
    hasRealItems,
    items: mappedItems,
    abonos: abonosByFolio,
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

function formatMoney_(value) {
  const amount = toMoney_(value);
  try {
    return amount.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch (_) {
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    const fixed = abs.toFixed(2);
    const parts = fixed.split('.');
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}$${whole}.${parts[1]}`;
  }
}

function generateAndStorePdf_(folio, apartado) {
  const blob = generarPdfDesdeDoc_(apartado).setName(`${folio}.pdf`);
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  const existing = folder.getFilesByName(`${folio}.pdf`);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  return folder.createFile(blob);
}

function generarPdfDesdeDoc_(apartado) {
  const doc = DocumentApp.create(`TMP_${apartado.folio}_${Date.now()}`);
  const docId = doc.getId();

  try {
    const body = doc.getBody();
    body.clear();
    body.setMarginTop(24);
    body.setMarginBottom(24);
    body.setMarginLeft(28);
    body.setMarginRight(28);

    appendLogo_(body);

    const title = body.appendParagraph('TICKET DE APARTADO');
    title.setBold(true).setFontSize(16).setAlignment(DocumentApp.HorizontalAlignment.CENTER);

    const folioBadge = body.appendParagraph(`FOLIO: ${apartado.folio}`);
    folioBadge
      .setBold(true)
      .setFontSize(11)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .setBackgroundColor('#f1ece4');

    body.appendParagraph('');
    appendMetaRow_(body, 'Fecha', apartado.fecha);
    appendMetaRow_(body, 'Cliente', apartado.cliente);
    appendMetaRow_(body, 'Contacto', apartado.contacto);
    appendMetaRow_(body, 'Estatus', apartado.estatus);

    body.appendParagraph('');
    const detailHeading = body.appendParagraph('DETALLE');
    detailHeading.setBold(true).setFontSize(12);
    appendItemsTable_(body, apartado.items || []);

    body.appendParagraph('');
    appendTotalsTable_(body, apartado);

    body.appendParagraph('');
    appendLegalCopy_(body, apartado.abonos || []);

    body.appendParagraph('');
    appendQr_(body, apartado.folio);

    doc.saveAndClose();
    return DriveApp.getFileById(docId).getAs(MimeType.PDF).setName(`${apartado.folio}.pdf`);
  } finally {
    DriveApp.getFileById(docId).setTrashed(true);
  }
}

function appendLogo_(body) {
  const logoBlob = fetchImageBlob_('https://paneltn.harujagdl.com/assets/haruja-logo.png', 'haruja-logo.png');
  const logoImage = body.appendImage(logoBlob);
  const originalWidth = logoImage.getWidth();
  const originalHeight = logoImage.getHeight();
  const targetWidth = 140;
  const targetHeight = originalWidth ? Math.round((originalHeight / originalWidth) * targetWidth) : 46;
  logoImage.setWidth(targetWidth);
  logoImage.setHeight(targetHeight);
  logoImage.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
}

function appendQr_(body, folio) {
  const destino = `https://paneltn.harujagdl.com/apartado/${encodeURIComponent(folio || '')}`;
  const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(destino)}&size=220&format=png`;
  const qrBlob = fetchImageBlob_(qrUrl, `qr-${folio}.png`);
  const title = body.appendParagraph('Escanea para ver tu apartado');
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setFontSize(10);
  const qrImage = body.appendImage(qrBlob);
  qrImage.setWidth(100);
  qrImage.setHeight(100);
  qrImage.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
}

function appendMetaRow_(body, label, value) {
  const p = body.appendParagraph(`${label}: ${String(value || '').trim() || '-'}`);
  p.setFontSize(10);
}

function appendItemsTable_(body, items) {
  const rows = [['Código', 'Descripción', 'Cantidad', 'P.U.', 'Importe']];
  if (items.length) {
    items.forEach((item) => {
      rows.push([
        String(item.codigo || ''),
        String(item.descripcion || 'Prenda'),
        String(item.cantidad || 1),
        formatMoney_(item.precioUnitario),
        formatMoney_(item.importe),
      ]);
    });
  } else {
    rows.push(['-', 'No hay productos registrados para este apartado.', '-', '-', '-']);
  }

  const table = body.appendTable(rows);
  table.getRow(0).editAsText().setBold(true);
}

function appendTotalsTable_(body, apartado) {
  const rows = [
    ['Subtotal', formatMoney_(apartado.subtotal)],
    ['Anticipo', formatMoney_(apartado.anticipo)],
    ['Descuento', formatMoney_(apartado.descuento)],
    ['Total', formatMoney_(apartado.total)],
  ];
  const table = body.appendTable(rows);
  table.getRow(rows.length - 1).editAsText().setBold(true);
}

function appendLegalCopy_(body, abonos) {
  const gracias = body.appendParagraph('Gracias por tu compra en HarujaGdl');
  gracias.setBold(true).setFontSize(11);

  body
    .appendParagraph('Todos nuestros productos pasan por inspección para garantizar calidad, talla solicitada y que estén libres de defectos.')
    .setFontSize(10);

  body.appendParagraph('CAMBIOS').setBold(true).setFontSize(10);
  body
    .appendParagraph('Solicítalo dentro de 7 días naturales de recibir tu compra. La prenda debe estar nueva, sin uso, sin lavar y con etiquetas originales.')
    .setFontSize(10);

  body.appendParagraph('APARTADOS').setBold(true).setFontSize(10);
  body.appendParagraph('Puedes apartar con 25% de anticipo y cuentas con un plazo máximo de 30 días para recoger.').setFontSize(10);
  body.appendParagraph('Gracias por elegirnos').setBold(true).setFontSize(10);

  if (!abonos.length) return;
  body.appendParagraph('ÚLTIMOS ABONOS').setBold(true).setFontSize(10);
  abonos.slice(0, 4).forEach((abono) => {
    body
      .appendListItem(`${abono.fecha || 'Sin fecha'} · ${formatMoney_(abono.monto)}${abono.metodo ? ` · ${abono.metodo}` : ''}`)
      .setFontSize(9);
  });
}

function fetchImageBlob_(url, fileName) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`No se pudo descargar la imagen: ${url} (HTTP ${code})`);
  }
  return response.getBlob().setName(fileName || 'image.png');
}

function buildTicketHtml_(apartado) {
  const qrValue = `https://harujagdl.com/apartado/${encodeURIComponent(apartado.folio || '')}`;
  const qrSrc = `https://chart.googleapis.com/chart?cht=qr&chs=220x220&chld=M|1&chl=${encodeURIComponent(qrValue)}`;
  const itemsHtml = (apartado.items || [])
    .map((item) => `<tr><td>${escape_(item.codigo)}</td><td>${escape_(item.descripcion)}</td><td class="ta-center">${item.cantidad}</td><td class="ta-right">${formatMoney_(item.precioUnitario)}</td><td class="ta-right">${formatMoney_(item.importe)}</td></tr>`)
    .join('');

  const fallbackItemsHtml = '<tr><td colspan="5" class="ta-center">No hay productos registrados para este apartado.</td></tr>';

  const abonosHtml = (apartado.abonos || [])
    .slice(0, 4)
    .map((abono) => `<li>${escape_(abono.fecha || 'Sin fecha')} · ${formatMoney_(abono.monto)}${abono.metodo ? ` · ${escape_(abono.metodo)}` : ''}</li>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        :root{
          --olive:#a7b59e;
          --coffee:#383234;
          --paper:#fffdfa;
          --line-soft:#d8d3cc;
          --sand:#f1ece4;
        }
        *{box-sizing:border-box}
        @page{ size: letter; margin: 12mm; }
        body{ font-family: "Segoe UI", Arial, sans-serif; color: var(--coffee); font-size: 12px; background: #fff; margin:0; padding:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
        .card{ width:186mm; max-width:186mm; margin:0 auto; background:var(--paper); }
        .logo-wrap{text-align:center; margin-bottom:8px;}
        .logo{width:200px; max-width:100%; height:auto;}
        .top-line{border:0; border-top:3px solid var(--coffee); margin:8px 0 14px;}
        .top-row{display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;}
        .title{font-size:18px; font-weight:700; text-transform:uppercase;}
        .folio{font-weight:700; background:var(--sand); padding:5px 10px; border-radius:999px; font-size:13px;}
        .meta{display:grid; grid-template-columns:88px 1fr; gap:6px 12px; font-size:12px; margin-bottom:10px;}
        .section-title{font-size:14px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; margin:10px 0 8px; color:var(--olive);}
        table{width:100%; border-collapse:collapse;}
        thead th{text-align:left; font-size:12px; text-transform:uppercase; background:var(--sand); border-top:1px solid var(--line-soft); border-bottom:1px solid var(--line-soft); padding:8px 7px;}
        tbody td{font-size:12px; padding:8px 7px; border-bottom:1px solid rgba(56,50,52,.09);}
        .ta-center{text-align:center}
        .ta-right{text-align:right}
        .totals{width:320px; margin-left:auto; margin-top:10px; background:var(--sand); border:1px solid rgba(167,181,158,.4); border-radius:12px; padding:10px 12px;}
        .totals-row{display:flex; justify-content:space-between; margin:6px 0; font-size:13px;}
        .totals-grand{border-top:2px solid var(--olive); padding-top:10px; margin-top:8px; font-size:16px; font-weight:800;}
        .legal{margin-top:14px; font-size:11px; line-height:1.32;}
        .legal h4{margin:10px 0 5px; font-size:11.8px; color:var(--olive); border-left:4px solid var(--olive); padding-left:8px;}
        .legal p{margin:4px 0;}
        .abonos{margin:8px 0 0 16px; padding:0;}
        .abonos li{margin:3px 0;}
        .bottom{display:grid; grid-template-columns:1fr 126px; gap:12px; margin-top:12px; align-items:end;}
        .qr-box{text-align:center; background:var(--sand); border:1px solid rgba(167,181,158,.45); border-radius:12px; padding:8px;}
        .qr{width:106px; height:106px; display:block; margin:0 auto 5px;}
        .qr-caption{font-size:10.5px;}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo-wrap">
          <img class="logo" src="https://harujagdl.com/assets/haruja-logo.png" alt="HarujaGdl" />
        </div>

        <hr class="top-line" />

        <div class="top-row">
          <div class="title">Ticket de apartado</div>
          <div class="folio">#${escape_(apartado.folio)}</div>
        </div>

        <div class="meta">
          <b>Fecha:</b><div>${escape_(apartado.fecha)}</div>
          <b>Cliente:</b><div>${escape_(apartado.cliente)}</div>
          <b>Contacto:</b><div>${escape_(apartado.contacto)}</div>
          <b>Estatus:</b><div>${escape_(apartado.estatus)}</div>
        </div>

        <div class="section-title">Detalle</div>

        <table>
          <thead>
            <tr><th>Código</th><th>Descripción</th><th class="ta-center">Cant</th><th class="ta-right">P.U.</th><th class="ta-right">Importe</th></tr>
          </thead>
          <tbody>${itemsHtml || fallbackItemsHtml}</tbody>
        </table>

        <div class="totals">
          <div class="totals-row"><b>Subtotal:</b><span>${formatMoney_(apartado.subtotal)}</span></div>
          <div class="totals-row"><b>Anticipo:</b><span>${formatMoney_(apartado.anticipo)}</span></div>
          <div class="totals-row"><b>Descuento:</b><span>${formatMoney_(apartado.descuento)}</span></div>
          <div class="totals-row"><b>Saldo:</b><span>${formatMoney_(apartado.saldo)}</span></div>
          <div class="totals-row totals-grand"><b>TOTAL</b><span>${formatMoney_(apartado.total)}</span></div>
        </div>

        <div class="legal">
          <p><strong>Gracias por tu compra en HarujaGdl</strong></p>
          <p>Todos nuestros productos pasan por inspección para garantizar calidad, talla solicitada y que estén libres de defectos.</p>
          <h4>CAMBIOS</h4>
          <p>Solicítalo dentro de 7 días naturales de recibir tu compra. La prenda debe estar nueva, sin uso, sin lavar y con etiquetas originales.</p>
          <h4>APARTADOS</h4>
          <p>Puedes apartar con 25% de anticipo y cuentas con un plazo máximo de 30 días para recoger.</p>
          ${abonosHtml ? `<h4>ÚLTIMOS ABONOS</h4><ul class="abonos">${abonosHtml}</ul>` : ''}
        </div>

        <div class="bottom">
          <div class="meta">
            <b>Pedido:</b><div>${escape_(apartado.folio)}</div>
            <b>Fecha:</b><div>${escape_(apartado.fecha)}</div>
            <b>Cliente:</b><div>${escape_(apartado.cliente)}</div>
            <b>Contacto:</b><div>${escape_(apartado.contacto)}</div>
          </div>
          <div class="qr-box">
            <img class="qr" src="${qrSrc}" alt="QR apartado" />
            <div class="qr-caption">Escanea para ver tu apartado</div>
          </div>
        </div>
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
  setCellByHeader_(sheet, headers, rowIndex, 'pdfFileId', metadata.pdfFileId);
  setCellByHeader_(sheet, headers, rowIndex, 'PdfUrl', metadata.pdfUrl);
  setCellByHeader_(sheet, headers, rowIndex, 'pdfUrl', metadata.pdfUrl);
  setCellByHeader_(sheet, headers, rowIndex, 'PdfUpdatedAt', metadata.pdfUpdatedAt);
  setCellByHeader_(sheet, headers, rowIndex, 'pdfUpdatedAt', metadata.pdfUpdatedAt);
  setCellByHeader_(sheet, headers, rowIndex, 'HasOfficialPdf', metadata.hasOfficialPdf ? 'true' : 'false');
  setCellByHeader_(sheet, headers, rowIndex, 'hasOfficialPdf', metadata.hasOfficialPdf ? 'true' : 'false');
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
