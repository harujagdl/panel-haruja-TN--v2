import { google } from "googleapis";
import { Readable } from "stream";
import { getGoogleServiceAccountCredentials } from "../google/service-account.js";
import {
  APARTADOS_PDF_DRIVE_ID,
  APARTADOS_PDF_FOLDER_ID,
  buildOfficialApartadoPdfFileName,
  normalizeApartadoFolio,
} from "./pdf-config.js";
import { createSheetsClient, getSpreadsheetId, readSheetRows } from "./sheets.js";
import { createTraceId, getErrorMessage, logError, logInfo } from "../observability/logger.js";

function parseMoney(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapePdfText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, " ");
}

function buildLetterPdfBuffer(lines = []) {
  const safeLines = lines.map((line) => escapePdfText(line)).slice(0, 42);
  const textCommands = ["BT", "/F1 11 Tf", "50 740 Td", "14 TL"];
  safeLines.forEach((line, index) => {
    if (index === 0) textCommands.push(`(${line}) Tj`);
    else textCommands.push(`T* (${line}) Tj`);
  });
  textCommands.push("ET");
  const stream = textCommands.join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += obj;
  }
  const xrefStart = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (let idx = 1; idx <= objects.length; idx += 1) {
    output += `${String(offsets[idx]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(output, "latin1");
}

function createDriveClient() {
  const credentials = getGoogleServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
  return google.drive({ version: "v3", auth });
}

function buildPdfUrl(fileId) {
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : "";
}

function inspectUploadBody(body) {
  return {
    type: typeof body,
    constructor: body?.constructor?.name || "",
    isBuffer: Buffer.isBuffer(body),
    isUint8Array: body instanceof Uint8Array,
    isString: typeof body === "string",
    hasPipe: typeof body?.pipe === "function",
    hasGetReader: typeof body?.getReader === "function",
  };
}

function toPdfBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "binary");
  if (body == null) return Buffer.alloc(0);
  return Buffer.from(body);
}

function toDriveUploadBody(pdfSource) {
  const pdfBuffer = toPdfBuffer(pdfSource);
  const uploadBody = Readable.from(pdfBuffer);
  logInfo("apartados.pdf_sync.upload_body", {
    action: "apartados",
    op: "pdf-sync",
    source: inspectUploadBody(pdfSource),
    normalized: inspectUploadBody(pdfBuffer),
    upload: inspectUploadBody(uploadBody),
    size: pdfBuffer.length,
  });
  return { pdfBuffer, uploadBody };
}

function getDriveListScope() {
  if (APARTADOS_PDF_DRIVE_ID) {
    return {
      corpora: "drive",
      driveId: APARTADOS_PDF_DRIVE_ID,
    };
  }
  return {
    corpora: "allDrives",
  };
}

function buildDriveError(error) {
  return {
    ok: false,
    error: "No se pudo guardar el PDF en Drive",
    details: error?.message || "Error desconocido en Drive",
  };
}

async function getDriveFileMetadata(drive, fileId) {
  if (!fileId) return null;
  const response = await drive.files.get({
    fileId,
    fields: "id,name,createdTime,modifiedTime,webViewLink",
    supportsAllDrives: true,
  });
  return response?.data || null;
}

async function findFolderPdfFiles(drive, fileName) {
  const response = await drive.files.list({
    q: `'${APARTADOS_PDF_FOLDER_ID}' in parents and name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
    fields: "files(id,name,createdTime,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: 20,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    ...getDriveListScope(),
  });
  return Array.isArray(response?.data?.files) ? response.data.files : [];
}

async function readApartadoForPdf(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();
  const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  const apartado = apartadosRows.find((row) => normalizeApartadoFolio(row.Folio) === folio);
  const items = itemsRows.filter((row) => normalizeApartadoFolio(row.Folio) === folio);
  const abonos = abonosRows.filter((row) => normalizeApartadoFolio(row.Folio) === folio);
  return { apartado: apartado || null, items, abonos };
}

