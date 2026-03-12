export async function archivePrendaInSheets(codigo) {
  const response = await fetch("/api/prendas?action=archive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ codigo })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok || data?.archived !== true) {
    throw new Error(data?.message || "No se pudo archivar el registro.");
  }

  return data;
}
