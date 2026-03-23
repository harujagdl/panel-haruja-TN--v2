import {
  appendSheetRow,
  buildRowByTargetHeaders,
  createSheetsClient,
  ensureSheetsSetup,
  getSheetHeaders,
  getSpreadsheetId,
  nowIso,
  parseCurrencyNumber,
  readSheetRows,
  roundMoney,
  SHEET_HEADERS,
  updateSheetRow,
} from "../apartados/sheets.js";
import { getApartadoPdf, syncApartadoPdf } from "../apartados/pdf-sync.js";

const APARTADOS_LIST_CACHE_KEY = "apartados:list";
const APARTADOS_LIST_CACHE_TTL_MS = 60000;
const apartadosCache = new Map();

function normalize(value) { return String(value || "").trim().toUpperCase(); }
function getValueByCandidates(source, candidates) {
  const entries = Object.entries(source || {});
  const normalizedCandidates = candidates.map((candidate) => String(candidate).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
  for (const [key, value] of entries) {
    const normalizedKey = String(key).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (normalizedCandidates.includes(normalizedKey)) return value;
  }
  return "";
}


function getYearSuffix(dateValue) {
  const fallbackYear = new Date().getFullYear();
  if (!dateValue) return String(fallbackYear).slice(-2);
  const raw = String(dateValue).trim();
  if (!raw) return String(fallbackYear).slice(-2);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return String(parsed.getFullYear()).slice(-2);
  const yearMatch = raw.match(/(\d{4})/);
  if (yearMatch) return yearMatch[1].slice(-2);
  return String(fallbackYear).slice(-2);
}

function extractConsecutiveFromFolio(folio) {
  const normalized = normalize(folio);
  const match = /^HARUJA(\d{2})-(\d{3,})$/.exec(normalized);
  if (!match) return null;
  return Number.parseInt(match[2], 10);
}

function buildApartadoFolio(dateValue, nextNumber) {
  const yearSuffix = getYearSuffix(dateValue);
  const seq = Number.parseInt(nextNumber, 10);
  const safeSeq = Number.isFinite(seq) && seq > 0 ? seq : 1;
  return `HARUJA${yearSuffix}-${String(safeSeq).padStart(3, "0")}`;
}


function buildTicketUrl(folio) {
  return `/ticket/${encodeURIComponent(String(folio || "").trim())}`;
}

function sanitizePdfUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  return /^\/ticket\//i.test(raw) ? "" : raw;
}

async function updateApartadoPdfMetadata({ folio, pdfUrl, fileId, updatedAt, hasOfficialPdf }) {
  const normalizedFolio = normalize(folio);
  if (!normalizedFolio) return null;

  const { sheets, spreadsheetId } = await getContext();
  const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const apartado = apartadosRows.find((row) => normalize(row.Folio) === normalizedFolio);
  if (!apartado) return null;

  const cleanedPdfUrl = sanitizePdfUrl(pdfUrl);
  const normalizedFileId = String(fileId || "").trim();
  const shouldMarkOfficial = typeof hasOfficialPdf === "boolean" ? hasOfficialPdf : Boolean(cleanedPdfUrl || normalizedFileId);
  const officialValue = shouldMarkOfficial ? "true" : "false";
  const values = buildRowByTargetHeaders(apartado, apartadosHeaders, {
    PdfUrl: cleanedPdfUrl,
    PdfFileId: normalizedFileId,
    PdfUpdatedAt: String(updatedAt || nowIso()).trim(),
    HasOfficialPdf: officialValue,
    UltimoMovimiento: nowIso(),
  });

  await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, values);
  invalidateApartadosListCache();
  return { pdfUrl: cleanedPdfUrl, hasOfficialPdf: officialValue === "true" };
}

