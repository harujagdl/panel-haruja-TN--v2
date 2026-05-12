import coreHandler from '../core.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
  }

  req.query = { ...(req.query || {}), action: 'health' };
  return coreHandler(req, res);
}
