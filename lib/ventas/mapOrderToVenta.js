export function mapOrderToVenta(order) {
  return {
    orderId: String(order.id),
    orderNumber: order.number ?? null,
    storeId: String(order.store_id ?? process.env.TIENDANUBE_STORE_ID),

    createdAt: order.created_at || null,
    updatedAt: order.updated_at || null,
    paidAt: order.paid_at || null,
    cancelledAt: order.cancelled_at || null,

    orderStatus: order.status || null,
    paymentStatus: order.payment_status || null,

    total: Number(order.total || 0),
    subtotal: Number(order.subtotal || 0),
    discount: Number(order.discount || 0),

    currency: order.currency || 'MXN',
    gatewayName: order.gateway_name || '',

    customerName:
      order?.customer?.name ||
      order?.billing_name ||
      '',

    customerEmail:
      order?.contact_email ||
      '',

    raw: order,
  };
}