export async function registerApartadoPdfGeneration({ folio, pdfUrl = "", generatedAt = "" } = {}) {
  const normalizedFolio = normalize(folio);
  if (!normalizedFolio) {
    return { status: 400, body: { ok: false, message: "folio es obligatorio." } };
  }

  const timestamp = String(generatedAt || nowIso()).trim();
  const metadata = await updateApartadoPdfMetadata({
    folio: normalizedFolio,
    pdfUrl,
    fileId: "",
    updatedAt: timestamp,
    hasOfficialPdf: true,
  });

  if (!metadata) {
    return { status: 404, body: { ok: false, message: "No se encontró el folio." } };
  }

  return {
    ok: true,
    folio: normalizedFolio,
    pdfUrl: String(pdfUrl || "").trim(),
    pdfGeneratedAt: timestamp,
    hasOfficialPdf: true,
  };
}

async function getNextApartadoSequenceByYear(apartadosRows = [], dateValue) {
  const yearSuffix = getYearSuffix(dateValue);
  const prefix = `HARUJA${yearSuffix}-`;
  const seqs = apartadosRows
    .map((row) => normalize(row.Folio))
    .filter((folio) => folio.startsWith(prefix))
    .map((folio) => extractConsecutiveFromFolio(folio))
    .filter((value) => Number.isFinite(value));
  const maxSeq = seqs.length ? Math.max(...seqs) : 0;
  return maxSeq + 1;
}

function calcDiscount(subtotal, descuentoTipo, descuentoValorInput) {
  const descuentoValor = roundMoney(descuentoValorInput);
  if (descuentoValor < 0) throw new Error("El descuento no puede ser negativo.");
  if (descuentoTipo === "PCT") {
    if (descuentoValor > 100) throw new Error("El descuento en % no puede ser mayor a 100.");
    return roundMoney(subtotal * (descuentoValor / 100));
  }
  if (descuentoTipo === "AMT") return roundMoney(Math.min(descuentoValor, subtotal));
  throw new Error("Tipo de descuento inválido.");
}

export function buildApartadoResponse(apartado, itemsRows, abonosRows) {
  const folio = String(apartado.Folio || "").trim();
  const folioKey = normalize(folio);
  const productos = itemsRows.filter((item) => normalize(item.Folio) === folioKey).map((item) => ({
    codigo: String(item.Codigo || "").trim(), descripcion: String(item.Descripcion || "").trim(), tipo: String(item.Tipo || "").trim(), color: String(item.Color || "").trim(), talla: String(item.Talla || "").trim(), proveedor: String(item.Proveedor || "").trim(), precio: roundMoney(item.Precio)
  }));

  const historialAbonos = abonosRows.filter((abono) => normalize(abono.Folio) === folioKey).map((abono) => ({
    fecha: String(abono.Fecha || "").trim(), monto: roundMoney(abono.Monto), metodo: String(abono.Metodo || "").trim(), comentario: String(abono.Comentario || "").trim(),
  })).sort((a, b) => Date.parse(b.fecha || "") - Date.parse(a.fecha || ""));

  const total = roundMoney(apartado.Total);
  const anticipo = roundMoney(apartado.Anticipo);

  return {
    folio,
    cliente: String(apartado.Cliente || "").trim(),
    telefono: String(apartado.Contacto || "").trim(),
    fecha: String(apartado.Fecha || "").trim(),
    productos,
    subtotal: roundMoney(apartado.Subtotal),
    descuento: roundMoney(apartado.DescuentoMXN),
    anticipo,
    total,
    saldoPendiente: roundMoney(Math.max(0, total - anticipo)),
    historialAbonos,
    status: String(apartado.Estado || "ACTIVO").trim().toUpperCase(),
    fechaLimite: String(apartado.FechaLimite || "").trim(),
    ticketUrl: String(apartado.TicketUrl || apartado.ticketUrl || "").trim() || buildTicketUrl(folio),
    pdfUrl: sanitizePdfUrl(apartado.PdfUrl || apartado.PDFUrl || apartado.pdfUrl || ""),
    pdfFileId: String(apartado.PdfFileId || apartado.pdfFileId || "").trim(),
    pdfUpdatedAt: String(apartado.PdfUpdatedAt || apartado.pdfUpdatedAt || "").trim(),
    hasOfficialPdf: String(apartado.HasOfficialPdf || apartado.hasOfficialPdf || "").trim().toLowerCase() === "true",
  };
}

