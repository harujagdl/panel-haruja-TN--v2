import { calculateSalesMetrics, fetchOrdersByMonth, normalizeOrders, toVentasRow } from "./_sales.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const storeId = String(req.query?.storeId || "").trim();
    const month = String(req.query?.month || "").trim();
    if (!storeId) return res.status(400).json({ ok: false, error: "storeId es obligatorio" });

    const fetched = await fetchOrdersByMonth({ storeId, month });
    const normalized = await normalizeOrders({ orders: fetched.orders, storeId });
    const metrics = calculateSalesMetrics(normalized);

    return res.status(200).json({
      ok: true,
      month: fetched.month,
      count: normalized.length,
      orders: normalized.map(toVentasRow),
      ...metrics
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No fue posible cargar ventas" });
  }
}
