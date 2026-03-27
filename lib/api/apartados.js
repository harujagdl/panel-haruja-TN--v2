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
import { randomUUID } from "node:crypto";

const APARTADOS_LIST_CACHE_KEY = "apartados:list";
const APARTADOS_LIST_CACHE_TTL_MS = 60000;
const apartadosCache = new Map();

function normalize(value) { return String(value || "").trim().toUpperCase(); }
function normalizeOperationId(value) {
  return String(value || "").trim();
}
function parseDateOrThrow(value, fieldName = "fecha") {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(`${fieldName} es obligatoria.`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${fieldName} inválida.`);
  return raw;
}
function parseAbonoMethod(value) {
  const raw = String(value || "").trim().toUpperCase();
  const validMethods = new Set(["EFECTIVO", "TRANSFERENCIA", "TARJETA", "DEPOSITO", "OTRO"]);
  if (!raw) return "EFECTIVO";
  if (!validMethods.has(raw)) throw new Error("Método de pago inválido.");
  return raw;
}
function sumAbonos(rows = []) {
  return roundMoney(rows.reduce((acc, row) => acc + roundMoney(row?.Monto), 0));
}
function buildApartadoResumen(apartado = {}, totalAbonado = 0) {
  const subtotal = roundMoney(apartado?.Subtotal);
  const descVal = roundMoney(apartado?.DescuentoMXN);
  const total = roundMoney(apartado?.Total);
  const anticipo = roundMoney(totalAbonado);
  const saldo = roundMoney(Math.max(0, total - anticipo));
  const estado = String(saldo <= 0 ? "LIQUIDADO" : (apartado?.Estado || "ACTIVO")).trim().toUpperCase();
  return { subtotal, anticipo, descVal, total, saldo, estado };
}
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

function getApartadosPdfWebAppUrl() {
  return String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || "").trim().replace(/\/$/, "");
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
    codigo: String(item.Codigo || "").trim(), descripcion: String(item.Descripcion || "").trim(), tipo: String(item.Tipo || "").trim(), color: String(item.Color || "").trim(), talla: String(item.Talla || "").trim(), precio: roundMoney(item.Precio)
  }));

  const historialAbonos = abonosRows.filter((abono) => normalize(abono.Folio) === folioKey).map((abono) => ({
    fecha: String(abono.Fecha || "").trim(),
    monto: roundMoney(abono.Monto),
    metodo: String(abono.Metodo || "").trim(),
    comentario: String(abono.Comentario || "").trim(),
    referencia: String(abono.Referencia || "").trim(),
  })).sort((a, b) => Date.parse(b.fecha || "") - Date.parse(a.fecha || ""));

  const total = roundMoney(apartado.Total);
  const anticipoHistorico = sumAbonos(abonosRows.filter((abono) => normalize(abono.Folio) === folioKey));
  const anticipo = anticipoHistorico > 0 ? anticipoHistorico : roundMoney(apartado.Anticipo);

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
    detail.pdfUpdatedAt = String(pdfSync.updatedAt || detail.pdfUpdatedAt || "").trim();
    detail.hasOfficialPdf = true;
    await updateApartadoPdfMetadata({
      folio: detail.folio,
      pdfUrl: detail.pdfDriveUrl,
      fileId: String(pdfSync.fileId || "").trim(),
      updatedAt: detail.pdfUpdatedAt,
    });
  }

  return { ok: true, apartado: detail, folio: detail.folio, fecha: detail.fecha, cliente: detail.cliente, contacto: detail.telefono, items: detail.productos, subtotal: detail.subtotal, anticipo: detail.anticipo, descuento: detail.descuento, total: detail.total };
}

export async function addAbono(payload = {}) {
  async function markAbonoOperationState({ sheets, spreadsheetId, operationId, state, comment }) {
    if (!operationId) return;
    const headers = await getSheetHeaders(sheets, spreadsheetId, "apartados_abonos");
    const rows = await readSheetRows(sheets, spreadsheetId, "apartados_abonos");
    const row = rows.find((item) => String(item.OperationId || "").trim() === operationId);
    if (!row) return;
    const updated = buildRowByTargetHeaders(row, headers, {
      EstadoOperacion: state,
      Comentario: row.Comentario,
    });
    if (comment) {
      console.log("[apartados:abono] markAbonoOperationState:comment_ignored", {
        folio: String(row.Folio || "").trim(),
        operationId,
        state,
      });
    }
    await updateSheetRow(sheets, spreadsheetId, "apartados_abonos", row.__rowNumber, updated);
  }

  const { sheets, spreadsheetId } = await getContext();
  const fecha = parseDateOrThrow(payload.fecha || nowIso().slice(0, 10));
  const folio = normalize(payload.folio);
  const montoAbono = roundMoney(payload.anticipo ?? payload.abono ?? payload.monto);
  const metodo = parseAbonoMethod(payload.metodoPago || payload.metodo || "EFECTIVO");
  const referencia = String(payload.referencia || payload.nota || payload.comentario || "").trim();
  const operationId = normalizeOperationId(payload.operationId || payload.requestId || randomUUID());
  const now = nowIso();
  const logCtx = { folio, operationId };
  console.log("[apartados:abono] registrarAbonoSeguro:start", logCtx);

  if (!folio || !operationId || montoAbono <= 0) {
    throw new Error("Para abono ingresa Folio, operationId y un monto mayor a 0.");
  }

  console.log("[apartados:abono] registrarAbonoSeguro:validaciones_ok", { ...logCtx, montoAbono, metodo, fecha });

  const [apartadosHeaders, apartadosRows, abonosRows] = await Promise.all([
    getSheetHeaders(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  const existingAbono = abonosRows.find((row) => String(row.OperationId || "").trim() === operationId);
  if (existingAbono) {
    const estadoOperacion = String(existingAbono.EstadoOperacion || "").trim().toUpperCase();
    const folioRegistrado = normalize(existingAbono.Folio) || folio;
    const apartadoExistente = apartadosRows.find((row) => normalize(row.Folio) === folioRegistrado);
    const abonosFolioReal = abonosRows.filter((row) => normalize(row.Folio) === folioRegistrado);
    const totalAbonadoReal = sumAbonos(abonosFolioReal);
    const resumen = apartadoExistente
      ? buildApartadoResumen(apartadoExistente, totalAbonadoReal)
      : {
        subtotal: 0, anticipo: totalAbonadoReal, descVal: 0, total: totalAbonadoReal, saldo: 0, estado: "ACTIVO",
      };
    console.log("[apartados:abono] registrarAbonoSeguro:idempotent_hit", { ...logCtx, estadoOperacion });
    return {
      ok: true,
      folio: folioRegistrado,
      ticketUrl: buildTicketUrl(folioRegistrado),
      duplicated: true,
      idempotent: true,
      partial: false,
      resumen,
      message: "Este abono ya había sido procesado previamente; se devuelve el estado actual.",
    };
  }

  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
  console.log("[apartados:abono] registrarAbonoSeguro:apartado_leido", { ...logCtx, found: Boolean(apartado) });
  if (!apartado) throw new Error("No se encontró el folio.");

  const total = roundMoney(apartado.Total);
  const abonosFolio = abonosRows.filter((row) => normalize(row.Folio) === folio);
  const totalAbonadoActual = sumAbonos(abonosFolio);
  const saldoAnterior = roundMoney(Math.max(0, total - totalAbonadoActual));
  if (saldoAnterior <= 0) {
    throw new Error("El apartado ya está liquidado.");
  }
  if (montoAbono > saldoAnterior) {
    throw new Error("El abono no puede ser mayor al saldo pendiente.");
  }

  const nuevoTotalAbonado = roundMoney(totalAbonadoActual + montoAbono);
  const nuevoSaldo = roundMoney(Math.max(0, total - nuevoTotalAbonado));
  if (nuevoSaldo < 0) throw new Error("El saldo pendiente no puede ser negativo.");
  const nuevoEstado = nuevoSaldo <= 0 ? "LIQUIDADO" : "ACTIVO";
  console.log("[apartados:abono] registrarAbonoSeguro:calculo_ok", { ...logCtx, total, totalAbonadoActual, nuevoTotalAbonado, saldoAnterior, nuevoSaldo, nuevoEstado });

  const abonoRow = buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
    Folio: folio,
    Fecha: fecha,
    Monto: montoAbono,
    Metodo: metodo,
    Comentario: referencia || "Abono registrado desde formulario",
    Referencia: referencia,
    SaldoAnterior: saldoAnterior,
    SaldoNuevo: nuevoSaldo,
    EstadoResultante: nuevoEstado,
    OperationId: operationId,
    EstadoOperacion: "PENDIENTE_APARTADO",
    FechaCreacion: now,
  });

  console.log("[apartados:abono] registrarAbonoSeguro:historial_append_start", logCtx);
  await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", abonoRow);
  console.log("[apartados:abono] registrarAbonoSeguro:historial_append_ok", logCtx);

  try {
    const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, {
      Anticipo: nuevoTotalAbonado,
      Saldo: nuevoSaldo,
      Estado: nuevoEstado,
      UltimoMovimiento: now,
    });
    console.log("[apartados:abono] registrarAbonoSeguro:apartado_update_start", logCtx);
    await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
    console.log("[apartados:abono] registrarAbonoSeguro:apartado_update_ok", logCtx);
  } catch (updateError) {
    console.error("[apartados:abono] registrarAbonoSeguro:apartado_update_error", {
      ...logCtx,
      fecha,
      montoAbono,
      message: updateError?.message || "unknown",
    });
    try {
      await markAbonoOperationState({
        sheets,
        spreadsheetId,
        operationId,
        state: "INCONSISTENTE_APARTADO_NO_ACTUALIZADO",
        comment: `INCONSISTENTE: ${updateError?.message || "fallo actualización apartado padre"}`,
      });
    } catch (markError) {
      console.error("[apartados:abono] registrarAbonoSeguro:mark_inconsistente_error", {
        ...logCtx,
        message: markError?.message || "unknown",
      });
    }
    throw new Error(`Se registró historial pero falló la actualización del apartado. operationId=${operationId}`);
  }

  try {
    console.log("[apartados:abono] registrarAbonoSeguro:mark_ok_start", logCtx);
    await markAbonoOperationState({
      sheets,
      spreadsheetId,
      operationId,
      state: "OK",
      comment: referencia || "Abono confirmado",
    });
    console.log("[apartados:abono] registrarAbonoSeguro:mark_ok_done", logCtx);
  } catch (markOkError) {
    console.error("[apartados:abono] registrarAbonoSeguro:mark_ok_error", {
      ...logCtx,
      message: markOkError?.message || "unknown",
    });
  }

  invalidateApartadosListCache();

  let pdfSync = null;
  let pdfError = "";
  try {
    console.log("[apartados:abono] registrarAbonoSeguro:pdf_start", logCtx);
    pdfSync = await syncApartadoPdf({
      folio,
      reason: "abono",
      apartado: {
        folio,
        anticipo: nuevoTotalAbonado,
        saldoPendiente: nuevoSaldo,
        status: nuevoEstado,
      },
    });
    if (pdfSync?.ok && pdfSync?.pdfUrl) {
      await updateApartadoPdfMetadata({ folio, pdfUrl: pdfSync.pdfUrl, fileId: pdfSync.fileId, updatedAt: pdfSync.updatedAt });
    }
    console.log("[apartados:abono] registrarAbonoSeguro:pdf_ok", logCtx);
  } catch (error) {
    pdfError = error?.message || "No se pudo generar el ticket/PDF.";
    console.error("[apartados:abono] registrarAbonoSeguro:pdf_error", { ...logCtx, message: pdfError });
  }

  console.log("[apartados:abono] registrarAbonoSeguro:done", { ...logCtx, partial: Boolean(pdfError) });
  const resumen = buildApartadoResumen({
    ...apartado,
    Anticipo: nuevoTotalAbonado,
    Saldo: nuevoSaldo,
    Estado: nuevoEstado,
  }, nuevoTotalAbonado);
  return {
    ok: true,
    folio,
    ticketUrl: buildTicketUrl(folio),
    pdfDriveUrl: pdfSync?.pdfUrl || "",
    operationId,
    duplicated: false,
    partial: Boolean(pdfError),
    resumen,
    message: pdfError
      ? "Abono registrado correctamente, pero no se pudo generar el ticket."
      : "Abono registrado y ticket generado correctamente",
    pdfError,
  };
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
    await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
      Folio: folio,
      Fecha: fecha,
      Monto: anticipo,
      Metodo: "EFECTIVO",
      Comentario: "Anticipo inicial",
      Referencia: "",
      SaldoAnterior: total,
      SaldoNuevo: saldo,
      EstadoResultante: estado,
      OperationId: "",
      EstadoOperacion: "OK",
      FechaCreacion: now,
    }));
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
  const webAppUrl = String(payload?.webAppUrl || getApartadosPdfWebAppUrl()).trim();
  if (!webAppUrl) {
    return {
      status: 500,
      body: { ok: false, message: "Falta HARUJA_APARTADOS_PDF_WEBAPP_URL para generar el PDF oficial mediante Apps Script." },
    };
  }

  console.log("pdf_generate:start", { folio: normalizedFolio, webAppUrl });

  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "generar_pdf_apartado", folio: normalizedFolio }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result?.ok) {
      throw new Error(result?.details || result?.message || result?.error || `No se pudo generar el PDF oficial (HTTP ${response.status}).`);
    }

    const pdfUrl = sanitizePdfUrl(result?.pdfUrl || "");
    const fileId = String(result?.fileId || "").trim();
    const updatedAt = String(result?.updatedAt || nowIso()).trim();
    if (!pdfUrl || !fileId) {
      throw new Error("La generación del PDF oficial no devolvió metadata válida (pdfUrl y fileId).");
    }

    console.log("pdf_generate:sheet_ok", { folio: normalizedFolio });
    console.log("pdf_generate:file_created", { folio: normalizedFolio, fileId, pdfUrl });

    await updateApartadoPdfMetadata({
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
    });
    console.log("pdf_generate:metadata_saved", { folio: normalizedFolio });

    const payloadResponse = {
      ok: true,
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
      message: "PDF oficial generado y guardado en Drive.",
    };
    console.log("pdf_generate:done", { folio: normalizedFolio });
    return payloadResponse;
  } catch (error) {
    console.error("pdf_generate:error", {
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
