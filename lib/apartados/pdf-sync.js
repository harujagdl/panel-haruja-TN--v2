import {
  APARTADOS_PDF_FOLDER_ID,
  buildOfficialApartadoPdfFileName,
  normalizeApartadoFolio,
} from "./pdf-config.js";

const DEFAULT_TIMEOUT_MS = 9000;

function getConfig() {
  const endpoint = String(process.env.APARTADOS_PDF_SYNC_URL || "").trim();
  const token = String(process.env.APARTADOS_PDF_SYNC_TOKEN || "").trim();
  const enabled = endpoint.length > 0;
  return { endpoint, token, enabled };
}

function parseFolderId(data = {}) {
  return String(data?.folderId || data?.driveFolderId || "").trim();
}

function pickPayload(data = {}) {
  if (data && typeof data === "object" && data.data && typeof data.data === "object") return data.data;
  return data;
}

function parseFileId(data = {}) {
  return String(data?.fileId || data?.id || "").trim();
}

function derivePdfUrl(pdfUrl, fileId) {
  if (pdfUrl) return pdfUrl;
  if (!fileId) return "";
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function buildInvalidResponseError(action, details = "") {
  const base = `Respuesta inválida al ${action} de PDF oficial.`;
  return details ? `${base} ${details}` : base;
}

function normalizeSuccessResponse({ action, data, status, fileName }) {
  const payload = pickPayload(data);
  const fileId = parseFileId(payload);
  const pdfUrl = derivePdfUrl(String(payload?.pdfUrl || payload?.url || payload?.webViewLink || "").trim(), fileId);
  const folderId = parseFolderId(payload);
  const exists = Boolean(payload?.exists ?? pdfUrl);
  const updatedAt = String(payload?.updatedAt || payload?.updated_at || "").trim();

  if (action !== "get" && (!pdfUrl || !fileId)) {
    return {
      ok: false,
      status,
      error: buildInvalidResponseError(action, "Se requiere pdfUrl y fileId."),
      raw: payload,
    };
  }

  if (folderId && folderId !== APARTADOS_PDF_FOLDER_ID) {
    return {
      ok: false,
      status,
      error: buildInvalidResponseError(action, `folderId inesperado (${folderId}).`),
      raw: payload,
    };
  }

  return {
    ok: true,
    status,
    exists,
    pdfUrl,
    updatedAt,
    fileId,
    fileName: String(payload?.fileName || fileName || "").trim(),
    folderId: folderId || APARTADOS_PDF_FOLDER_ID,
    replaced: Boolean(payload?.replaced),
    raw: payload,
  };
}

async function sendPdfSyncRequest(payload = {}) {
  const config = getConfig();
  const folio = normalizeApartadoFolio(payload?.folio);
  const action = String(payload?.action || "sync").trim().toLowerCase();
  if (!config.enabled || !folio) {
    return { ok: false, skipped: true, reason: "PDF sync disabled or missing folio" };
  }

  const fileName = buildOfficialApartadoPdfFileName(folio);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    console.info("[apartados-pdf] request", { action, folio, folderId: APARTADOS_PDF_FOLDER_ID, fileName });
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({
        ...payload,
        folio,
        driveFolderId: APARTADOS_PDF_FOLDER_ID,
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

    const normalized = normalizeSuccessResponse({ action, data, status: response.status, fileName });
    if (normalized.ok) {
      console.info("[apartados-pdf] success", {
        action,
        folio,
        folderId: normalized.folderId,
        replaced: normalized.replaced,
        fileId: normalized.fileId,
        pdfUrl: normalized.pdfUrl,
      });
      return normalized;
    }

    console.error("[apartados-pdf] invalid-success-response", {
      action,
      folio,
      folderId: parseFolderId(data),
      fileId: data?.fileId,
      pdfUrl: data?.pdfUrl || data?.url,
      error: normalized.error,
    });
    return normalized;
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
