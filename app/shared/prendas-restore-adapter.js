export async function restorePrendaInSheets(codigo) {
  const response = await fetch('/api/core?action=prendas-restore', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ codigo })
  });

  const result = await response.json().catch(() => ({}));
  const data = result?.data || {};

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.message || 'No se pudo restaurar el registro.');
  }

  return data;
}
