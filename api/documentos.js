import { getPdfStatus, getTicketByFolio, refreshPdf } from "../lib/api/documentos.js";

export default async function handler(req, res) {
  const action = String(req.query?.action || "").trim();
  const folio = String(req.query?.folio || "").trim();

  if (!folio) return res.status(400).json({ ok: false, message: "Folio requerido." });

  try {
    if (req.method === "GET" && action === "ticket") {
      const result = await getTicketByFolio(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    if (req.method === "GET" && action === "pdf-status") {
      const result = await getPdfStatus(folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    if (req.method === "POST" && action === "pdf-refresh") {
      const result = await refreshPdf(folio, req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    return res.status(400).json({ ok: false, message: "Acción inválida para /api/documentos." });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || "Error en /api/documentos." });
  }
}
