export async function loadArchivedPrendasFromSheets() {
  const response = await fetch("/api/prendas-archived-list", {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || "No se pudo cargar el histórico archivado.");
  }

  return Array.isArray(data?.rows) ? data.rows : [];
}
