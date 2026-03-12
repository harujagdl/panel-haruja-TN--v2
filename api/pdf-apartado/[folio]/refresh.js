import { refreshApartadoPdf } from "../../../lib/apartados/pdf-sync.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const folio = String(req.query.folio || "").trim();
  if (!folio) {
    return res.status(400).json({ ok: false, message: "Folio requerido." });
  }

  const result = await refreshApartadoPdf({
    folio,
    apartado: req.body?.apartado || null,
    reason: req.body?.reason || "manual_refresh",
  });

  if (!result.ok) {
    if (result.skipped) {
      return res.status(200).json({ ok: true, folio, exists: false, pdfUrl: "", updatedAt: "", skipped: true });
    }
    return res.status(502).json({ ok: false, folio, message: result.error || "No se pudo refrescar el PDF." });
  }

  return res.status(200).json({
    ok: true,
    folio,
    exists: Boolean(result.exists),
    pdfUrl: result.pdfUrl || "",
    updatedAt: result.updatedAt || "",
    fileId: result.fileId || "",
    fileName: result.fileName || "",
    replaced: Boolean(result.replaced),
  });
}
