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
    if (normalizedCandidates.includes(normalizedKey)) {
      return value;
    }
  }

  return "";
}

function cleanCodes(codigos) {
  return String(codigos || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function calcDiscount(subtotal, descuentoTipo, descuentoValorInput) {
  const descuentoValor = roundMoney(descuentoValorInput);
  if (descuentoValor < 0) {
    throw new Error("El descuento no puede ser negativo.");
  }

  if (descuentoTipo === "PCT") {
    if (descuentoValor > 100) {
      throw new Error("El descuento en % no puede ser mayor a 100.");
    }
    return roundMoney(subtotal * (descuentoValor / 100));
  }

  if (descuentoTipo === "AMT") {
    return roundMoney(Math.min(descuentoValor, subtotal));
  }

  throw new Error("Tipo de descuento inválido.");
}

function buildResumen({ subtotal, anticipo, descuentoMXN, total }) {
  return {
    subtotal: roundMoney(subtotal),
    anticipo: roundMoney(anticipo),
    descVal: roundMoney(descuentoMXN),
    total: roundMoney(total),
  };
}

function parseBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const payload = req.body || {};
    const spreadsheetId = getSpreadsheetId();
    const sheets = createSheetsClient();
    await ensureSheetsSetup(sheets, spreadsheetId);

    const usarFolioExistente = Boolean(payload.usarFolioExistente);
    const folio = String(payload.folio || "").trim().toUpperCase();
    const fecha = String(payload.fecha || "").trim();
    const cliente = String(payload.cliente || "").trim();
    const contacto = String(payload.contacto || "").trim();
    const anticipoInput = roundMoney(payload.anticipo);

    if (anticipoInput < 0) {
      throw new Error("El anticipo no puede ser negativo.");
    }

    const now = nowIso();

    if (usarFolioExistente) {
      if (!folio || anticipoInput <= 0) {
        throw new Error("Para abono ingresa el Folio y un anticipo mayor a 0.");
      }

      const apartadosHeaders = await getSheetHeaders(sheets, spreadsheetId, "apartados");
      const apartadosRows = await readSheetRows(sheets, spreadsheetId, "apartados");
      const apartado = apartadosRows.find((row) => String(row.Folio || "").trim().toUpperCase() === folio);

      if (!apartado) {
        throw new Error("No se encontró el folio.");
      }

      const totalAnterior = roundMoney(apartado.Total);
      const subtotalAnterior = roundMoney(apartado.Subtotal);
      const descuentoMXNAnterior = roundMoney(apartado.DescuentoMXN);
      const anticipoAnterior = roundMoney(apartado.Anticipo);

      const nuevoAnticipo = roundMoney(anticipoAnterior + anticipoInput);
      const nuevoSaldo = roundMoney(Math.max(0, totalAnterior - nuevoAnticipo));
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

      return res.status(200).json({
        ok: true,
        folio,
        pdfUrl: String(apartado.PdfUrl || ""),
        message: "Abono registrado correctamente.",
        resumen: buildResumen({
          subtotal: subtotalAnterior,
          anticipo: nuevoAnticipo,
          descuentoMXN: descuentoMXNAnterior,
          total: totalAnterior,
        }),
      });
    }

    if (!fecha || !cliente || !contacto || !folio) {
      throw new Error("Completa los campos obligatorios para registrar el apartado.");
    }

    const codigos = cleanCodes(payload.codigos);
    if (codigos.length === 0) {
      throw new Error("Debes ingresar al menos un código.");
    }

    const inventarioRows = await readSheetRows(sheets, spreadsheetId, "prendas_admin_activas");

    const inventoryByCode = new Map();
    inventarioRows.forEach((row) => {
      const codigo = String(getValueByCandidates(row, ["Codigo", "Código"]) || "").trim();
      if (codigo) {
        inventoryByCode.set(codigo, row);
      }
    });

    const missingCodes = codigos.filter((codigo) => !inventoryByCode.has(codigo));
    if (missingCodes.length > 0) {
      throw new Error(`No se encontraron estos códigos: ${missingCodes.join(", ")}`);
    }

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
      GenerarTicket: parseBoolean(payload.generarTicket),
      PdfUrl: "",
    });
    await appendSheetRow(sheets, spreadsheetId, "apartados", apartadoRow);

    for (const item of items) {
      const itemRow = buildRowByTargetHeaders(item, SHEET_HEADERS.apartados_items);
      await appendSheetRow(sheets, spreadsheetId, "apartados_items", itemRow);
    }

    if (anticipo > 0) {
      const abonoRow = buildRowByTargetHeaders({}, SHEET_HEADERS.apartados_abonos, {
        Folio: folio,
        Fecha: fecha,
        Monto: anticipo,
        Metodo: "EFECTIVO",
        Comentario: "Anticipo inicial",
        FechaCreacion: now,
      });
      await appendSheetRow(sheets, spreadsheetId, "apartados_abonos", abonoRow);
    }

    const appUrl = process.env.APP_URL || `http://${req.headers.host}`;

    await fetch(`${appUrl}/api/apartados/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folio,
        fecha,
        cliente,
        contacto,
        items: items.map((item) => ({
          codigo: item.Codigo,
          descripcion: item.Descripcion,
          precio: item.Precio,
        })),
        subtotal,
        anticipo,
        descuento: descuentoMXN,
        total,
      }),
    }).catch(() => null);

    const pdfUrl = `${appUrl}/api/apartados/pdf?folio=${encodeURIComponent(folio)}`;

    return res.status(200).json({
      ok: true,
      folio,
      pdfUrl,
      message: "Apartado registrado correctamente.",
      resumen: buildResumen({ subtotal, anticipo, descuentoMXN, total }),
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error.message || "No se pudo registrar el apartado.",
    });
  }
}
