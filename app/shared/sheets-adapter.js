export async function loadBaseRowsFromSheets() {

  const res = await fetch("/api/prendas-list");

  if (!res.ok) {
    throw new Error("Error cargando datos desde Sheets");
  }

  const rows = await res.json();

  return rows.map((row, index) => ({
    docId: row["Código"] || `row-${index}`,
    id: row["Código"] || `row-${index}`,

    orden: row["Orden"],
    codigo: row["Código"],
    descripcion: row["Descripción"],
    tipo: row["Tipo"],
    color: row["Color"],
    talla: row["Talla"],
    proveedor: row["Proveedor"],

    tn: row["TN"],
    status: row["Status"],
    disponibilidad: row["Disponibilidad"],
    existencia: Number(row["Existencia"] || 0),

    fecha: row["Fecha"],
    precio: Number(row["Precio"] || 0),
    costo: Number(row["Costo"] || 0),
    margen: Number(row["Margen"] || 0),
    utilidad: Number(row["Utilidad"] || 0),

    inventorySource: row["InventorySource"]
  }));

}