function buildTicketPdfLines(folio, data = {}) {
  const apartado = data?.apartado || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const subtotal = parseMoney(apartado.Subtotal ?? apartado.subtotal);
  const descuento = parseMoney(apartado.DescuentoMXN ?? apartado.descuento);
  const total = parseMoney(apartado.Total ?? apartado.total);
  const abonosRaw = Array.isArray(data?.abonos) ? data.abonos : [];
  let abonos = abonosRaw.map((abono) => ({
    fecha: String(abono.Fecha || abono.fecha || "").trim(),
    monto: parseMoney(abono.Monto || abono.monto),
    tipo: String(abono.Tipo || abono.tipo || "ABONO").trim().toUpperCase() || "ABONO",
    comentario: String(abono.Comentario || abono.comentario || "").trim(),
  })).filter((abono) => abono.monto > 0);
  const anticipo = parseMoney(apartado.Anticipo ?? apartado.anticipo);
  const hasAnticipo = abonos.some((abono) => abono.tipo === "ANTICIPO");
  if (!hasAnticipo && anticipo > 0) {
    abonos.push({
      fecha: String(apartado.Fecha || apartado.fecha || "").trim(),
      monto: anticipo,
      tipo: "ANTICIPO",
      comentario: "Anticipo virtual para conciliación",
    });
  }
  abonos = abonos.sort((a, b) => Date.parse(String(a.fecha || "")) - Date.parse(String(b.fecha || "")));
  const totalAbonado = abonos.reduce((acc, abono) => acc + parseMoney(abono.monto), 0);
  const saldo = Math.max(0, total - totalAbonado);
  const sobrepago = Math.max(0, totalAbonado - total);

  const lines = [
    "HARUJA - APARTADO OFICIAL",
    `Folio: ${folio}`,
    `Fecha: ${String(apartado.Fecha || apartado.fecha || "").trim()}`,
    `Cliente: ${String(apartado.Cliente || apartado.cliente || "").trim()}`,
    `Contacto: ${String(apartado.Contacto || apartado.contacto || "").trim()}`,
    "",
    "Productos:",
  ];

  if (!items.length) {
    lines.push("- Sin productos registrados");
  } else {
    items.forEach((item, idx) => {
      const codigo = String(item.Codigo || item.codigo || "").trim();
      const descripcion = String(item.Descripcion || item.descripcion || "Prenda").trim();
      const precio = parseMoney(item.Precio || item.precio);
      lines.push(`${idx + 1}. ${codigo} | ${descripcion} | $${precio.toFixed(2)}`);
    });
  }

  lines.push("", `Subtotal: $${subtotal.toFixed(2)}`);
  lines.push(`Descuento: $${descuento.toFixed(2)}`);
  lines.push(`Total: $${total.toFixed(2)}`);
  lines.push(`Total abonado: $${totalAbonado.toFixed(2)}`);
  lines.push(`Saldo pendiente: $${saldo.toFixed(2)}`);
  if (sobrepago > 0) lines.push(`Saldo a favor: $${sobrepago.toFixed(2)}`);
  lines.push("", "Historial de pagos:");
  if (!abonos.length) lines.push("- Sin pagos registrados");
  else {
    abonos.forEach((abono) => {
        const fecha = String(abono.fecha || "").trim() || "Sin fecha";
        const tipo = String(abono.tipo || abono.comentario || "ABONO").trim();
        const monto = parseMoney(abono.monto).toFixed(2);
        lines.push(`- ${fecha} | ${tipo} | $${monto}`);
      });
  }
  lines.push(`Estado: ${String(apartado.Estado || apartado.estado || "ACTIVO").trim()}`);
  lines.push("", `Actualizado: ${new Date().toISOString()}`);

  return lines;
}

function normalizeSuccessResponse(result = {}) {
  return {
    ok: true,
    exists: true,
    pdfUrl: String(result.pdfUrl || "").trim(),
    updatedAt: String(result.updatedAt || "").trim(),
    fileId: String(result.fileId || "").trim(),
    fileName: String(result.fileName || "").trim(),
    folderId: APARTADOS_PDF_FOLDER_ID,
    driveId: APARTADOS_PDF_DRIVE_ID,
    replaced: Boolean(result.replaced),
  };
}

