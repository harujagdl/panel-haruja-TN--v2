function getBaseUrl(req) {
  const configured = String(process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

async function safeJson(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(text || `Respuesta inválida del backend (${response.status}).`);
  }
  return JSON.parse(text || "{}");
}

function normalizeMonth(value) {
  const month = String(value || "").trim();
  if (!month) return "";
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Mes inválido. Usa formato YYYY-MM.");
  return month;
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method || "")) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) {
    return res.status(500).json({ ok: false, error: "No se pudo resolver la URL base de la app." });
  }

  try {
    if (req.method === "GET") {
      const storeId = String(req.query.storeId || "").trim();
      const month = normalizeMonth(req.query.month);
      if (!storeId) return res.status(400).json({ ok: false, error: "storeId es requerido." });

      const url = new URL("/dashboard/sales-details", baseUrl);
      url.searchParams.set("storeId", storeId);
      if (month) url.searchParams.set("month", month);

      const response = await fetch(url.toString(), { method: "GET" });
      const payload = await safeJson(response);
      if (!response.ok || payload?.ok === false) {
        return res.status(response.status || 502).json({ ok: false, error: payload?.error || "No se pudieron cargar ventas." });
      }

      const summary = {
        totalMes: Number(payload?.totalMes) || 0,
        totalSinAsignar: Number(payload?.totalSinAsignar) || 0,
        totalPorVendedora: Array.isArray(payload?.totalPorVendedora) ? payload.totalPorVendedora : [],
      };

      return res.status(200).json({ ok: true, summary, orders: Array.isArray(payload?.orders) ? payload.orders : [] });
    }

    const orderId = String(req.body?.orderId || "").trim();
    const seller = String(req.body?.seller || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId es requerido." });

    const url = new URL("/dashboard/order-seller", baseUrl);
    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, seller }),
    });
    const payload = await safeJson(response);
    if (!response.ok || payload?.ok === false) {
      return res.status(response.status || 502).json({ ok: false, error: payload?.error || "No se pudo guardar la vendedora." });
    }

    return res.status(200).json({ ok: true, orderId, seller });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || "Error interno en ventas-comisiones." });
  }
}
