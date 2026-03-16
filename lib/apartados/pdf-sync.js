import { google } from "googleapis";
import { Readable } from "stream";
import {
  APARTADOS_PDF_FOLDER_ID,
  buildOfficialApartadoPdfFileName,
  normalizeApartadoFolio,
} from "./pdf-config.js";
import { createSheetsClient, getSpreadsheetId, readSheetRows } from "./sheets.js";

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
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
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
  console.info("PDF upload body debug", {
    source: inspectUploadBody(pdfSource),
    normalized: inspectUploadBody(pdfBuffer),
    upload: inspectUploadBody(uploadBody),
    size: pdfBuffer.length,
  });
  return { pdfBuffer, uploadBody };
}

async function findFolderPdfFiles(drive, fileName) {
  const response = await drive.files.list({
    q: `'${APARTADOS_PDF_FOLDER_ID}' in parents and name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
    fields: "files(id,name,createdTime,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: 20,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return Array.isArray(response?.data?.files) ? response.data.files : [];
}

async function readApartadoForPdf(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();
  const [apartadosRows, itemsRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
  ]);

  const apartado = apartadosRows.find((row) => normalizeApartadoFolio(row.Folio) === folio);
  const items = itemsRows.filter((row) => normalizeApartadoFolio(row.Folio) === folio);
  return { apartado: apartado || null, items };
}

function buildTicketPdfLines(folio, data = {}) {
  const apartado = data?.apartado || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const subtotal = parseMoney(apartado.Subtotal ?? apartado.subtotal);
  const anticipo = parseMoney(apartado.Anticipo ?? apartado.anticipo);
  const descuento = parseMoney(apartado.DescuentoMXN ?? apartado.descuento);
  const total = parseMoney(apartado.Total ?? apartado.total);
  const saldo = parseMoney(apartado.Saldo ?? apartado.saldoPendiente ?? (total - anticipo));

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
  lines.push(`Anticipo: $${anticipo.toFixed(2)}`);
  lines.push(`Total: $${total.toFixed(2)}`);
  lines.push(`Saldo pendiente: $${saldo.toFixed(2)}`);
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
      replaced: false,
    };
  }

  const latest = files[0];
  return normalizeSuccessResponse({
    pdfUrl: String(latest.webViewLink || "").trim() || buildPdfUrl(latest.id),
    updatedAt: String(latest.modifiedTime || latest.createdTime || "").trim(),
    fileId: latest.id,
    fileName: latest.name || fileName,
    replaced: false,
  });
}

async function writeOfficialPdf({ drive, folio, payloadApartado }) {
  const fileName = buildOfficialApartadoPdfFileName(folio);
  const previousFiles = await findFolderPdfFiles(drive, fileName);
  for (const file of previousFiles) {
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
  }

  const sheetData = await readApartadoForPdf(folio);
  const pdfLines = buildTicketPdfLines(folio, {
    apartado: sheetData.apartado || payloadApartado || {},
    items: sheetData.items,
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
  const pdfUrl = String(created?.data?.webViewLink || "").trim() || buildPdfUrl(fileId);
  if (!fileId || !pdfUrl) {
    return { ok: false, error: "No se pudo guardar el PDF en Drive" };
  }

  return normalizeSuccessResponse({
    pdfUrl,
    updatedAt: String(created?.data?.modifiedTime || created?.data?.createdTime || new Date().toISOString()).trim(),
    fileId,
    fileName,
    replaced: previousFiles.length > 0,
  });
}

async function handleRequest({ action, folio, payloadApartado }) {
  if (!folio) return { ok: false, skipped: true, reason: "missing folio" };

  try {
    const drive = createDriveClient();
    if (action === "get") return getStoredPdf({ drive, fileName: buildOfficialApartadoPdfFileName(folio) });
    return writeOfficialPdf({ drive, folio, payloadApartado });
  } catch (error) {
    return { ok: false, error: error?.message || "No se pudo guardar el PDF en Drive" };
  }
}

export async function runApartadoPdfDriveWriteTest() {
  try {
    const drive = createDriveClient();
    const rawPdfBody = buildLetterPdfBuffer([
      "TEST-PDF-DRIVE",
      "Validacion de escritura en carpeta oficial",
      `Folder: ${APARTADOS_PDF_FOLDER_ID}`,
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
    if (!fileId || !pdfUrl) return { ok: false, error: "No se pudo guardar el PDF en Drive" };

    return {
      ok: true,
      fileId,
      pdfUrl,
      fileName: "TEST-PDF-DRIVE.pdf",
      folderId: APARTADOS_PDF_FOLDER_ID,
    };
  } catch (error) {
    return { ok: false, error: error?.message || "No se pudo guardar el PDF en Drive" };
  }
}

export async function syncApartadoPdf({ folio, reason, apartado } = {}) {
  return handleRequest({
    action: "sync",
    folio: normalizeApartadoFolio(folio),
    payloadApartado: { ...(apartado || {}), reason: reason || "update" },
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
