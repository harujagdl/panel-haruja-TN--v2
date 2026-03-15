export async function fetchOrderById(orderId) {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;

  const res = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
    {
      headers: {
        Authentication: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.TIENDANUBE_USER_AGENT,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Error fetching order (${res.status}): ${body.slice(0, 180)}`);
  }

  return res.json();
}
