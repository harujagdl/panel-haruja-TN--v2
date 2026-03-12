export async function loadArchivedPrendas() {
  const response = await fetch('/api/core?action=prendas-archived-list', {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  const result = await response.json().catch(() => ({}));
  const data = result?.data;

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.message || 'No se pudo cargar el histórico archivado.');
  }

  return Array.isArray(data) ? data : [];
}
