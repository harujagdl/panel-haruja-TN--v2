import { addAbono, createApartado, getApartadoDetail, getNextFolio, listApartados, syncApartadoPdfByFolio, updateApartadoStatus } from "../lib/api/apartados.js";

export default async function handler(req, res) {
  const action = String(req.query?.action || "").trim();

  try {
    if (req.method === "GET" && action === "next") return res.status(200).json(await getNextFolio());
    if (req.method === "GET" && action === "list") return res.status(200).json(await listApartados());
    if (req.method === "GET" && action === "detail") {
      const result = await getApartadoDetail(req.query?.folio);
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    if (req.method === "POST" && action === "create") {
      const payload = req.body || {};
      if (payload.usarFolioExistente) return res.status(200).json(await addAbono(payload));
      return res.status(200).json(await createApartado(payload));
    }
    if (req.method === "POST" && action === "abono") return res.status(200).json(await addAbono(req.body || {}));
    if (req.method === "POST" && action === "update-status") {
      const result = await updateApartadoStatus(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }
    if (req.method === "POST" && action === "sync-pdf") {
      const folio = String(req.query?.folio || req.body?.folio || "").trim();
      const result = await syncApartadoPdfByFolio(folio, req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    return res.status(400).json({ ok: false, message: "Acción inválida para /api/apartados." });
  } catch (error) {
    return res.status(400).json({ ok: false, message: error?.message || "Error en apartados." });
  }
}
