export async function loadArchivedPrendas() {
  const response = await fetch("/api/prendas-admin?action=archived-list", {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    const message = data?.message || "No se pudo cargar el histórico archivado.";
    throw new Error(message);
  }

  return Array.isArray(data) ? data : [];
}
