import { archivePrenda, createPrenda, deletePrenda, listPrendas } from "../lib/api/prendas.js";

export default async function handler(req, res) {
  const action = String(req.query?.action || "").trim();

  try {
    if (req.method === "GET" && action === "list") {
      return res.status(200).json(await listPrendas());
    }

    if (req.method === "POST" && action === "create") {
      return res.status(200).json(await createPrenda(req.body || {}));
    }

    if (req.method === "POST" && action === "delete") {
      const result = await deletePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    if (req.method === "POST" && action === "archive") {
      const result = await archivePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    return res.status(400).json({ ok: false, message: "Acción inválida para /api/prendas." });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || "Error en /api/prendas." });
  }
}
