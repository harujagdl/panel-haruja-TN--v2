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
import { getApartadoPdf, refreshApartadoPdf, syncApartadoPdf } from "../apartados/pdf-sync.js";

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
    pdfUrl: `/ticket/${encodeURIComponent(folio)}`,
  };
}

async function getContext() {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();
  await ensureSheetsSetup(sheets, spreadsheetId);
  return { sheets, spreadsheetId };
}

export async function getNextFolio() {
  const { sheets, spreadsheetId } = await getContext();
  const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
  const seqs = apartadosRows.map((row) => String(row.Folio || "").trim().toUpperCase()).map((folio) => {
    const match = /^HARUJA\s*(\d+)$/i.exec(folio);
    return match ? Number.parseInt(match[1], 10) : 0;
  }).filter((value) => Number.isFinite(value));
  const maxSeq = seqs.length ? Math.max(...seqs) : 0;
  return { ok: true, folio: `HARUJA${String(maxSeq + 1).padStart(4, "0")}` };
}

export async function listApartados() {
  const { sheets, spreadsheetId } = await getContext();
  const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  const apartados = apartadosRows.map((row) => buildApartadoResponse(row, itemsRows, abonosRows)).sort((a, b) => Date.parse(b.fecha || "") - Date.parse(a.fecha || ""));
  return { ok: true, apartados };
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
  if (pdfSync?.ok && pdfSync.pdfUrl) detail.pdfDriveUrl = pdfSync.pdfUrl;

  return { ok: true, apartado: detail, folio: detail.folio, fecha: detail.fecha, cliente: detail.cliente, contacto: detail.telefono, items: detail.productos, subtotal: detail.subtotal, anticipo: detail.anticipo, descuento: detail.descuento, total: detail.total };
}

export async function addAbono(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const folio = normalize(payload.folio);
  const fecha = String(payload.fecha || "").trim();
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
  return { ok: true, folio, ticketUrl: `/ticket/${encodeURIComponent(folio)}`, pdfDriveUrl: pdfSync?.pdfUrl || "" };
}

export async function createApartado(payload = {}) {
  const { sheets, spreadsheetId } = await getContext();
  const folio = normalize(payload.folio);
  const fecha = String(payload.fecha || "").trim();
  const cliente = String(payload.cliente || "").trim();
  const contacto = String(payload.contacto || "").trim();
  const anticipo = roundMoney(payload.anticipo);
  if (anticipo < 0) throw new Error("El anticipo no puede ser negativo.");
  if (!fecha || !cliente || !contacto || !folio) throw new Error("Completa los campos obligatorios para registrar el apartado.");

  const codigos = String(payload.codigos || "").split(",").map((code) => code.trim()).filter(Boolean);
  if (!codigos.length) throw new Error("Debes ingresar al menos un código.");

  const now = nowIso();
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

  await appendSheetRow(sheets, spreadsheetId, "apartados", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados, { Folio: folio, Fecha: fecha, Cliente: cliente, Contacto: contacto, Subtotal: subtotal, DescuentoTipo: descuentoTipo, DescuentoValor: descuentoValor, DescuentoMXN: descuentoMXN, Total: total, Anticipo: anticipo, Saldo: saldo, Estado: estado, FechaCreacion: now, UltimoMovimiento: now, PdfUrl: `/ticket/${encodeURIComponent(folio)}` }));
  for (const item of items) {
    await appendSheetRow(sheets, spreadsheetId, "apartados_items", buildRowByTargetHeaders(item, SHEET_HEADERS.apartados_items));
  }
  if (anticipo > 0) {
    await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, { Folio: folio, Fecha: fecha, Monto: anticipo, Metodo: "EFECTIVO", Comentario: "Anticipo inicial", FechaCreacion: now }));
  }

  const pdfSync = await syncApartadoPdf({ folio, reason: "create", apartado: { folio, cliente, contacto, fecha, subtotal, anticipo, descuento: descuentoMXN, total, saldoPendiente: saldo, status: estado } });
  return { ok: true, folio, ticketUrl: `/ticket/${encodeURIComponent(folio)}`, pdfDriveUrl: pdfSync?.pdfUrl || "" };
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
  return { ok: true, folio, status: estado };
}

export async function syncApartadoPdfByFolio(folio, payload = {}) {
  const result = await refreshApartadoPdf({ folio, apartado: payload.apartado || null, reason: payload.reason || "manual_refresh" });
  if (!result?.ok) {
    if (result?.skipped) return { ok: true, folio, exists: false, pdfUrl: "", updatedAt: "", skipped: true };
    return { status: 502, body: { ok: false, folio, message: result?.error || "No se pudo actualizar el PDF." } };
  }
  return { ok: true, folio, exists: Boolean(result?.exists), pdfUrl: result?.pdfUrl || "", updatedAt: result?.updatedAt || "", fileId: result?.fileId || "", fileName: result?.fileName || "", replaced: Boolean(result?.replaced) };
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
  const listResult = await listApartados();
  const all = Array.isArray(listResult?.apartados) ? listResult.apartados : [];
  if (!q) return { ok: true, apartados: all };
  const filtered = all.filter((item) => (
    String(item?.folio || '').toUpperCase().includes(q)
      || String(item?.cliente || '').toUpperCase().includes(q)
      || String(item?.telefono || item?.contacto || '').toUpperCase().includes(q)
  ));
  return { ok: true, apartados: filtered };
}
