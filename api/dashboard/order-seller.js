import { upsertSellerAssignment } from "./_sales.js";

export default async function handler(req, res) {
  if (req.method !== "PATCH") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const storeId = String(body.storeId || "").trim();
    const orderId = String(body.orderId || "").trim();
    const seller = String(body.seller || "").trim();

    if (!storeId || !orderId) {
      return res.status(400).json({ ok: false, error: "storeId y orderId son obligatorios" });
    }

    const saved = await upsertSellerAssignment({ storeId, orderId, seller });
    return res.status(200).json({ ok: true, assignment: saved });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No fue posible guardar vendedora" });
  }
}
