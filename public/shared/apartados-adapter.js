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
  const isAbono = Boolean(payload?.usarFolioExistente);
  const op = isAbono ? "abono" : "create";
  const safePayload = { ...(payload || {}) };
  if (isAbono) {
    safePayload.operationId = String(safePayload.operationId || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`)).trim();
  }

  const response = await fetch(`/api/core?action=apartados&op=${op}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(safePayload),
  });

  return parseApiResponse(response, isAbono ? "No se pudo registrar el abono." : "No se pudo registrar el apartado.");
}
