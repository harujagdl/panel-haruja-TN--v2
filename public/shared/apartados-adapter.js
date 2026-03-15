async function parseApiResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.message || fallbackMessage);
  }
  return data?.data || data;
}

export async function fetchNextFolioFromSheets() {
  const response = await fetch("/api/core?action=apartados&op=next", {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  return parseApiResponse(response, "No se pudo obtener el siguiente folio.");
}

export async function registrarApartadoInSheets(payload) {
  const response = await fetch(`/api/core?action=apartados&op=create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  return parseApiResponse(response, "No se pudo registrar el apartado.");
}
