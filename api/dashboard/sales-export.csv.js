import { fetchOrdersByMonth, normalizeOrders, toCsv } from "./_sales.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const storeId = String(req.query?.storeId || "").trim();
    const month = String(req.query?.month || "").trim();
    if (!storeId) return res.status(400).send("storeId es obligatorio");

    const fetched = await fetchOrdersByMonth({ storeId, month });
    const normalized = await normalizeOrders({ orders: fetched.orders, storeId });

    const csv = toCsv(normalized);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=ventas-comisiones-${fetched.month}.csv`);
    return res.status(200).send(`\ufeff${csv}`);
  } catch (error) {
    return res.status(500).send(error.message || "No fue posible exportar CSV");
  }
}
