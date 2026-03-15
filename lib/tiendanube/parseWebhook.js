function normalizeEvent(value = '') {
  return String(value || '').trim().toLowerCase();
}

function extractOrderId(payload = {}) {
  const value = payload?.id ?? payload?.order_id;
  return String(value || '').trim();
}

export function parseTiendanubeWebhook(payload = {}, headers = {}) {
  const event = normalizeEvent(headers?.['x-tiendanube-event'] || headers?.['x-linkedstore-topic'] || payload?.event || payload?.topic || payload?.name);
  const storeId = String(payload?.store_id || payload?.storeId || '').trim();
  const orderId = extractOrderId(payload);

  return {
    event,
    storeId,
    orderId,
    receivedAt: new Date().toISOString(),
    payload,
  };
}
