export async function loadBaseRowsFromSheets() {
  const res = await fetch("/api/prendas?action=list");

  if (!res.ok) {
    throw new Error("Error cargando datos desde Sheets");
  }

  const rows = await res.json();

  return rows.map((row, index) => {
    const codigo = row["Código"] || `row-${index}`;
    const precio = Number(row["Precio"] || 0);
    const costo = Number(row["Costo"] || 0);
    const margen = Number(row["Margen"] || 0);
    const utilidad = Number(row["Utilidad"] || 0);
    const existencia = Number(row["Existencia"] || 0);
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
