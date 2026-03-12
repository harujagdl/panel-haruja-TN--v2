import { getApartadoPdf } from "../../lib/apartados/pdf-sync.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const folio = String(req.query.folio || "").trim();
  if (!folio) {
    return res.status(400).json({ ok: false, message: "Folio requerido." });
  }

  const result = await getApartadoPdf({ folio });
  if (!result.ok) {
    if (result.skipped) {
      return res.status(200).json({ ok: true, folio, exists: false, pdfUrl: "", updatedAt: "", skipped: true });
    }
    return res.status(502).json({ ok: false, folio, message: result.error || "No se pudo consultar el PDF." });
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
