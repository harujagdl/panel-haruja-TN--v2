import crypto from "crypto";

const STORE_ID = process.env.TIENDANUBE_STORE_ID || "6432936";
const ACCESS_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;
const APP_SECRET = process.env.TIENDANUBE_APP_SECRET;
const USER_AGENT = process.env.TIENDANUBE_USER_AGENT || "PanelHarujaTD";

/*
READ RAW BODY
Necesario para validar HMAC
*/
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/*
VALIDAR FIRMA WEBHOOK
*/
function verifySignature(rawBody, signature) {
  const digest = crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signature || "", "utf8")
    );
  } catch {
    return false;
  }
}

/*
FETCH ORDEN REAL
*/
async function fetchOrder(orderId) {
  const url = `https://api.tiendanube.com/v1/${STORE_ID}/orders/${orderId}`;

  const res = await fetch(url, {
    headers: {
      Authentication: `bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetchOrder failed ${res.status} ${text}`);
  }

  return res.json();
}

/*
NORMALIZAR ORDEN
*/
function mapOrder(order) {
  return {
    orderId: String(order.id),
    orderNumber: order.number ?? null,

    createdAt: order.created_at || null,
    updatedAt: order.updated_at || null,
    paidAt: order.paid_at || null,
    cancelledAt: order.cancelled_at || null,

    orderStatus: order.status || null,
    paymentStatus: order.payment_status || null,

    total: Number(order.total || 0),
    subtotal: Number(order.subtotal || 0),
    discount: Number(order.discount || 0),

    currency: order.currency || "MXN",
    gateway: order.gateway_name || "",

    customerName:
      order?.customer?.name ||
      order?.billing_name ||
      "",

    customerEmail:
      order?.contact_email ||
      "",

    raw: order
  };
}

/*
UPSERT VENTA
AQUI DEBES CONECTAR TU BASE
Firestore / Sheets / DB
*/
async function upsertVenta(venta) {

  console.log("UPSERT VENTA:", venta.orderId);

  /*
  EJEMPLO

  await db.collection("ventas")
    .doc(venta.orderId)
    .set(venta, { merge: true })
  */

}

/*
RECALCULAR NEGOCIO
*/
async function recalculateBusiness(venta) {

  console.log("RECALCULANDO COMISIONES Y RESUMEN");

  /*
  AQUÍ LLAMARÁS:

  recalculateCommission()
  recalculateResumenMensual()
  recalculateMetaVsVenta()
  */

}

/*
HANDLER PRINCIPAL
*/
export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed"
    });
  }

  try {

    const rawBody = await readRawBody(req);

    const signature = req.headers["x-linkedstore-hmac-sha256"];

    if (!verifySignature(rawBody, signature)) {
      console.error("Firma webhook inválida");

      return res.status(401).json({
        ok: false,
        error: "invalid_signature"
      });
    }

    const payload = JSON.parse(rawBody);

    const event = payload.event || "unknown";
    const storeId = String(payload.store_id || "");
    const orderId = String(payload.id || payload.order_id || "");

    console.log("Webhook recibido:", event, orderId);

    /*
    VALIDAR STORE
    */
    if (storeId !== STORE_ID) {

      console.log("Webhook ignorado store:", storeId);

      return res.status(200).json({
        ok: true,
        ignored: "store_mismatch"
      });
    }

    /*
    VALIDAR ORDER
    */
    if (!orderId) {

      console.log("Webhook sin orderId");

      return res.status(200).json({
        ok: true,
        ignored: "missing_order"
      });
    }

    /*
    FETCH ORDEN REAL
    */
    const order = await fetchOrder(orderId);

    /*
    MAPEAR ORDEN
    */
    const venta = mapOrder(order);

    /*
    UPSERT
    */
    await upsertVenta(venta);

    /*
    RECALCULAR NEGOCIO
    */
    await recalculateBusiness(venta);

    return res.status(200).json({
      ok: true,
      orderId
    });

  } catch (err) {

    console.error("ERROR WEBHOOK:", err);

    return res.status(500).json({
      ok: false,
      error: "webhook_processing_error"
    });

  }
}
