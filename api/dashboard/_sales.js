import fs from "node:fs/promises";
import path from "node:path";

const ORDER_SELLER_FILE = path.join(process.cwd(), "Data", "order_seller.json");

const COMMISSION_STATUSES = new Set(["paid", "authorized", "closed"]);

const getMonthRange = (monthValue = "") => {
  const today = new Date();
  const monthText = /^\d{4}-\d{2}$/.test(monthValue) ? monthValue : today.toISOString().slice(0, 7);
  const [year, month] = monthText.split("-").map((value) => Number(value));
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { month: monthText, start, end };
};

const cleanText = (value) => String(value || "").trim();

const resolveStoreToken = (storeId) => {
  const storeTokenMapRaw = cleanText(process.env.TIENDANUBE_STORE_TOKENS_JSON);
  if (storeTokenMapRaw) {
    try {
      const storeTokenMap = JSON.parse(storeTokenMapRaw);
      const mappedToken = cleanText(storeTokenMap?.[storeId]);
      if (mappedToken) return mappedToken;
    } catch (error) {
      console.warn("[ventas] TIENDANUBE_STORE_TOKENS_JSON inválido", error);
    }
  }
  return cleanText(process.env.TIENDANUBE_ACCESS_TOKEN);
};

const getCurrency = (order) => cleanText(order.currency || order.currency_code || "MXN") || "MXN";

const normalizeTotal = (order) => {
  const fromPaid = Number(order.total_paid_amount ?? order.total_paid ?? order.total);
  if (Number.isFinite(fromPaid)) return fromPaid;
  const fromPrice = Number(order.total_price ?? order.total_price_usd ?? 0);
  return Number.isFinite(fromPrice) ? fromPrice : 0;
};

const normalizeCustomerName = (order) => {
  const first = cleanText(order?.customer?.first_name || order?.billing_address?.name || order?.name);
  const last = cleanText(order?.customer?.last_name || order?.billing_address?.last_name);
  const joined = `${first} ${last}`.trim();
  return joined || "Cliente sin nombre";
};

const normalizeFinancialStatus = (order) => {
  const financialStatus = cleanText(order.financial_status || order.payment_status || "").toLowerCase();
  if (financialStatus) return financialStatus;
  const paid = order.paid === true;
  return paid ? "paid" : "pending";
};

const normalizeOrderNumber = (order) => cleanText(order.number || order.order_number || order.id);

const buildSellerKey = (storeId, orderId) => `${storeId}:${orderId}`;

export const readSellerAssignments = async () => {
  try {
    const raw = await fs.readFile(ORDER_SELLER_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

export const writeSellerAssignments = async (payload) => {
  await fs.mkdir(path.dirname(ORDER_SELLER_FILE), { recursive: true });
  await fs.writeFile(ORDER_SELLER_FILE, JSON.stringify(payload, null, 2));
};

export const upsertSellerAssignment = async ({ storeId, orderId, seller }) => {
  const assignments = await readSellerAssignments();
  assignments[buildSellerKey(storeId, orderId)] = {
    storeId,
    orderId,
    seller: cleanText(seller),
    updatedAt: new Date().toISOString()
  };
  await writeSellerAssignments(assignments);
  return assignments[buildSellerKey(storeId, orderId)];
};

export const fetchOrdersByMonth = async ({ storeId, month }) => {
  const token = resolveStoreToken(storeId);
  if (!token) {
    throw new Error("Falta configurar TIENDANUBE_ACCESS_TOKEN o TIENDANUBE_STORE_TOKENS_JSON.");
  }

  const { month: normalizedMonth, start, end } = getMonthRange(month);
  const createdAtMin = start.toISOString();
  const createdAtMax = end.toISOString();

  let page = 1;
  const allOrders = [];

  while (page <= 10) {
    const url = new URL(`https://api.tiendanube.com/v1/${storeId}/orders`);
    url.searchParams.set("created_at_min", createdAtMin);
    url.searchParams.set("created_at_max", createdAtMax);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "200");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authentication: `bearer ${token}`,
        "User-Agent": "HarujaPanel (harujagdl.com)",
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text || "[]");
    } catch {
      throw new Error(`Tiendanube respondió con JSON inválido (${response.status}).`);
    }

    if (!response.ok) {
      const details = typeof payload === "object" ? JSON.stringify(payload) : text;
      throw new Error(`Tiendanube error ${response.status}: ${details}`);
    }

    const pageOrders = Array.isArray(payload) ? payload : [];
    allOrders.push(...pageOrders);
    if (pageOrders.length < 200) break;
    page += 1;
  }

  return { month: normalizedMonth, orders: allOrders };
};

export const normalizeOrders = async ({ orders, storeId }) => {
  const assignments = await readSellerAssignments();

  return orders.map((order) => {
    const orderId = cleanText(order.id);
    const assignment = assignments[buildSellerKey(storeId, orderId)] || null;
    return {
      orderId,
      orderNumber: normalizeOrderNumber(order),
      createdAt: order.created_at || order.createdAt || null,
      customerName: normalizeCustomerName(order),
      totalPaid: normalizeTotal(order),
      financialStatus: normalizeFinancialStatus(order),
      currency: getCurrency(order),
      seller: cleanText(assignment?.seller || ""),
      storeId
    };
  });
};

export const calculateSalesMetrics = (orders = []) => {
  const metrics = {
    totalMes: 0,
    totalSinAsignar: 0,
    totalPorVendedora: []
  };
  const bySeller = new Map();

  orders.forEach((order) => {
    if (!COMMISSION_STATUSES.has(order.financialStatus)) return;
    const total = Number(order.totalPaid) || 0;
    metrics.totalMes += total;
    if (order.seller) {
      bySeller.set(order.seller, (bySeller.get(order.seller) || 0) + total);
    } else {
      metrics.totalSinAsignar += total;
    }
  });

  metrics.totalPorVendedora = Array.from(bySeller.entries())
    .map(([seller, total]) => ({ seller, total }))
    .sort((a, b) => b.total - a.total);

  return metrics;
};

export const toVentasRow = (order) => ({
  orderId: order.orderId,
  orderNumber: order.orderNumber,
  fecha: order.createdAt,
  cliente: order.customerName,
  totalPagado: order.totalPaid,
  estado: order.financialStatus,
  seller: order.seller,
  currency: order.currency,
  storeId: order.storeId
});

export const toCsv = (orders = []) => {
  const header = ["Fecha", "Venta #", "Cliente", "Total pagado", "Estado", "Vendedora", "Store ID"];
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  };

  const rows = orders.map((order) => [
    order.createdAt || "",
    order.orderNumber || order.orderId,
    order.customerName,
    Number(order.totalPaid || 0).toFixed(2),
    order.financialStatus,
    order.seller || "",
    order.storeId || ""
  ]);

  return [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
};
