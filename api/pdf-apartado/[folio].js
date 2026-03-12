import { getApartadoPdf, refreshApartadoPdf } from "../../lib/apartados/pdf-sync.js";

const buildSuccessPayload = (folio, result) => ({
  ok: true,
  folio,
  exists: Boolean(result?.exists),
  pdfUrl: result?.pdfUrl || "",
  updatedAt: result?.updatedAt || "",
  fileId: result?.fileId || "",
  fileName: result?.fileName || "",
  replaced: Boolean(result?.replaced),
});

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method || "")) {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const folio = String(req.query.folio || "").trim();
  if (!folio) {
    return res.status(400).json({ ok: false, message: "Folio requerido." });
  }

  const result = req.method === "GET"
    ? await getApartadoPdf({ folio })
    : await refreshApartadoPdf({
        folio,
        apartado: req.body?.apartado || null,
        reason: req.body?.reason || "manual_refresh",
      });

  if (!result?.ok) {
    if (result?.skipped) {
      return res.status(200).json({ ok: true, folio, exists: false, pdfUrl: "", updatedAt: "", skipped: true });
    }
    const action = req.method === "GET" ? "consultar" : "actualizar";
    return res.status(502).json({ ok: false, folio, message: result?.error || `No se pudo ${action} el PDF.` });
  }

  return res.status(200).json(buildSuccessPayload(folio, result));
}