async function getContext() {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();
  await ensureSheetsSetup(sheets, spreadsheetId);
  return { sheets, spreadsheetId };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStatusValue(row) {
  return String(row?.Estado || row?.status || "ACTIVO").trim().toUpperCase();
}

function mapApartadoListRow(row) {
  const folio = String(row?.Folio || "").trim();
  const fecha = String(row?.Fecha || "").trim();
  const cliente = String(row?.Cliente || "").trim();
  const contacto = String(row?.Contacto || "").trim();
  const total = roundMoney(row?.Total);
  const anticipo = roundMoney(row?.Anticipo);
  return {
    folio,
    fecha,
    cliente,
    contacto,
    total,
    anticipo,
    saldo: roundMoney(Math.max(0, total - anticipo)),
    estatus: getStatusValue(row),
    pdfUrl: sanitizePdfUrl(row?.PdfUrl || row?.PDFUrl || row?.pdfUrl || ""),
    pdfFileId: String(row?.PdfFileId || row?.pdfFileId || "").trim(),
    pdfUpdatedAt: String(row?.PdfUpdatedAt || row?.pdfUpdatedAt || "").trim(),
    hasOfficialPdf: String(row?.HasOfficialPdf || row?.hasOfficialPdf || "").trim().toLowerCase() === "true",
  };
}

async function readApartadosRowsWithCache() {
  const now = Date.now();
  const cached = apartadosCache.get(APARTADOS_LIST_CACHE_KEY);
  if (cached && cached.expiresAt > now) {
    console.log("[apartados:list] cache hit");
    return cached.rows;
  }

  console.log("[apartados:list] cache miss");
  const { sheets, spreadsheetId } = await getContext();
  const rows = await readSheetRows(sheets, spreadsheetId, "apartados");
  console.log(`[apartados:list] rows loaded: ${rows.length}`);
  apartadosCache.set(APARTADOS_LIST_CACHE_KEY, {
    rows,
    expiresAt: now + APARTADOS_LIST_CACHE_TTL_MS,
  });
  return rows;
}

function invalidateApartadosListCache() {
  apartadosCache.delete(APARTADOS_LIST_CACHE_KEY);
}

export async function getNextFolio(dateValue = "") {
  const { sheets, spreadsheetId } = await getContext();
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const nextSeq = await getNextApartadoSequenceByYear(apartadosRows, dateValue);
  return { ok: true, folio: buildApartadoFolio(dateValue, nextSeq) };
}

export async function listApartados(params = {}) {
  const q = String(params?.q || "").trim().toUpperCase();
  const status = String(params?.status || "").trim().toUpperCase();
  const hasLimit = String(params?.limit ?? "").trim() !== "";
  const hasPage = String(params?.page ?? "").trim() !== "";
  const page = parsePositiveInt(params?.page, 1);

  const apartadosRows = await readApartadosRowsWithCache();
  const filtered = apartadosRows
    .filter((row) => {
      const normalizedStatus = getStatusValue(row);
      if (status && normalizedStatus !== status) return false;
      if (!q) return true;
      return [row?.Folio, row?.Cliente, row?.Contacto]
        .some((value) => String(value || "").trim().toUpperCase().includes(q));
    })
    .sort((a, b) => Date.parse(String(b?.Fecha || "")) - Date.parse(String(a?.Fecha || "")));

  const effectiveLimit = hasLimit ? parsePositiveInt(params?.limit, 50) : filtered.length || 1;
  const effectivePage = hasPage || hasLimit ? page : 1;
  const start = (effectivePage - 1) * effectiveLimit;
  const apartados = filtered.slice(start, start + effectiveLimit).map(mapApartadoListRow);

  return {
    ok: true,
    apartados,
    total: filtered.length,
    page: effectivePage,
    limit: effectiveLimit,
    hasMore: start + apartados.length < filtered.length,
  };
}

export async function getApartadoDetail(folio) {
  const { sheets, spreadsheetId } = await getContext();
  const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  const apartado = apartadosRows.find((row) => normalize(row.Folio) === normalize(folio));
  if (!apartado) return { status: 404, body: { ok: false, message: "No se encontró el folio." } };

  const detail = buildApartadoResponse(apartado, itemsRows, abonosRows);
  const pdfSync = await getApartadoPdf({ folio: detail.folio });
  if (pdfSync?.ok && pdfSync.pdfUrl) {
    detail.pdfDriveUrl = pdfSync.pdfUrl;
    detail.pdfFileId = String(pdfSync.fileId || detail.pdfFileId || "").trim();
    detail.pdfUpdatedAt = String(pdfSync.updatedAt || detail.pdfUpdatedAt || "").trim();
    detail.hasOfficialPdf = true;
    await updateApartadoPdfMetadata({
      folio: detail.folio,
      pdfUrl: detail.pdfDriveUrl,
      fileId: detail.pdfFileId,
      updatedAt: detail.pdfUpdatedAt,
    });
  }

  return { ok: true, apartado: detail, folio: detail.folio, fecha: detail.fecha, cliente: detail.cliente, contacto: detail.telefono, items: detail.productos, subtotal: detail.subtotal, anticipo: detail.anticipo, descuento: detail.descuento, total: detail.total };
}

export async function addAbono(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const fecha = String(payload.fecha || "").trim();
  const folio = normalize(payload.folio);
  const anticipoInput = roundMoney(payload.anticipo);
  if (!folio || anticipoInput <= 0) throw new Error("Para abono ingresa el Folio y un anticipo mayor a 0.");

  const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
  if (!apartado) throw new Error("No se encontró el folio.");

  const total = roundMoney(apartado.Total);
  const nuevoAnticipo = roundMoney(roundMoney(apartado.Anticipo) + anticipoInput);
  const nuevoSaldo = roundMoney(Math.max(0, total - nuevoAnticipo));
  const nuevoEstado = nuevoSaldo <= 0 ? "LIQUIDADO" : "ACTIVO";
  const now = nowIso();

  const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, { Anticipo: nuevoAnticipo, Saldo: nuevoSaldo, Estado: nuevoEstado, UltimoMovimiento: now });
  await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
  await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, { Folio: folio, Fecha: fecha || now.slice(0, 10), Monto: anticipoInput, Metodo: "EFECTIVO", Comentario: "Abono registrado desde formulario", FechaCreacion: now }));

  const pdfSync = await syncApartadoPdf({ folio, reason: "abono", apartado: { folio, anticipo: nuevoAnticipo, saldoPendiente: nuevoSaldo, status: nuevoEstado } });
  if (pdfSync?.ok && pdfSync?.pdfUrl) {
    await updateApartadoPdfMetadata({ folio, pdfUrl: pdfSync.pdfUrl, fileId: pdfSync.fileId, updatedAt: pdfSync.updatedAt });
  }
  invalidateApartadosListCache();
  return { ok: true, folio, ticketUrl: buildTicketUrl(folio), pdfDriveUrl: pdfSync?.pdfUrl || "" };
}

