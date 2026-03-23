import {
  fetchTiendanubeOrderById,
  fetchTiendanubeVariantById,
  getVentasConfig,
  saveTiendanubeOAuthConfig,
  syncVentasFromTiendanube,
} from '../lib/api/core.js';
import { buildTiendanubeAuthUrl, clearStateCookie, exchangeCodeForToken, parseCookies } from '../lib/tiendanube/oauth.js';

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function buildRedirect(query = {}) {
  const url = new URL('/ventas', 'http://local');
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return `${url.pathname}${url.search}`;
}

async function connectStart(req, res) {
  try {
    const { state, authUrl, cookie } = buildTiendanubeAuthUrl();
    if (!state || !authUrl || !cookie) throw new Error('No se pudo iniciar OAuth de Tiendanube.');
    res.setHeader('Set-Cookie', cookie);
    return res.redirect(302, authUrl);
  } catch (error) {
    return res.redirect(302, buildRedirect({ oauth: 'error', message: error?.message || 'No se pudo iniciar OAuth.' }));
  }
}

async function connectCallback(req, res) {
  const code = String(req.query?.code || '').trim();
  const state = String(req.query?.state || '').trim();
  const cookies = parseCookies(req);
  const expectedState = String(cookies.tn_oauth_state || '').trim();

  if (!code) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'Tiendanube no devolvió código de autorización.' }));
  }
  if (!state || !expectedState || state !== expectedState) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'La validación de seguridad falló. Vuelve a conectar Tiendanube.' }));
  }

  try {
    const tokenPayload = await exchangeCodeForToken(code);
    const storeId = String(tokenPayload.user_id || tokenPayload.store_id || '').trim();
    await saveTiendanubeOAuthConfig({
      store_id: storeId,
      app_id: String(process.env.TIENDANUBE_APP_ID || '').trim(),
      access_token: String(tokenPayload.access_token || '').trim(),
    });
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'success' }));
  } catch (error) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: String(error?.message || 'No se pudo completar la autorización') }));
  }
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();

  if (!action && String(req.query?.code || '').trim()) {
    return connectCallback(req, res);
  }

  try {
    if (action === 'sync') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' });
      const data = await syncVentasFromTiendanube();
      return json(res, 200, { ok: true, data });
    }

    if (action === 'status') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.' });
      const config = await getVentasConfig();
      return json(res, 200, { ok: true, data: config });
    }

    if (action === 'connect') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.' });
      return connectStart(req, res);
    }

    if (action === 'import-order') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' });
      const orderId = String(req.body?.orderId || req.query?.orderId || '').trim();
      if (!orderId) return json(res, 400, { ok: false, message: 'orderId es obligatorio.' });
      const config = await getVentasConfig();
      if (!config?.store_id || !config?.access_token) {
        return json(res, 400, { ok: false, message: 'Tiendanube no está configurado.' });
      }
      const data = await fetchTiendanubeOrderById(config.store_id, config.access_token, orderId);
      return json(res, 200, { ok: true, data });
    }

    if (action === 'variant') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.' });
      const variantId = String(req.query?.variantId || req.query?.variant_id || '').trim();
      if (!variantId) return json(res, 400, { ok: false, message: 'variantId es obligatorio.' });
      const config = await getVentasConfig();
      if (!config?.store_id || !config?.access_token) {
        return json(res, 400, { ok: false, message: 'Tiendanube no está configurado.' });
      }
      const data = await fetchTiendanubeVariantById(config.store_id, config.access_token, variantId);
      return json(res, 200, { ok: true, data });
    }

    return json(res, 400, { ok: false, message: 'action inválida para /api/tiendanube.' });
  } catch (error) {
    return json(res, 400, { ok: false, message: String(error?.message || error) });
  }
}
