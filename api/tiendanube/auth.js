import handler from '../tiendanube.js';

export default async function tiendanubeAuthHandler(req, res) {
  req.query = { ...(req.query || {}), action: 'connect' };
  return handler(req, res);
}
