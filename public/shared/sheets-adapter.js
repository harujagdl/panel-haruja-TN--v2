function calcularUtilidadYMargen(precio, costo) {
  const p = Number(precio) || 0;
  const c = Number(costo) || 0;
  const utilidad = Math.max(0, p - c);
  const margen = p > 0 ? (utilidad / p) * 100 : 0;
  return {
    utilidad: Number(utilidad.toFixed(2)),
    margen: Number(margen.toFixed(1))
  };
}

export async function loadBaseRowsFromSheets() {
  const res = await fetch("/api/core?action=prendas-list");

  if (!res.ok) {
    throw new Error("Error cargando datos desde Sheets");
  }

  const payload = await res.json();
  const rows = payload?.data || [];

  return rows.map((row, index) => {
    const codigo = row["Código"] || `row-${index}`;
    const precio = Number(row["Precio"] || 0);
    const costo = Number(row["Costo"] || 0);
    const existencia = Number(row["Existencia"] ?? row["Existencias"] ?? 0);
    const { utilidad: utilidadCalculada, margen: margenCalculado } = calcularUtilidadYMargen(precio, costo);
    const utilidad = Number(row["Utilidad"] ?? utilidadCalculada ?? 0);
    const margen = Number(row["Margen"] ?? margenCalculado ?? 0);
    const orden = Number(row["Orden"] || index + 1);

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
