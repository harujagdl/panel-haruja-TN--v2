import { saveTiendanubeOAuthConfig } from '../../lib/api/core.js';

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  const cookies = {};
  header.split(';').forEach((part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim();
    if (!key) return;
    cookies[key] = decodeURIComponent(rest.join('=').trim());
  });
  return cookies;
}

function clearStateCookie(res) {
  const secure = getEnv('NODE_ENV') === 'production';
  const cookieParts = [
    'tn_oauth_state=',
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function buildRedirect(query = {}) {
  const url = new URL('/ventas', 'http://local');
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return `${url.pathname}${url.search}`;
}

async function exchangeCodeForToken(code) {
  const clientId = getEnv('TIENDANUBE_APP_ID');
  const clientSecret = getEnv('TIENDANUBE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('No se pudo obtener el token de Tiendanube. Revisa App ID, Client Secret y Redirect URI.');
  }

  const response = await fetch('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error('No se pudo obtener el token de Tiendanube. Revisa App ID, Client Secret y Redirect URI.');
  }

  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) {
    throw new Error('No se pudo obtener el token de Tiendanube. Revisa App ID, Client Secret y Redirect URI.');
  }

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const code = String(req.query?.code || '').trim();
  const state = String(req.query?.state || '').trim();
  const cookies = parseCookies(req);
  const expectedState = String(cookies.tn_oauth_state || '').trim();

  if (!code) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'Tiendanube no devolvió código de autorización.' }));
  }
  if (!state) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'No se recibió state de OAuth. Inicia la conexión otra vez.' }));
  }
  if (!expectedState) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'State expirado o ausente' }));
  }
  if (state !== expectedState) {
    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'error', message: 'La validación de seguridad falló. Vuelve a conectar Tiendanube.' }));
  }

  try {
    const tokenPayload = await exchangeCodeForToken(code);
    const storeId = String(tokenPayload.user_id || tokenPayload.store_id || '').trim();

    await saveTiendanubeOAuthConfig({
      store_id: storeId,
      app_id: getEnv('TIENDANUBE_APP_ID'),
      access_token: String(tokenPayload.access_token || '').trim(),
    });

    clearStateCookie(res);
    return res.redirect(302, buildRedirect({ oauth: 'success' }));
  } catch (err) {
    clearStateCookie(res);
    const message = String(err?.message || 'No se pudo completar la autorización');
    return res.redirect(302, buildRedirect({ oauth: 'error', message }));
  }
}