async function getStoredPdf({ drive, fileName }) {
  const files = await findFolderPdfFiles(drive, fileName);
  if (!files.length) {
    return {
      ok: true,
      exists: false,
      pdfUrl: "",
      updatedAt: "",
      fileId: "",
      fileName,
      folderId: APARTADOS_PDF_FOLDER_ID,
      driveId: APARTADOS_PDF_DRIVE_ID,
      replaced: false,
    };
  }

  const latest = files[0];
  const metadata = await getDriveFileMetadata(drive, latest.id);
  return normalizeSuccessResponse({
    pdfUrl: String(metadata?.webViewLink || latest.webViewLink || "").trim() || buildPdfUrl(latest.id),
    updatedAt: String(metadata?.modifiedTime || metadata?.createdTime || latest.modifiedTime || latest.createdTime || "").trim(),
    fileId: String(metadata?.id || latest.id || "").trim(),
    fileName: String(metadata?.name || latest.name || fileName || "").trim(),
    replaced: false,
  });
}

async function writeOfficialPdf({ drive, folio, payloadApartado, payloadAbonos }) {
  const fileName = buildOfficialApartadoPdfFileName(folio);
  const previousFiles = await findFolderPdfFiles(drive, fileName);
  for (const file of previousFiles) {
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
  }

  const sheetData = await readApartadoForPdf(folio);
  const pdfLines = buildTicketPdfLines(folio, {
    apartado: sheetData.apartado || payloadApartado || {},
    items: sheetData.items,
    abonos: (sheetData.abonos && sheetData.abonos.length) ? sheetData.abonos : (payloadAbonos || []),
  });
  const rawPdfBody = buildLetterPdfBuffer(pdfLines);
  const { uploadBody } = toDriveUploadBody(rawPdfBody);

  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [APARTADOS_PDF_FOLDER_ID],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body: uploadBody,
    },
    fields: "id,name,webViewLink,createdTime,modifiedTime",
    supportsAllDrives: true,
  });

  const fileId = String(created?.data?.id || "").trim();
  const createdMetadata = await getDriveFileMetadata(drive, fileId);
  const pdfUrl = String(createdMetadata?.webViewLink || created?.data?.webViewLink || "").trim() || buildPdfUrl(fileId);
  if (!fileId || !pdfUrl) {
    return {
      ok: false,
      error: "No se pudo guardar el PDF en Drive",
      details: "Drive devolvió una respuesta sin fileId o sin webViewLink",
    };
  }

  return normalizeSuccessResponse({
    pdfUrl,
    updatedAt: String(createdMetadata?.modifiedTime || createdMetadata?.createdTime || created?.data?.modifiedTime || created?.data?.createdTime || new Date().toISOString()).trim(),
    fileId: String(createdMetadata?.id || fileId || "").trim(),
    fileName: String(createdMetadata?.name || fileName || "").trim(),
    replaced: previousFiles.length > 0,
  });
}

export async function saveRenderedApartadoPdfToDrive({ folio, pdfBuffer } = {}) {
  const normalizedFolio = normalizeApartadoFolio(folio);

  if (!normalizedFolio) {
    return {
      ok: false,
      error: "No se pudo guardar el PDF en Drive",
      details: "missing folio",
    };
  }

  if (!pdfBuffer) {
    return {
      ok: false,
      error: "No se pudo guardar el PDF en Drive",
      details: "missing pdfBuffer",
    };
  }

  try {
    const drive = createDriveClient();
    const fileName = buildOfficialApartadoPdfFileName(normalizedFolio);
    const previousFiles = await findFolderPdfFiles(drive, fileName);

    for (const file of previousFiles) {
      await drive.files.delete({
        fileId: file.id,
        supportsAllDrives: true,
      });
    }

    const { uploadBody } = toDriveUploadBody(pdfBuffer);

    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [APARTADOS_PDF_FOLDER_ID],
        mimeType: "application/pdf",
      },
      media: {
        mimeType: "application/pdf",
        body: uploadBody,
      },
      fields: "id,name,webViewLink,createdTime,modifiedTime",
      supportsAllDrives: true,
    });

    const fileId = String(created?.data?.id || "").trim();
    if (!fileId) {
      return {
        ok: false,
        error: "No se pudo guardar el PDF en Drive",
        details: "Drive no devolvió fileId",
      };
    }

    const metadata = await getDriveFileMetadata(drive, fileId);
    const pdfUrl = String(metadata?.webViewLink || created?.data?.webViewLink || "").trim() || buildPdfUrl(fileId);

    return normalizeSuccessResponse({
      pdfUrl,
      updatedAt: String(
        metadata?.modifiedTime ||
          metadata?.createdTime ||
          created?.data?.modifiedTime ||
          created?.data?.createdTime ||
          new Date().toISOString(),
      ).trim(),
      fileId: String(metadata?.id || fileId).trim(),
      fileName: String(metadata?.name || fileName).trim(),
      replaced: previousFiles.length > 0,
    });
  } catch (error) {
    return buildDriveError(error);
  }
}

