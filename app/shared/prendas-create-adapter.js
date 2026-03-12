export async function createPrendaInSheets(payload) {
  const response = await fetch('/api/core?action=prendas-create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload || {})
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.message || 'No se pudo guardar la prenda en Sheets.');
  }

  return result?.data || {};
}
