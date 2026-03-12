export async function archivePrendaInSheets(codigo) {
  const response = await fetch('/api/core?action=prendas-archive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ codigo })
  });

  const result = await response.json().catch(() => ({}));
  const data = result?.data || {};

  if (!response.ok || result?.ok === false || data?.archived !== true) {
    throw new Error(result?.message || 'No se pudo archivar el registro.');
  }

  return data;
}
