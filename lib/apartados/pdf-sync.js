const DEFAULT_TIMEOUT_MS = 9000;

function getConfig() {
  const endpoint = String(process.env.APARTADOS_PDF_SYNC_URL || "").trim();
  const token = String(process.env.APARTADOS_PDF_SYNC_TOKEN || "").trim();
  const enabled = endpoint.length > 0;
  return { endpoint, token, enabled };
}

export async function syncApartadoPdf({ folio, reason, apartado } = {}) {
  const config = getConfig();
  if (!config.enabled || !folio) {
    return { ok: false, skipped: true, reason: "PDF sync disabled or missing folio" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const payload = {
      folio: String(folio).trim(),
      reason: reason || "update",
      apartado: apartado || null,
      source: "panel-haruja",
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      return {
        ok: false,
        status: response.status,
        error: data?.error || data?.message || `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      pdfUrl: data?.pdfUrl || data?.url || "",
      raw: data,
    };
  } catch (error) {
    return { ok: false, error: error?.message || "sync failed" };
  } finally {
    clearTimeout(timeout);
  }
}
