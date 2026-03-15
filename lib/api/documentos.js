import { createSheetsClient, getSpreadsheetId, readSheetRows } from "../apartados/sheets.js";
import { getApartadoPdf } from "../apartados/pdf-sync.js";
import { regenerateApartadoPdf } from "./apartados.js";

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

function roundMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
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

export async function getTicketByFolio(folio) {
  const spreadsheetId = getSpreadsheetId();
  const sheets = createSheetsClient();
  const [apartadosRows, itemsRows] = await Promise.all([
    readSheetRows(sheets, spreadsheetId, "apartados"),
    readSheetRows(sheets, spreadsheetId, "apartados_items"),
  ]);

  const key = String(folio || "").trim().toUpperCase();
  const apartado = apartadosRows.find((row) => String(row.Folio || row.folio || "").trim().toUpperCase() === key);
  if (!apartado) return { status: 404, body: { ok: false, message: `No se encontró el folio ${key}.` } };

  const items = itemsRows.filter((item) => String(item.Folio || item.folio || "").trim().toUpperCase() === key).map(mapItem);
  const ticketData = {
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

  const appUrl = String(process.env.APP_URL || "https://paneltb.harujagdl.com").replace(/\/$/, "");
  return {
    ok: true,
    ticket: ticketData,
    links: {
      apartadoUrl: `${appUrl}/apartado/${encodeURIComponent(ticketData.folio)}`,
      ticketUrl: `${appUrl}/ticket/${encodeURIComponent(ticketData.folio)}`,
    },
  };
}

export async function getPdfStatus(folio) {
  const result = await getApartadoPdf({ folio });
  if (!result?.ok) {
    if (result?.skipped) return { ok: true, folio, exists: false, pdfUrl: "", updatedAt: "", skipped: true };
    return { status: 502, body: { ok: false, folio, message: result?.error || "No se pudo consultar el PDF." } };
  }
  return { ok: true, folio, exists: Boolean(result?.exists), pdfUrl: result?.pdfUrl || "", updatedAt: result?.updatedAt || "", fileId: result?.fileId || "", fileName: result?.fileName || "", replaced: Boolean(result?.replaced) };
}

export async function refreshPdf(folio, payload = {}) {
  return regenerateApartadoPdf(folio, payload);
}

export async function getPrintData(folio) {
  return getTicketByFolio(folio);
}

export async function getPreviewData(folio) {
  return getTicketByFolio(folio);
}
