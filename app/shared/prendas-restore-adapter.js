export async function restorePrendaInSheets(codigo) {
  const response = await fetch("/api/prendas-restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ codigo })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.message || "No se pudo restaurar el registro.");
  }

  if (!data?.ok) {
    throw new Error(data?.message || "No se pudo restaurar el registro.");
  }

  return data;
}
