import { getCatalogos } from "../lib/api/catalogos.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    return res.status(200).json(await getCatalogos());
  } catch (error) {
    return res.status(500).json({ ok: false, message: "No se pudieron cargar los diccionarios desde Google Sheets.", error: error?.message || "Unknown error" });
  }
}
