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
import { createTraceId, getErrorMessage, logError, logInfo, logWarn } from "../observability/logger.js";

const APARTADOS_LIST_CACHE_KEY = "apartados:list";
const APARTADOS_LIST_CACHE_TTL_MS = 60000;
const APARTADOS_ABONOS_CACHE_KEY = "apartados:abonos";
const APARTADOS_ABONOS_CACHE_TTL_MS = 20000;
const apartadosCache = new Map();

function normalize(value) { return String(value || "").trim().toUpperCase(); }
function normalizeFolioKey(value) { return normalize(value).replace(/[^A-Z0-9]/g, ""); }
function normalizeOperationId(value) {
  return String(value || "").trim();
}
function buildAppError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
function getAbonoSortTimestamp(row = {}) {
  const raw = String(row?.FechaCreacion || row?.Fecha || "").trim();
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  return 0;
}
function getLastAbonoSnapshot(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return [...rows].sort((a, b) => {
    const tsDiff = getAbonoSortTimestamp(b) - getAbonoSortTimestamp(a);
    if (tsDiff !== 0) return tsDiff;
    return Number(b?.__rowNumber || 0) - Number(a?.__rowNumber || 0);
  })[0] || null;
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

async function claimAbonoOperation({ sheets, spreadsheetId, folio, operationId }) {
  const folioKey = normalizeFolioKey(folio);
  const operationKey = normalizeOperationId(operationId);
  const claimId = `abono_claim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const claimedAt = nowIso();
  await appendSheetRow(
    sheets,
    spreadsheetId,
    "apartados_abonos_ops",
    buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos_ops, {
      ClaimedAt: claimedAt,
      Folio: folioKey,
      OperationId: operationKey,
      ClaimId: claimId,
    })
  );

  const opsRows = await readSheetRows(sheets, spreadsheetId, "apartados_abonos_ops");
  const sameOperationClaims = opsRows
    .filter((row) => (
      normalizeFolioKey(row.Folio) === folioKey
      && normalizeOperationId(row.OperationId) === operationKey
    ))
    .sort((a, b) => Number(a.__rowNumber || 0) - Number(b.__rowNumber || 0));

  const winnerClaim = sameOperationClaims[0] || null;
  const myClaim = sameOperationClaims.find((row) => String(row.ClaimId || "").trim() === claimId) || null;
  const won = Boolean(
    winnerClaim
    && myClaim
    && Number(winnerClaim.__rowNumber || 0) === Number(myClaim.__rowNumber || 0)
  );

  return { won, claimId, winnerClaim };
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
  const abonosFolio = abonosRows.filter((abono) => normalize(abono.Folio) === folioKey);
  const ultimoAbono = getLastAbonoSnapshot(abonosFolio);
  const saldoPendiente = ultimoAbono
    ? roundMoney(Math.max(0, roundMoney(ultimoAbono.SaldoNuevo)))
    : roundMoney(Math.max(0, roundMoney(apartado.Saldo ?? (total - roundMoney(apartado.Anticipo)))));
  const anticipo = ultimoAbono
    ? roundMoney(Math.max(0, total - saldoPendiente))
    : roundMoney(apartado.Anticipo);
  const statusFuente = String(apartado.Estado || "ACTIVO").trim().toUpperCase();
  const statusFinal = saldoPendiente <= 0 ? "LIQUIDADO" : statusFuente;

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
    saldoPendiente,
    historialAbonos,
    status: statusFinal,
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
  const anticipo = roundMoney(row?.AnticipoReconciliado ?? row?.Anticipo);
  const saldo = roundMoney(row?.SaldoReconciliado ?? row?.Saldo ?? Math.max(0, total - anticipo));
  const estatusFuente = String(row?.EstadoReconciliado || row?.estadoReconciliado || getStatusValue(row)).trim().toUpperCase();
  const estatus = saldo <= 0 ? "LIQUIDADO" : estatusFuente;
  return {
    folio,
    fecha,
    cliente,
    contacto,
    total,
    anticipo,
    saldo,
    estatus,
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

async function readAbonosRowsWithCache() {
  const now = Date.now();
  const cached = apartadosCache.get(APARTADOS_ABONOS_CACHE_KEY);
  if (cached && cached.expiresAt > now) {
    console.log("[apartados:abonos] cache hit");
    return cached.rows;
  }

  console.log("[apartados:abonos] cache miss");
  const { sheets, spreadsheetId } = await getContext();
  const rows = await readSheetRows(sheets, spreadsheetId, "apartados_abonos");
  console.log(`[apartados:abonos] rows loaded: ${rows.length}`);
  apartadosCache.set(APARTADOS_ABONOS_CACHE_KEY, {
    rows,
    expiresAt: now + APARTADOS_ABONOS_CACHE_TTL_MS,
  });
  return rows;
}

function invalidateApartadosListCache() {
  apartadosCache.delete(APARTADOS_LIST_CACHE_KEY);
  apartadosCache.delete(APARTADOS_ABONOS_CACHE_KEY);
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

  const [apartadosRows, abonosRows] = await Promise.all([
    readApartadosRowsWithCache(),
    readAbonosRowsWithCache(),
  ]);
  const abonosByFolio = new Map();
  abonosRows.forEach((row) => {
    const key = normalizeFolioKey(row?.Folio);
    if (!key) return;
    const current = abonosByFolio.get(key) || [];
    current.push(row);
    abonosByFolio.set(key, current);
  });

  const reconciledRows = apartadosRows.map((row) => {
    const folioKey = normalizeFolioKey(row?.Folio);
    const total = roundMoney(row?.Total);
    const ultimoAbono = getLastAbonoSnapshot(abonosByFolio.get(folioKey) || []);
    const saldoReal = ultimoAbono
      ? roundMoney(Math.max(0, roundMoney(ultimoAbono.SaldoNuevo)))
      : roundMoney(row?.Saldo ?? Math.max(0, total - roundMoney(row?.Anticipo)));
    const anticipoReal = ultimoAbono
      ? roundMoney(Math.max(0, total - saldoReal))
      : roundMoney(row?.Anticipo);
    const estadoPadre = getStatusValue(row);
    const estadoReal = saldoReal <= 0 ? "LIQUIDADO" : estadoPadre;
    return { ...row, Anticipo: anticipoReal, Saldo: saldoReal, Estado: estadoReal, AnticipoReconciliado: anticipoReal, SaldoReconciliado: saldoReal, EstadoReconciliado: estadoReal };
  });

  const filtered = reconciledRows
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

export async function getApartadoDetail(folio, options = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const shouldSyncPdf = Boolean(options?.syncPdf);
  const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
    readApartadosRowsWithCache(),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
    readAbonosRowsWithCache(),
  ]);

  const apartado = apartadosRows.find((row) => normalize(row.Folio) === normalize(folio));
  if (!apartado) return { status: 404, body: { ok: false, message: "No se encontró el folio." } };

  const detail = buildApartadoResponse(apartado, itemsRows, abonosRows);
  if (shouldSyncPdf) {
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
  }

  return { ok: true, apartado: detail, folio: detail.folio, fecha: detail.fecha, cliente: detail.cliente, contacto: detail.telefono, items: detail.productos, subtotal: detail.subtotal, anticipo: detail.anticipo, descuento: detail.descuento, total: detail.total };
}

export async function repairApartadoFromLastAbono(folio) {
  const normalizedFolio = normalize(folio);
  if (!normalizedFolio) {
    throw buildAppError("folio es obligatorio.", "INVALID_PAYLOAD");
  }
  const { sheets, spreadsheetId } = await getContext();
  const [apartadosHeaders, apartadosRows, abonosRows] = await Promise.all([
    getSheetHeaders(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);
  const apartado = apartadosRows.find((row) => normalize(row.Folio) === normalizedFolio);
  if (!apartado) throw buildAppError("No se encontró el folio.", "APARTADO_NOT_FOUND");

  const abonosFolio = abonosRows.filter((row) => normalize(row.Folio) === normalizedFolio);
  const ultimoAbono = getLastAbonoSnapshot(abonosFolio);
  if (!ultimoAbono) {
    return { ok: true, folio: normalizedFolio, repaired: false, reason: "NO_ABONOS" };
  }

  const total = roundMoney(apartado.Total);
  const saldoUltimo = roundMoney(Math.max(0, roundMoney(ultimoAbono.SaldoNuevo)));
  if (saldoUltimo > 0) {
    return { ok: true, folio: normalizedFolio, repaired: false, reason: "SALDO_PENDIENTE" };
  }

  const saldoPadre = roundMoney(apartado.Saldo);
  const estadoPadre = getStatusValue(apartado);
  if (saldoPadre <= 0 && estadoPadre === "LIQUIDADO") {
    return { ok: true, folio: normalizedFolio, repaired: false, reason: "ALREADY_SYNCED" };
  }

  const now = nowIso();
  const updated = buildRowByTargetHeaders(apartado, apartadosHeaders, {
    Anticipo: total,
    Saldo: 0,
    Estado: "LIQUIDADO",
    UltimoMovimiento: now,
  });
  await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updated);
  invalidateApartadosListCache();

  return { ok: true, folio: normalizedFolio, repaired: true, anticipo: total, saldo: 0, estado: "LIQUIDADO", ultimoMovimiento: now };
}

export async function addAbono(payload = {}) {
  async function markAbonoOperationState({ sheets, spreadsheetId, operationId, state, comment, abonosHeaders, abonosRows }) {
    if (!operationId) return;
    const row = (abonosRows || []).find((item) => String(item.OperationId || "").trim() === operationId);
    if (!row) return;
    const updated = buildRowByTargetHeaders(row, abonosHeaders || SHEET_HEADERS.apartados_abonos, {
      EstadoOperacion: state,
      Comentario: row.Comentario,
    });
    if (comment) {
      logInfo("apartados.abono.comment_ignored", {
        action: "apartados",
        op: "abono",
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
  const traceId = createTraceId(payload.traceId || payload.requestId);
  const operationId = normalizeOperationId(payload.operationId || payload.requestId || randomUUID());
  const now = nowIso();
  const logCtx = { action: "apartados", op: "abono", folio, operationId, traceId };
  logInfo("apartados.abono.start", logCtx);

  if (!folio || !operationId || montoAbono <= 0) {
    logWarn("apartados.abono.invalid_payload", { ...logCtx, errorCode: "INVALID_PAYLOAD" });
    throw buildAppError("Para abono ingresa Folio, operationId y un monto mayor a 0.", "INVALID_PAYLOAD");
  }

  logInfo("apartados.abono.validated", { ...logCtx, montoAbono, metodo, fecha });

  const [apartadosHeaders, abonosHeaders, apartadosRows, abonosRows] = await Promise.all([
    getSheetHeaders(sheets, spreadsheetId, "apartados"),
    getSheetHeaders(sheets, spreadsheetId, "apartados_abonos"),
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  const claim = await claimAbonoOperation({ sheets, spreadsheetId, folio, operationId });
  const existingAbono = abonosRows.find((row) => (
    normalizeFolioKey(row.Folio) === normalizeFolioKey(folio)
    && normalizeOperationId(row.OperationId) === normalizeOperationId(operationId)
  ));
  if (!claim.won) {
    const duplicatedAbono = existingAbono || (await readSheetRows(sheets, spreadsheetId, "apartados_abonos"))
      .find((row) => (
        normalizeFolioKey(row.Folio) === normalizeFolioKey(folio)
        && normalizeOperationId(row.OperationId) === normalizeOperationId(operationId)
      ));
    if (duplicatedAbono) {
      const folioRegistrado = normalize(duplicatedAbono.Folio) || folio;
      const apartadoExistente = apartadosRows.find((row) => normalize(row.Folio) === folioRegistrado);
      const folioRegistradoKey = normalizeFolioKey(folioRegistrado);
      const abonosFolioReal = abonosRows.filter((row) => normalizeFolioKey(row.Folio) === folioRegistradoKey);
      const totalAbonadoHistorico = sumAbonos(abonosFolioReal);
      const totalAbonadoReal = roundMoney(Math.max(roundMoney(apartadoExistente?.Anticipo), totalAbonadoHistorico));
      const resumen = apartadoExistente
        ? buildApartadoResumen(apartadoExistente, totalAbonadoReal)
        : { subtotal: 0, anticipo: totalAbonadoReal, descVal: 0, total: totalAbonadoReal, saldo: 0, estado: "ACTIVO" };
      logInfo("apartados.abono.duplicated_claim_lost", { ...logCtx, result: "success", claimId: claim.claimId });
      return {
        ok: true,
        folio: folioRegistrado,
        ticketUrl: buildTicketUrl(folioRegistrado),
        duplicated: true,
        idempotent: true,
        partial: false,
        code: "ABONO_DUPLICATED",
        traceId,
        resumen,
        message: "Este abono ya había sido procesado previamente; se devuelve el estado actual.",
      };
    }
    throw buildAppError("La operación está en proceso, intenta nuevamente.", "ABONO_OPERATION_IN_PROGRESS");
  }

  if (existingAbono) {
    const estadoOperacion = String(existingAbono.EstadoOperacion || "").trim().toUpperCase();
    const folioRegistrado = normalize(existingAbono.Folio) || folio;
    const apartadoExistente = apartadosRows.find((row) => normalize(row.Folio) === folioRegistrado);
    const folioRegistradoKey = normalizeFolioKey(folioRegistrado);
    const abonosFolioReal = abonosRows.filter((row) => normalizeFolioKey(row.Folio) === folioRegistradoKey);
    const totalAbonadoHistorico = sumAbonos(abonosFolioReal);
    const totalAbonadoReal = roundMoney(Math.max(roundMoney(apartadoExistente?.Anticipo), totalAbonadoHistorico));
    const resumen = apartadoExistente
      ? buildApartadoResumen(apartadoExistente, totalAbonadoReal)
      : {
        subtotal: 0, anticipo: totalAbonadoReal, descVal: 0, total: totalAbonadoReal, saldo: 0, estado: "ACTIVO",
      };
    logInfo("apartados.abono.duplicated", { ...logCtx, estadoOperacion, result: "success", errorCode: "ABONO_DUPLICATED" });
    return {
      ok: true,
      folio: folioRegistrado,
      ticketUrl: buildTicketUrl(folioRegistrado),
      duplicated: true,
      idempotent: true,
      partial: false,
      code: "ABONO_DUPLICATED",
      traceId,
      resumen,
      message: "Este abono ya había sido procesado previamente; se devuelve el estado actual.",
    };
  }

  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
  logInfo("apartados.abono.apartado_lookup", { ...logCtx, found: Boolean(apartado) });
  if (!apartado) {
    logWarn("apartados.abono.not_found", { ...logCtx, errorCode: "APARTADO_NOT_FOUND" });
    throw buildAppError("No se encontró el folio.", "APARTADO_NOT_FOUND");
  }

  const total = roundMoney(apartado.Total);
  const folioKey = normalizeFolioKey(folio);
  const abonosFolio = abonosRows.filter((row) => normalizeFolioKey(row.Folio) === folioKey);
  const totalAbonadoHistorico = sumAbonos(abonosFolio);
  const ultimoAbono = getLastAbonoSnapshot(abonosFolio);
  const totalAbonadoActual = ultimoAbono
    ? roundMoney(Math.max(0, total - roundMoney(ultimoAbono.SaldoNuevo)))
    : roundMoney(apartado.Anticipo);
  const saldoAnterior = roundMoney(Math.max(0, total - totalAbonadoActual));
  if (saldoAnterior <= 0) {
    throw new Error("El apartado ya está liquidado.");
  }
  if (montoAbono > saldoAnterior) {
    logWarn("apartados.abono.inconsistent", { ...logCtx, stage: "validate_amount", errorCode: "ABONO_INCONSISTENT", montoAbono, saldoAnterior });
    throw buildAppError("El abono no puede ser mayor al saldo pendiente.", "ABONO_INCONSISTENT");
  }

  const nuevoTotalAbonado = roundMoney(totalAbonadoActual + montoAbono);
  let nuevoSaldo = roundMoney(total - nuevoTotalAbonado);
  let nuevoEstado = "ACTIVO";
  if (nuevoSaldo <= 0) {
    nuevoSaldo = 0;
    nuevoEstado = "LIQUIDADO";
  }
  const estadoResultante = nuevoSaldo <= 0 ? "LIQUIDADO" : nuevoEstado;
  logInfo("apartados.abono.parent_updated", {
    ...logCtx,
    total,
    totalAbonadoHistorico,
    totalAbonadoActual,
    nuevoTotalAbonado,
    saldoAnterior,
    nuevoSaldo,
    nuevoEstado,
  });

  const abonoRow = buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
    Folio: folio,
    Fecha: fecha,
    Monto: montoAbono,
    Metodo: metodo,
    Comentario: referencia || "Abono registrado desde formulario",
    Referencia: referencia,
    SaldoAnterior: saldoAnterior,
    SaldoNuevo: nuevoSaldo,
    EstadoResultante: estadoResultante,
    OperationId: operationId,
    EstadoOperacion: "PENDIENTE_APARTADO",
    FechaCreacion: now,
  });

  logInfo("apartados.abono.history_start", logCtx);
  await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", abonoRow);
  abonosRows.push({
    __rowNumber: abonosRows.length + 2,
    Folio: folio,
    Fecha: fecha,
    Monto: montoAbono,
    Metodo: metodo,
    Comentario: referencia || "Abono registrado desde formulario",
    Referencia: referencia,
    SaldoAnterior: saldoAnterior,
    SaldoNuevo: nuevoSaldo,
    EstadoResultante: estadoResultante,
    OperationId: operationId,
    EstadoOperacion: "PENDIENTE_APARTADO",
    FechaCreacion: now,
  });
  logInfo("apartados.abono.history_saved", logCtx);

  try {
    const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, {
      Anticipo: nuevoTotalAbonado,
      Saldo: nuevoSaldo,
      Estado: nuevoEstado,
      UltimoMovimiento: now,
    });
    logInfo("apartados.abono.parent_update_start", logCtx);
    await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
    logInfo("apartados.abono.parent_updated", logCtx);
  } catch (updateError) {
    logError("apartados.abono.inconsistent", {
      ...logCtx,
      fecha,
      montoAbono,
      stage: "parent_update",
      errorCode: "ABONO_INCONSISTENT",
      message: getErrorMessage(updateError),
    });
    try {
      await markAbonoOperationState({
        sheets,
        spreadsheetId,
        operationId,
        state: "INCONSISTENTE_APARTADO_NO_ACTUALIZADO",
        comment: `INCONSISTENTE: ${updateError?.message || "fallo actualización apartado padre"}`,
        abonosHeaders,
        abonosRows,
      });
    } catch (markError) {
      logError("apartados.abono.mark_inconsistent_failed", {
        ...logCtx,
        message: getErrorMessage(markError),
      });
    }
    throw buildAppError(`Se registró historial pero falló la actualización del apartado. operationId=${operationId}`, "ABONO_INCONSISTENT");
  }

  try {
    logInfo("apartados.abono.mark_ok_start", logCtx);
    await markAbonoOperationState({
      sheets,
      spreadsheetId,
      operationId,
      state: "OK",
      comment: referencia || "Abono confirmado",
      abonosHeaders,
      abonosRows,
    });
    logInfo("apartados.abono.mark_ok_done", logCtx);
  } catch (markOkError) {
    logWarn("apartados.abono.mark_ok_failed", {
      ...logCtx,
      message: getErrorMessage(markOkError),
    });
  }

  invalidateApartadosListCache();

  let pdfSync = null;
  let pdfError = "";
  try {
    logInfo("apartados.abono.pdf_start", logCtx);
    pdfSync = await syncApartadoPdf({
      folio,
      reason: "abono",
      apartado: {
        traceId,
        folio,
        anticipo: nuevoTotalAbonado,
        saldoPendiente: nuevoSaldo,
        status: nuevoEstado,
      },
    });
    if (pdfSync?.ok && pdfSync?.pdfUrl) {
      await updateApartadoPdfMetadata({ folio, pdfUrl: pdfSync.pdfUrl, fileId: pdfSync.fileId, updatedAt: pdfSync.updatedAt });
    }
    logInfo("apartados.abono.pdf_success", logCtx);
  } catch (error) {
    pdfError = getErrorMessage(error) || "No se pudo generar el ticket/PDF.";
    logWarn("apartados.abono.pdf_failed", { ...logCtx, result: "partial", message: pdfError });
  }

  logInfo(pdfError ? "apartados.abono.partial" : "apartados.abono.success", { ...logCtx, result: pdfError ? "partial" : "success" });
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
    traceId,
    duplicated: false,
    partial: Boolean(pdfError),
    ...(pdfError ? { code: "PDF_PROXY_FAILED" } : {}),
    resumen,
    message: pdfError
      ? "Abono registrado correctamente, pero no se pudo generar el ticket."
      : "Abono registrado y ticket generado correctamente",
    pdfError,
  };
}

export async function createApartado(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const traceId = createTraceId(payload.traceId);
  const requestedFolio = normalize(payload.folio);
  const fecha = String(payload.fecha || "").trim();
  const cliente = String(payload.cliente || "").trim();
  const contacto = String(payload.contacto || "").trim();
  const anticipo = roundMoney(payload.anticipo);
  if (anticipo < 0) throw new Error("El anticipo no puede ser negativo.");
  if (!fecha || !cliente || !contacto) throw buildAppError("Completa los campos obligatorios para registrar el apartado.", "INVALID_PAYLOAD");

  const codigos = String(payload.codigos || "").split(",").map((code) => code.trim()).filter(Boolean);
  if (!codigos.length) throw buildAppError("Debes ingresar al menos un código.", "INVALID_PAYLOAD");
  logInfo("apartados.create.start", { action: "apartados", op: "create", traceId, folio: requestedFolio || "AUTO" });

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
  if (missingCodes.length) throw buildAppError(`No se encontraron estos códigos: ${missingCodes.join(", ")}`, "INVALID_PAYLOAD");

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

  const pdfSync = await syncApartadoPdf({ folio, reason: "create", apartado: { traceId, folio, cliente, contacto, fecha, subtotal, anticipo, descuento: descuentoMXN, total, saldoPendiente: saldo, status: estado } });
  if (pdfSync?.ok && pdfSync?.pdfUrl) {
    await updateApartadoPdfMetadata({ folio, pdfUrl: pdfSync.pdfUrl, fileId: pdfSync.fileId, updatedAt: pdfSync.updatedAt });
  }
  if (!pdfSync?.ok) {
    logWarn("apartados.create.partial", {
      action: "apartados",
      op: "create",
      traceId,
      folio,
      result: "partial",
      message: String(pdfSync?.details || pdfSync?.error || "pdf not available"),
    });
  } else {
    logInfo("apartados.create.success", { action: "apartados", op: "create", traceId, folio, result: "success" });
  }
  invalidateApartadosListCache();
  return { ok: true, folio, traceId, ticketUrl: buildTicketUrl(folio), pdfDriveUrl: pdfSync?.pdfUrl || "", partial: !pdfSync?.ok };
}

export async function updateApartadoStatus(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const traceId = createTraceId(payload.traceId);
  const folio = normalize(payload.folio);
  const estado = String(payload.estado || payload.status || "").trim().toUpperCase();
  if (!folio || !estado) throw buildAppError("Folio y estado son obligatorios.", "INVALID_PAYLOAD");
  logInfo("apartados.update_status.start", { action: "apartados", op: "update-status", folio, traceId, stage: "validate" });

  const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
  if (!apartado) return { status: 404, body: { ok: false, code: "APARTADO_NOT_FOUND", message: "No se encontró el folio.", traceId } };

  const now = nowIso();
  const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, { Estado: estado, UltimoMovimiento: now });
  await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
  await syncApartadoPdf({ folio, reason: "status-update", apartado: { traceId, folio, status: estado } });
  logInfo("apartados.update_status.success", { action: "apartados", op: "update-status", folio, traceId, result: "success" });
  invalidateApartadosListCache();
  return { ok: true, folio, status: estado, traceId };
}

export async function regenerateApartadoPdf(folio, payload = {}) {
  const normalizedFolio = normalize(folio);
  const traceId = createTraceId(payload.traceId);
  if (!normalizedFolio) {
    return { status: 400, body: { ok: false, code: "INVALID_PAYLOAD", traceId, message: "folio es obligatorio." } };
  }
  const webAppUrl = String(payload?.webAppUrl || getApartadosPdfWebAppUrl()).trim();
  if (!webAppUrl) {
    return {
      status: 500,
      body: { ok: false, code: "ADMIN_TEMP_UNAVAILABLE", traceId, message: "Falta HARUJA_APARTADOS_PDF_WEBAPP_URL para generar el PDF oficial mediante Apps Script." },
    };
  }

  logInfo("apartados.pdf_refresh.start", { action: "apartados", op: "pdf-refresh", folio: normalizedFolio, traceId });

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

    logInfo("apartados.pdf_refresh.apps_script_ok", { action: "apartados", op: "pdf-refresh", folio: normalizedFolio, traceId, fileId });

    await updateApartadoPdfMetadata({
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
    });
    logInfo("apartados.pdf_refresh.metadata_saved", { action: "apartados", op: "pdf-refresh", folio: normalizedFolio, traceId });

    const payloadResponse = {
      ok: true,
      folio: normalizedFolio,
      pdfUrl,
      fileId,
      updatedAt,
      hasOfficialPdf: true,
      message: "PDF oficial generado y guardado en Drive.",
    };
    logInfo("apartados.pdf_refresh.success", { action: "apartados", op: "pdf-refresh", folio: normalizedFolio, traceId, result: "success" });
    return payloadResponse;
  } catch (error) {
    logError("apartados.pdf_refresh.failed", {
      action: "apartados",
      op: "pdf-refresh",
      folio: normalizedFolio,
      traceId,
      errorCode: "PDF_PROXY_FAILED",
      message: getErrorMessage(error),
    });
    return {
      status: 500,
      body: {
        ok: false,
        code: "PDF_PROXY_FAILED",
        traceId,
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
  const traceId = createTraceId(payload.traceId);
  logInfo("apartados.cancel.start", { action: "apartados", op: "cancel", folio: normalize(payload.folio), traceId });
  return updateApartadoStatus({ ...payload, traceId, estado: 'CANCELADO' });
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
