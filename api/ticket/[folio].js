import {
  createSheetsClient,
  getSpreadsheetId,
  readSheetRows,
  roundMoney,
} from "../../lib/apartados/sheets.js";

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

function normalizeDateValue(value) {
  if (value === null || value === undefined) return "-";
  const raw = String(value).trim();
  if (!raw) return "-";

  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial)) {
      const utcMs = EXCEL_EPOCH_UTC_MS + Math.round(serial) * 86400000;
      return new Date(utcMs).toISOString().slice(0, 10);
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return raw;
}

function mapItem(item) {
  const precio = Number(item.Precio ?? item.precio ?? 0) || 0;
  const cantidad = Number(item.Cantidad ?? item.cantidad ?? 1) || 1;

  return {
    codigo: String(item.Codigo ?? item.codigo ?? "").trim(),
    descripcion: String(item.Descripcion ?? item.descripcion ?? "Prenda").trim(),
    precio,
    cantidad,
    subtotal: roundMoney(precio * cantidad),
  };
}

async function readTicketDataByFolio(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();

  const [apartadosRows, itemsRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
  ]);

  const key = String(folio || "").trim().toUpperCase();
  const apartado = apartadosRows.find(
    (row) => String(row.Folio || row.folio || "").trim().toUpperCase() === key
  );

  if (!apartado) {
    throw new Error(`No se encontró el folio ${key}.`);
  }

  const items = itemsRows
    .filter(
      (item) => String(item.Folio || item.folio || "").trim().toUpperCase() === key
    )
    .map(mapItem);

  return {
    folio: String(apartado.Folio ?? apartado.folio ?? "").trim(),
    fecha: normalizeDateValue(apartado.Fecha ?? apartado.fecha),
    cliente: String(apartado.Cliente ?? apartado.cliente ?? "").trim(),
    contacto: String(apartado.Contacto ?? apartado.contacto ?? "").trim(),
    items,
    subtotal: roundMoney(apartado.Subtotal ?? apartado.subtotal ?? 0),
    anticipo: roundMoney(apartado.Anticipo ?? apartado.anticipo ?? 0),
    descuento: roundMoney(apartado.DescuentoMXN ?? apartado.descuento ?? 0),
    total: roundMoney(apartado.Total ?? apartado.total ?? 0),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const folio = String(req.query.folio || "").trim();
    if (!folio) {
      return res.status(400).json({ ok: false, message: "Folio requerido." });
    }

    const ticketData = await readTicketDataByFolio(folio);
    const appUrl = String(process.env.APP_URL || "https://paneltb.harujagdl.com").replace(/\/$/, "");

    return res.status(200).json({
      ok: true,
      ticket: ticketData,
      links: {
        apartadoUrl: `${appUrl}/apartado/${encodeURIComponent(ticketData.folio)}`,
        ticketUrl: `${appUrl}/ticket/${encodeURIComponent(ticketData.folio)}`,
      },
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: error?.message || "No se pudo obtener el ticket.",
    });
  }
}