export async function createApartado(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const requestedFolio = normalize(payload.folio);
  const fecha = String(payload.fecha || "").trim();
  const cliente = String(payload.cliente || "").trim();
  const contacto = String(payload.contacto || "").trim();
  const anticipo = roundMoney(payload.anticipo);
  if (anticipo < 0) throw new Error("El anticipo no puede ser negativo.");
  if (!fecha || !cliente || !contacto) throw new Error("Completa los campos obligatorios para registrar el apartado.");

  const codigos = String(payload.codigos || "").split(",").map((code) => code.trim()).filter(Boolean);
  if (!codigos.length) throw new Error("Debes ingresar al menos un código.");

  const now = nowIso();
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const nextSeq = await getNextApartadoSequenceByYear(apartadosRows, fecha);
  const generatedFolio = buildApartadoFolio(fecha, nextSeq);
  const folio = requestedFolio || generatedFolio;
  if (!requestedFolio && apartadosRows.some((row) => normalize(row.Folio) === folio)) {
    throw new Error("No se pudo generar un folio único para este año. Intenta de nuevo.");
  }

  const inventarioRows = await readSheetRows(sheets, spreadsheetId, "prendas_admin_activas");
  const inventoryByCode = new Map();
  inventarioRows.forEach((row) => {
    const codigo = String(getValueByCandidates(row, ["Codigo", "Código"]) || "").trim();
    if (codigo) inventoryByCode.set(codigo, row);
  });

  const missingCodes = codigos.filter((codigo) => !inventoryByCode.has(codigo));
  if (missingCodes.length) throw new Error(`No se encontraron estos códigos: ${missingCodes.join(", ")}`);

  const items = codigos.map((codigo) => {
    const row = inventoryByCode.get(codigo);
    return { Folio: folio, Codigo: codigo, Descripcion: getValueByCandidates(row, ["Descripcion", "Descripción"]), Tipo: getValueByCandidates(row, ["Tipo"]), Color: getValueByCandidates(row, ["Color"]), Talla: getValueByCandidates(row, ["Talla"]), Proveedor: getValueByCandidates(row, ["Proveedor"]), Precio: roundMoney(getValueByCandidates(row, ["Precio", "PrecioVenta", "Precio Venta"])), FechaCreacion: now };
  });

  const subtotal = roundMoney(items.reduce((sum, item) => sum + parseCurrencyNumber(item.Precio), 0));
  const descuentoTipo = String(payload.descuentoTipo || "PCT").trim().toUpperCase();
  const descuentoValor = roundMoney(payload.descuentoValor);
  const descuentoMXN = calcDiscount(subtotal, descuentoTipo, descuentoValor);
  const total = roundMoney(Math.max(0, subtotal - descuentoMXN));
  const saldo = roundMoney(Math.max(0, total - anticipo));
  const estado = saldo <= 0 ? "LIQUIDADO" : "ACTIVO";

  await appendSheetRow(sheets, spreadsheetId, "apartados", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados, { Folio: folio, Fecha: fecha, Cliente: cliente, Contacto: contacto, Subtotal: subtotal, DescuentoTipo: descuentoTipo, DescuentoValor: descuentoValor, DescuentoMXN: descuentoMXN, Total: total, Anticipo: anticipo, Saldo: saldo, Estado: estado, FechaCreacion: now, UltimoMovimiento: now, TicketUrl: buildTicketUrl(folio), PdfUrl: "" }));
  for (const item of items) {
    await appendSheetRow(sheets, spreadsheetId, "apartados_items", buildRowByTargetHeaders(item, SHEET_HEADERS.apartados_items));
  }
  if (anticipo > 0) {
    await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, { Folio: folio, Fecha: fecha, Monto: anticipo, Metodo: "EFECTIVO", Comentario: "Anticipo inicial", FechaCreacion: now }));
  }

  const pdfSync = await syncApartadoPdf({ folio, reason: "create", apartado: { folio, cliente, contacto, fecha, subtotal, anticipo, descuento: descuentoMXN, total, saldoPendiente: saldo, status: estado } });
  if (pdfSync?.ok && pdfSync?.pdfUrl) {
    await updateApartadoPdfMetadata({ folio, pdfUrl: pdfSync.pdfUrl, fileId: pdfSync.fileId, updatedAt: pdfSync.updatedAt });
  }
  invalidateApartadosListCache();
  return { ok: true, folio, ticketUrl: buildTicketUrl(folio), pdfDriveUrl: pdfSync?.pdfUrl || "" };
}

