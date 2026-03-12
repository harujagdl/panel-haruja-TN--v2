export async function deletePrendaInSheets(codigo) {
  const response = await fetch('/api/core?action=prendas-delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ codigo })
  });

  const result = await response.json().catch(() => ({}));
  const data = result?.data || {};

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.message || 'No se pudo eliminar el registro.');
  }

  return data;
}
