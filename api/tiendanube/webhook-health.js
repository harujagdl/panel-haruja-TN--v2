export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'tiendanube-webhook',
    storeId: process.env.TIENDANUBE_STORE_ID,
  });
}