export async function updateApartadoStatus(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const folio = normalize(payload.folio);
  const estado = String(payload.estado || payload.status || "").trim().toUpperCase();
  if (!folio || !estado) throw new Error("Folio y estado son obligatorios.");

  const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
  if (!apartado) return { status: 404, body: { ok: false, message: "No se encontró el folio." } };

  const now = nowIso();
  const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, { Estado: estado, UltimoMovimiento: now });
  await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
  await syncApartadoPdf({ folio, reason: "status-update", apartado: { folio, status: estado } });
  invalidateApartadosListCache();
  return { ok: true, folio, status: estado };
}

export async function regenerateApartadoPdf(folio, payload = {}) {
  const normalizedFolio = normalize(folio);
  if (!normalizedFolio) {
    return { status: 400, body: { ok: false, message: "folio es obligatorio." } };
  }
  const appUrl = String(payload?.appUrl || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (!appUrl) {
    return { status: 500, body: { ok: false, message: "No se pudo resolver APP_URL para generar el PDF oficial." } };
  }

  console.log("pdf-refresh:start", { folio: normalizedFolio });
  const renderUrl = `${appUrl}/api/pdf-apartado?folio=${encodeURIComponent(normalizedFolio)}&format=json&source=pdf-refresh`;
  console.log("pdf-refresh:render_start", { folio: normalizedFolio, renderUrl });

  try {
    const response = await fetch(renderUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folio: normalizedFolio, format: "json", source: "pdf-refresh" }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result?.ok) {
      throw new Error(result?.message || result?.error || `No se pudo generar el PDF oficial (HTTP ${response.status}).`);
    }

    const pdfUrl = sanitizePdfUrl(result?.pdfUrl || "");
    const fileId = String(result?.fileId || "").trim();
    const updatedAt = String(result?.updatedAt || nowIso()).trim();
    if (!pdfUrl && !fileId) {
      throw new Error("La generación del PDF oficial no devolvió pdfUrl o fileId.");
    }

    console.log("pdf-refresh:render_ok", { folio: normalizedFolio });
    console.log("pdf-refresh:drive_ok", { folio: normalizedFolio, fileId, pdfUrl });

    await updateApartadoPdfMetadata({
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
    });
    console.log("pdf-refresh:metadata_saved", { folio: normalizedFolio });

    const payloadResponse = {
      ok: true,
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
      message: "PDF oficial generado y guardado en Drive.",
    };
    console.log("pdf-refresh:done", { folio: normalizedFolio });
    return payloadResponse;
  } catch (error) {
    console.error("pdf-refresh:error", {
      folio: normalizedFolio,
      message: error?.message || "unknown error",
    });
    return {
      status: 500,
      body: {
        ok: false,
        message: error?.message || "No se pudo generar el PDF oficial.",
      },
    };
  }
}

