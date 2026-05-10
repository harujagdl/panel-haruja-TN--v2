import handler from '../tiendanube.js';

export default async function tiendanubeSyncHandler(req, res) {
  req.query = { ...(req.query || {}), action: 'sync' };
  return handler(req, res);
}
