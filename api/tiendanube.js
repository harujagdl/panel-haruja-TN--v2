import {
  fetchTiendanubeOrderById,
  fetchTiendanubeVariantById,
  getVentasConfig,
  saveTiendanubeOAuthConfig,
  syncVentasFromTiendanube,
} from '../lib/api/core.js';
import { ADMIN_SESSION_REQUIRED_MESSAGE, requireAdminSession } from './core.js';
import { buildTiendanubeAuthUrl, clearStateCookie, exchangeCodeForToken, parseCookies } from '../lib/tiendanube/oauth.js';
import { createTraceId } from '../lib/observability/logger.js';

function json(res, status, payload) {
  return res.status(status).json(payload);
}
const readTraceFromRequest = (req = {}) =>
  createTraceId(req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || req?.body?.traceId || req?.query?.traceId);

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
  const traceId = readTraceFromRequest(req);
  const action = String(req.query?.action || '').trim();
  const adminOnlyActions = new Set(['status', 'sync', 'import-order', 'variant', 'connect']);

  if (!action && String(req.query?.code || '').trim()) {
    return connectCallback(req, res);
  }

  if (adminOnlyActions.has(action) && !requireAdminSession(req, res, {
    logDenied: `[admin-session] /api/tiendanube denied action=${action}`,
    touchActivity: true,
    reason: `tiendanube-${action}`,
  })) {
    return json(res, 401, {
      ok: false,
      code: 'ADMIN_SESSION_REQUIRED',
      message: ADMIN_SESSION_REQUIRED_MESSAGE,
      traceId,
    });
  }

  try {
    if (action === 'sync') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.', traceId });
      const data = await syncVentasFromTiendanube();
      return json(res, 200, { ok: true, data, traceId });
    }

    if (action === 'status') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.', traceId });
      const config = await getVentasConfig();
      return json(res, 200, { ok: true, data: config, traceId });
    }

    if (action === 'connect') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.', traceId });
      return connectStart(req, res);
    }

    if (action === 'import-order') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.', traceId });
      const orderId = String(req.body?.orderId || req.query?.orderId || '').trim();
      if (!orderId) return json(res, 400, { ok: false, message: 'orderId es obligatorio.', traceId });
      const config = await getVentasConfig();
      if (!config?.store_id || !config?.access_token) {
        return json(res, 400, { ok: false, message: 'Tiendanube no está configurado.', traceId });
      }
      const data = await fetchTiendanubeOrderById(config.store_id, config.access_token, orderId);
      return json(res, 200, { ok: true, data, traceId });
    }

    if (action === 'variant') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.', traceId });
      const variantId = String(req.query?.variantId || req.query?.variant_id || '').trim();
      if (!variantId) return json(res, 400, { ok: false, message: 'variantId es obligatorio.', traceId });
      const config = await getVentasConfig();
      if (!config?.store_id || !config?.access_token) {
        return json(res, 400, { ok: false, message: 'Tiendanube no está configurado.', traceId });
      }
      const data = await fetchTiendanubeVariantById(config.store_id, config.access_token, variantId);
      return json(res, 200, { ok: true, data, traceId });
    }

    return json(res, 400, { ok: false, message: 'action inválida para /api/tiendanube.', traceId });
  } catch (error) {
    return json(res, 400, { ok: false, message: String(error?.message || error), traceId });
  }
}
