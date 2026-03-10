export async function deletePrendaInSheets(codigo) {
  const response = await fetch("/api/prendas-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ codigo })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || "No se pudo eliminar el registro.");
  }

  return data;
}
