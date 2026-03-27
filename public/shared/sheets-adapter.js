import { calcularUtilidadYMargenDesdeBaseVenta, normalizeNumber } from "./pricing-utils.js";

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

    return {
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
      proveedor: row["Proveedor"] || "",

      tn: row["TN"] || "",
      status: row["Status"] || "",
      statusCanon: row["Status"] || "",
      disponibilidad: row["Disponibilidad"] || "",
      disponibilidadCanon: row["Disponibilidad"] || "",

      qtyAvailable: existencia,
      existencia,

      fecha: row["Fecha"] || "",
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
  });
}
