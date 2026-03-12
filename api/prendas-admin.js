import { importCorrections, listArchivedPrendas, restorePrenda } from "../lib/api/prendasAdmin.js";

export default async function handler(req, res) {
  const action = String(req.query?.action || "").trim();

  try {
    if (req.method === "GET" && action === "archived-list") {
      return res.status(200).json(await listArchivedPrendas());
    }

    if (req.method === "POST" && action === "restore") {
      const result = await restorePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return res.status(200).json(result);
    }

    if (req.method === "POST" && action === "import-corrections") {
      return res.status(200).json(await importCorrections(req.body || {}));
    }

    return res.status(400).json({ ok: false, message: "Acción inválida para /api/prendas-admin." });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || "Error en /api/prendas-admin." });
  }
}
