const normalizeEntries = (entries = []) => {
  return entries
    .map((entry) => ({
      orden: Number.isFinite(Number(entry?.orden)) ? Number(entry.orden) : Number.MAX_SAFE_INTEGER,
      clave: String(entry?.clave || "").trim(),
      valor: String(entry?.valor || "").trim()
    }))
    .filter((entry) => entry.clave || entry.valor)
    .sort((a, b) => a.orden - b.orden);
};

export async function loadDictionariesFromSheets() {
  const response = await fetch("/api/dictionaries", {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "No se pudieron cargar los diccionarios desde Sheets.");
  }

  const data = await response.json();
  return {
    tipos: normalizeEntries(data?.tipos || []),
    proveedores: normalizeEntries(data?.proveedores || []),
    colores: normalizeEntries(data?.colores || []),
    tallas: normalizeEntries(data?.tallas || [])
  };
}
