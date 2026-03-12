const DEFAULT_TIMEOUT_MS = 9000;
const DRIVE_FOLDER_ID = "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If";
const PILOT_FOLIO = "HARUJA0001";

function normalizeFolio(value) {
  return String(value || "").trim().toUpperCase();
}

function buildPdfFileName(folio) {
  return `tickets_apartados_${folio}.pdf`;
}

function getConfig() {
  const endpoint = String(process.env.APARTADOS_PDF_SYNC_URL || "").trim();
  const token = String(process.env.APARTADOS_PDF_SYNC_TOKEN || "").trim();
  const enabled = endpoint.length > 0;
  return { endpoint, token, enabled };
}

async function sendPdfSyncRequest(payload = {}) {
  const config = getConfig();
  const folio = normalizeFolio(payload?.folio);
  if (!config.enabled || !folio) {
    return { ok: false, skipped: true, reason: "PDF sync disabled or missing folio" };
  }

  if (folio !== PILOT_FOLIO) {
    return { ok: false, skipped: true, reason: `Pilot mode: only ${PILOT_FOLIO} is enabled` };
  }

  const fileName = buildPdfFileName(folio);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({
        ...payload,
        folio,
        driveFolderId: DRIVE_FOLDER_ID,
        fileName,
        replaceExisting: true,
        source: "panel-haruja",
        timestamp: new Date().toISOString(),
      }),
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
      exists: Boolean(data?.exists ?? data?.pdfUrl ?? data?.url),
      pdfUrl: data?.pdfUrl || data?.url || "",
      updatedAt: data?.updatedAt || data?.updated_at || "",
      fileId: data?.fileId || "",
      fileName: data?.fileName || fileName,
      replaced: Boolean(data?.replaced),
      raw: data,
    };
  } catch (error) {
    return { ok: false, error: error?.message || "sync failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncApartadoPdf({ folio, reason, apartado } = {}) {
  return sendPdfSyncRequest({
    action: "sync",
    folio,
    reason: reason || "update",
    apartado: apartado || null,
  });
}

export async function getApartadoPdf({ folio } = {}) {
  return sendPdfSyncRequest({
    action: "get",
    reason: "status_lookup",
    folio,
  });
}

export async function refreshApartadoPdf({ folio, apartado, reason } = {}) {
  return sendPdfSyncRequest({
    action: "refresh",
    reason: reason || "manual_refresh",
    folio,
    apartado: apartado || null,
  });
}


export async function refreshPdfApartado(folio) {
  return refreshApartadoPdf({ folio, reason: "prepared_refresh_trigger" });
}
