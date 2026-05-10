import handler from '../tiendanube.js';

export default async function tiendanubeStatusHandler(req, res) {
  req.query = { ...(req.query || {}), action: 'status' };
  return handler(req, res);
}
