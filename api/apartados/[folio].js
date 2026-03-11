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
} from "../../lib/apartados/sheets.js";

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function toNumber(value) {
  const numeric = Number.parseFloat(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function getValueByCandidates(source, candidates) {
  const entries = Object.entries(source || {});
  const normalizedCandidates = candidates.map((candidate) =>
    String(candidate)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase()
  );

  for (const [key, value] of entries) {
    const normalizedKey = String(key)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
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

function mapDetail(apartado, itemsRows, abonosRows) {
  const folio = String(apartado.Folio || "").trim();
  const folioKey = normalize(folio);
  const productos = itemsRows
    .filter((item) => normalize(item.Folio) === folioKey)
    .map((item) => ({
      codigo: String(item.Codigo || "").trim(),
      descripcion: String(item.Descripcion || "").trim(),
      tipo: String(item.Tipo || "").trim(),
      color: String(item.Color || "").trim(),
      talla: String(item.Talla || "").trim(),
      proveedor: String(item.Proveedor || "").trim(),
      precio: roundMoney(item.Precio),
    }));

  const historialAbonos = abonosRows
    .filter((abono) => normalize(abono.Folio) === folioKey)
    .map((abono) => ({
      fecha: String(abono.Fecha || "").trim(),
      monto: roundMoney(abono.Monto),
      metodo: String(abono.Metodo || "").trim(),
      comentario: String(abono.Comentario || "").trim(),
    }))
    .sort((a, b) => Date.parse(b.fecha || "") - Date.parse(a.fecha || ""));

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

async function handleGet(req, res) {
  const folioParam = normalize(req.query.folio);
  const { sheets, spreadsheetId } = await getContext();

  if (folioParam === "_NEXT") {
    const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
    const seqs = apartadosRows
      .map((row) => String(row.Folio || "").trim().toUpperCase())
      .map((folio) => {
        const match = /^HARUJA\s*(\d+)$/i.exec(folio);
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((value) => Number.isFinite(value));
    const maxSeq = seqs.length ? Math.max(...seqs) : 0;
    return res.status(200).json({ ok: true, folio: `HARUJA${String(maxSeq + 1).padStart(4, "0")}` });
  }

  const [apartadosRows, itemsRows, abonosRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
    readSheetRows(sheets, spreadsheetId, "apartados_abonos"),
  ]);

  if (folioParam === "_LIST") {
    const apartados = apartadosRows
      .map((row) => mapDetail(row, itemsRows, abonosRows))
      .sort((a, b) => Date.parse(b.fecha || "") - Date.parse(a.fecha || ""));
    return res.status(200).json({ ok: true, apartados });
  }

  const apartado = apartadosRows.find((row) => normalize(row.Folio) === folioParam);
  if (!apartado) return res.status(404).json({ ok: false, message: "No se encontró el folio." });

  const detail = mapDetail(apartado, itemsRows, abonosRows);

  return res.status(200).json({
    ok: true,
    apartado: detail,
    folio: detail.folio,
    fecha: detail.fecha,
    cliente: detail.cliente,
    contacto: detail.telefono,
    items: detail.productos,
    subtotal: detail.subtotal,
    anticipo: detail.anticipo,
    descuento: detail.descuento,
    total: detail.total,
  });
}

async function handlePost(req, res) {
  const payload = req.body || {};
  const { sheets, spreadsheetId } = await getContext();

  const usarFolioExistente = Boolean(payload.usarFolioExistente);
  const folio = normalize(req.query.folio || payload.folio);
  const fecha = String(payload.fecha || "").trim();
  const cliente = String(payload.cliente || "").trim();
  const contacto = String(payload.contacto || "").trim();
  const anticipoInput = roundMoney(payload.anticipo);

  if (anticipoInput < 0) throw new Error("El anticipo no puede ser negativo.");

  const now = nowIso();

  if (usarFolioExistente) {
    if (!folio || anticipoInput <= 0) throw new Error("Para abono ingresa el Folio y un anticipo mayor a 0.");

    const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
    const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
    const apartado = apartadosRows.find((row) => normalize(row.Folio) === folio);
    if (!apartado) throw new Error("No se encontró el folio.");

    const total = roundMoney(apartado.Total);
    const nuevoAnticipo = roundMoney(roundMoney(apartado.Anticipo) + anticipoInput);
    const nuevoSaldo = roundMoney(Math.max(0, total - nuevoAnticipo));
    const nuevoEstado = nuevoSaldo <= 0 ? "LIQUIDADO" : "ACTIVO";

    const updatedRow = buildRowByTargetHeaders(apartado, apartadosHeaders, {
      Anticipo: nuevoAnticipo,
      Saldo: nuevoSaldo,
      Estado: nuevoEstado,
      UltimoMovimiento: now,
    });

    await updateSheetRow(sheets, spreadsheetId, "apartados", apartado.__rowNumber, updatedRow);
    const abonoRow = buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
      Folio: folio,
      Fecha: fecha || now.slice(0, 10),
      Monto: anticipoInput,
      Metodo: "EFECTIVO",
      Comentario: "Abono registrado desde formulario",
      FechaCreacion: now,
    });
    await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", abonoRow);

    return res.status(200).json({ ok: true, folio, ticketUrl: `/ticket/${encodeURIComponent(folio)}` });
  }

  if (!fecha || !cliente || !contacto || !folio) throw new Error("Completa los campos obligatorios para registrar el apartado.");

  const codigos = String(payload.codigos || "").split(",").map((code) => code.trim()).filter(Boolean);
  if (!codigos.length) throw new Error("Debes ingresar al menos un código.");

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
    return {
      Folio: folio,
      Codigo: codigo,
      Descripcion: getValueByCandidates(row, ["Descripcion", "Descripción"]),
      Tipo: getValueByCandidates(row, ["Tipo"]),
      Color: getValueByCandidates(row, ["Color"]),
      Talla: getValueByCandidates(row, ["Talla"]),
      Proveedor: getValueByCandidates(row, ["Proveedor"]),
      Precio: roundMoney(getValueByCandidates(row, ["Precio", "PrecioVenta", "Precio Venta"])),
      FechaCreacion: now,
    };
  });

  const subtotal = roundMoney(items.reduce((sum, item) => sum + parseCurrencyNumber(item.Precio), 0));
  const descuentoTipo = String(payload.descuentoTipo || "PCT").trim().toUpperCase();
  const descuentoValor = roundMoney(payload.descuentoValor);
  const descuentoMXN = calcDiscount(subtotal, descuentoTipo, descuentoValor);
  const total = roundMoney(Math.max(0, subtotal - descuentoMXN));
  const anticipo = anticipoInput;
  const saldo = roundMoney(Math.max(0, total - anticipo));
  const estado = saldo <= 0 ? "LIQUIDADO" : "ACTIVO";

  const apartadoRow = buildRowByTargetHeaders({}, SHEET_HEADERS.apartados, {
    Folio: folio,
    Fecha: fecha,
    Cliente: cliente,
    Contacto: contacto,
    Subtotal: subtotal,
    DescuentoTipo: descuentoTipo,
    DescuentoValor: descuentoValor,
    DescuentoMXN: descuentoMXN,
    Total: total,
    Anticipo: anticipo,
    Saldo: saldo,
    Estado: estado,
    FechaCreacion: now,
    UltimoMovimiento: now,
    PdfUrl: `/ticket/${encodeURIComponent(folio)}`,
  });

  await appendSheetRow(sheets, spreadsheetId, "apartados", apartadoRow);
  for (const item of items) {
    await appendSheetRow(sheets, spreadsheetId, "apartados_items", buildRowByTargetHeaders(item, SHEET_HEADERS.apartados_items));
  }

  if (anticipo > 0) {
    await appendSheetRow(
      sheets,
      spreadsheetId,
      "apartados_abonos",
      buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
        Folio: folio,
        Fecha: fecha,
        Monto: anticipo,
        Metodo: "EFECTIVO",
        Comentario: "Anticipo inicial",
        FechaCreacion: now,
      })
    );
  }

  return res.status(200).json({ ok: true, folio, ticketUrl: `/ticket/${encodeURIComponent(folio)}` });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "Error en apartados." });
  }
}
