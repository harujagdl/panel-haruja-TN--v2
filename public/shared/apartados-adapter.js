async function parseApiResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const code = String(data?.code || "").trim();
    const safeMessageByCode = {
      ADMIN_SESSION_REQUIRED: "La sesión admin expiró. Vuelve a autenticarte.",
      METHOD_NOT_ALLOWED: "Operación no permitida para este método.",
      INVALID_PAYLOAD: "No se pudo completar la operación. Revisa los datos e intenta de nuevo.",
      APARTADO_NOT_FOUND: "No se encontró el folio indicado.",
      ABONO_DUPLICATED: "Este movimiento ya había sido procesado previamente.",
      ABONO_INCONSISTENT: "Se detectó una inconsistencia en el abono. Contacta soporte con la referencia.",
      PDF_PROXY_FAILED: "El abono se registró, pero no se pudo generar el ticket.",
    };
    const error = new Error(safeMessageByCode[code] || data?.message || fallbackMessage);
    error.code = code || undefined;
    error.traceId = String(data?.traceId || "").trim() || undefined;
    error.status = Number(response?.status || 0) || undefined;
    throw error;
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
