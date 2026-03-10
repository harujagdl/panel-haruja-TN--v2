export async function createPrendaInSheets(payload) {
  const response = await fetch("/api/prendas-create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "No se pudo guardar la prenda en Sheets.");
  }

  return response.json();
}