export async function getApartadosMissingPdf(folio) {
  const normalizedFolio = normalize(folio);
  if (!normalizedFolio) {
    console.log("[apartados:missing-pdf] missing param folio");
    return { status: 400, body: { ok: false, message: "folio es obligatorio." } };
  }

  console.log(`[apartados:missing-pdf] folio recibido: ${normalizedFolio}`);
  const apartadosRows = await readApartadosRowsWithCache();
  const row = apartadosRows.find((apartado) => normalize(apartado?.Folio) === normalizedFolio);
  if (!row) {
    return { status: 404, body: { ok: false, message: "No se encontró el folio." } };
  }

  const pdfUrl = sanitizePdfUrl(row.PdfUrl || row.PDFUrl || row.pdfUrl || "");
  const pdfFileId = String(row.PdfFileId || row.pdfFileId || "").trim();
  return {
    ok: true,
    folio: String(row.Folio || "").trim(),
    missingPdf: !pdfUrl && !pdfFileId,
    pdfUrl,
    pdfFileId,
  };
}

export async function syncApartadoPdfByFolio(folio, payload = {}) {
  return regenerateApartadoPdf(folio, payload);
}

export async function cancelApartado(payload = {}) {
  return updateApartadoStatus({ ...payload, estado: 'CANCELADO' });
}

export async function getHistorialApartado(folio) {
  const detail = await getApartadoDetail(folio);
  if (detail?.status) return detail;
  return {
    ok: true,
    folio: detail?.apartado?.folio || String(folio || '').trim(),
    historial: Array.isArray(detail?.apartado?.historialAbonos) ? detail.apartado.historialAbonos : [],
  };
}

export async function searchApartados(params = {}) {
  const q = String(params.q || '').trim().toUpperCase();
  const listResult = await listApartados({ limit: Number.MAX_SAFE_INTEGER, page: 1 });
  const all = Array.isArray(listResult?.apartados) ? listResult.apartados : [];
  if (!q) return { ok: true, apartados: all };
  const filtered = all.filter((item) => (
    String(item?.folio || '').toUpperCase().includes(q)
      || String(item?.cliente || '').toUpperCase().includes(q)
      || String(item?.telefono || item?.contacto || '').toUpperCase().includes(q)
  ));
  return { ok: true, apartados: filtered };
}