async function handleRequest({ action, folio, payloadApartado, payloadAbonos }) {
  if (!folio) {
    return {
      ok: false,
      skipped: true,
      error: "No se pudo guardar el PDF en Drive",
      details: "missing folio",
    };
  }

  try {
    const drive = createDriveClient();
    if (action === "get") return getStoredPdf({ drive, fileName: buildOfficialApartadoPdfFileName(folio) });
    return writeOfficialPdf({ drive, folio, payloadApartado, payloadAbonos });
  } catch (error) {
    return buildDriveError(error);
  }
}

export async function runApartadoPdfDriveWriteTest(payload = {}) {
  const traceId = createTraceId(payload.traceId);
  try {
    logInfo("pdf.drive_test.start", { action: "apartados", op: "pdf-drive-test", traceId });
    const drive = createDriveClient();
    const rawPdfBody = buildLetterPdfBuffer([
      "TEST-PDF-DRIVE",
      "Validacion de escritura en carpeta oficial",
      `Folder: ${APARTADOS_PDF_FOLDER_ID}`,
      `Drive: ${APARTADOS_PDF_DRIVE_ID || "allDrives"}`,
      `GeneratedAt: ${new Date().toISOString()}`,
    ]);
    const { uploadBody } = toDriveUploadBody(rawPdfBody);
    const created = await drive.files.create({
      requestBody: {
        name: "TEST-PDF-DRIVE.pdf",
        parents: [APARTADOS_PDF_FOLDER_ID],
        mimeType: "application/pdf",
      },
      media: { mimeType: "application/pdf", body: uploadBody },
      fields: "id,name,webViewLink,createdTime",
      supportsAllDrives: true,
    });

    const fileId = String(created?.data?.id || "").trim();
    const pdfUrl = String(created?.data?.webViewLink || "").trim() || buildPdfUrl(fileId);
    if (!fileId || !pdfUrl) {
      logError("pdf.drive_test.failed", {
        action: "apartados",
        op: "pdf-drive-test",
        traceId,
        errorCode: "PDF_PROXY_FAILED",
        message: "No se recibió fileId o pdfUrl en la respuesta de Drive",
      });
      return {
        ok: false,
        error: "No se pudo guardar el PDF en Drive",
        details: "No se recibió fileId o pdfUrl en la respuesta de Drive",
        code: "PDF_PROXY_FAILED",
        traceId,
      };
    }

    logInfo("pdf.drive_test.success", { action: "apartados", op: "pdf-drive-test", traceId, fileId });
    return {
      ok: true,
      fileId,
      pdfUrl,
      fileName: "TEST-PDF-DRIVE.pdf",
      folderId: APARTADOS_PDF_FOLDER_ID,
      driveId: APARTADOS_PDF_DRIVE_ID,
      traceId,
    };
  } catch (error) {
    logError("pdf.drive_test.failed", {
      action: "apartados",
      op: "pdf-drive-test",
      traceId,
      errorCode: "PDF_PROXY_FAILED",
      message: getErrorMessage(error),
    });
    return { ...buildDriveError(error), code: "PDF_PROXY_FAILED", traceId };
  }
}

export async function syncApartadoPdf({ folio, reason, apartado, abonos } = {}) {
  const traceId = createTraceId(apartado?.traceId);
  return handleRequest({
    action: "sync",
    folio: normalizeApartadoFolio(folio),
    payloadApartado: { ...(apartado || {}), reason: reason || "update", traceId },
    payloadAbonos: Array.isArray(abonos) ? abonos : [],
  });
}

export async function getApartadoPdf({ folio } = {}) {
  return handleRequest({ action: "get", folio: normalizeApartadoFolio(folio) });
}

export async function refreshApartadoPdf({ folio, apartado, reason } = {}) {
  return handleRequest({
    action: "refresh",
    folio: normalizeApartadoFolio(folio),
    payloadApartado: { ...(apartado || {}), reason: reason || "manual_refresh" },
  });
}

export async function refreshPdfApartado(folio) {
  return refreshApartadoPdf({ folio, reason: "prepared_refresh_trigger" });
}
