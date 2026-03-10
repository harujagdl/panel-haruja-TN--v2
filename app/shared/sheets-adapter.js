export async function loadPrendasFromSheets() {
  const res = await fetch("/api/prendas-list");

  if (!res.ok) {
    throw new Error("No se pudo cargar la base de prendas desde Sheets");
  }

  const data = await res.json();

  return data.map((item, index) => ({
    id: item["Código"] || `row-${index}`,
    orden: item["Orden"] ?? "",
    codigo: item["Código"] ?? "",
    descripcion: item["Descripción"] ?? "",
    tipo: item["Tipo"] ?? "",
    color: item["Color"] ?? "",
    talla: item["Talla"] ?? "",
    proveedor: item["Proveedor"] ?? "",
    tn: item["TN"] ?? "",
    status: item["Status"] ?? "",
    disponibilidad: item["Disponibilidad"] ?? "",
    existencia: Number(item["Existencia"] ?? 0),
    fecha: item["Fecha"] ?? "",
    precio: Number(item["Precio"] ?? 0),
    costo: Number(item["Costo"] ?? 0),
    margen: Number(item["Margen"] ?? 0),
    utilidad: Number(item["Utilidad"] ?? 0),
    inventorySource: item["InventorySource"] ?? "",
    lastInventorySyncAt: item["LastInventorySyncAt"] ?? "",

    // alias por si el panel usa nombres originales
    Orden: item["Orden"] ?? "",
    Código: item["Código"] ?? "",
    Descripción: item["Descripción"] ?? "",
    Tipo: item["Tipo"] ?? "",
    Color: item["Color"] ?? "",
    Talla: item["Talla"] ?? "",
    Proveedor: item["Proveedor"] ?? "",
    TN: item["TN"] ?? "",
    Status: item["Status"] ?? "",
    Disponibilidad: item["Disponibilidad"] ?? "",
    Existencia: Number(item["Existencia"] ?? 0),
    Fecha: item["Fecha"] ?? "",
    Precio: Number(item["Precio"] ?? 0),
    Costo: Number(item["Costo"] ?? 0),
    Margen: Number(item["Margen"] ?? 0),
    Utilidad: Number(item["Utilidad"] ?? 0),
    InventorySource: item["InventorySource"] ?? "",
    LastInventorySyncAt: item["LastInventorySyncAt"] ?? ""
  }));
}
