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
  const response = await fetch('/api/core?action=catalogos', {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  const payload = await response.json().catch(() => ({}));
  const data = payload?.data || {};

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || 'No se pudieron cargar los diccionarios desde Sheets.');
  }

  return {
    tipos: normalizeEntries(data?.tipos || []),
    proveedores: normalizeEntries(data?.proveedores || []),
    colores: normalizeEntries(data?.colores || []),
    tallas: normalizeEntries(data?.tallas || [])
  };
}
