import { calcularUtilidadYMargenDesdeBaseVenta, normalizeNumber } from "./pricing-utils.js";

const PROVEEDOR_ALIASES = ["Proveedor", "proveedor", "Supplier", "supplier", "Marca", "marca"];
const FECHA_ALIASES = ["Fecha", "fecha", "Fecha alta", "Fecha Alta", "Fecha de alta", "Alta", "Created At", "created_at", "fechaTexto", "FechaTexto"];

const normalizeText = (value) => String(value ?? "").trim();

const pickFirst = (row, aliases = []) => {
  for (const key of aliases) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
};

const formatDateDDMMYYYY = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "--";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const parseSheetsSerialDate = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  // Serial date compatible con Google Sheets / Excel (epoch 1899-12-30).
  const epoch = Date.UTC(1899, 11, 30);
  const ms = Math.round(numeric * 86400000);
  const parsed = new Date(epoch + ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatFechaDisplay = (value) => {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "number") {
    const parsed = parseSheetsSerialDate(value);
    return parsed ? formatDateDDMMYYYY(parsed) : "--";
  }

  const raw = String(value).trim();
  if (!raw) return "--";

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const parsedSerial = parseSheetsSerialDate(raw);
    if (parsedSerial) return formatDateDDMMYYYY(parsedSerial);
  }

  return raw;
};

export async function loadBaseRowsFromSheets() {
  const res = await fetch("/api/core?action=prendas-list");

  if (!res.ok) {
    throw new Error("Error cargando datos desde Sheets");
  }

  const payload = await res.json();
  const rows = payload?.data || [];

  return rows.map((row, index) => {
    const codigo = row["Código"] || `row-${index}`;
    const precio = normalizeNumber(row["Precio"], { fallback: 0 }) || 0;
    const costo = normalizeNumber(row["Costo"], { fallback: 0 }) || 0;
    const existencia = normalizeNumber(row["Existencia"] ?? row["Existencias"], { fallback: 0 }) || 0;
    const { utilidad, margen } = calcularUtilidadYMargenDesdeBaseVenta(precio, costo);
    const orden = normalizeNumber(row["Orden"], { fallback: index + 1 }) || index + 1;
    const proveedorValue = normalizeText(pickFirst(row, PROVEEDOR_ALIASES));
    const fechaValue = pickFirst(row, FECHA_ALIASES);
    const fecha = normalizeText(fechaValue);
    const fechaTexto = formatFechaDisplay(fechaValue);

    const mapped = {
      docId: codigo,
      id: codigo,

      orden,
      __order: orden,
      _rowNumber: orden,

      codigo,
      descripcion: row["Descripción"] || "",
      tipo: row["Tipo"] || "",
      color: row["Color"] || "",
      talla: row["Talla"] || "",
      proveedor: proveedorValue,

      tn: row["TN"] || "",
      status: row["Status"] || "",
      statusCanon: row["Status"] || "",
      disponibilidad: row["Disponibilidad"] || "",
      disponibilidadCanon: row["Disponibilidad"] || "",

      qtyAvailable: existencia,
      existencia,

      fecha,
      fechaTexto,
      pVenta: precio,
      pVentaDisplay: precio,
      precio,

      costo,
      margen,
      utilidad,

      inventorySource: row["InventorySource"] || "",
      lastInventorySyncAt: row["LastInventorySyncAt"] || "",

      manualOverride: false,
      statusManual: null,
      disponibilidadManual: null
    };

    if (index === 0) {
      console.info("[Prendas] sample mapped row", {
        codigo: mapped.codigo,
        proveedor: mapped.proveedor,
        fecha: mapped.fecha,
        fechaTexto: mapped.fechaTexto
      });
    }

    return mapped;
  });
}
