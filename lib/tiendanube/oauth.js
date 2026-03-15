import crypto from 'crypto';

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

export function parseCookies(req) {
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

export function clearStateCookie(res) {
  const secure = getEnv('NODE_ENV') === 'production';
  const cookieParts = ['tn_oauth_state=', 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

export function buildTiendanubeAuthUrl() {
  const appId = getEnv('TIENDANUBE_APP_ID');
  const redirectUri = getEnv('TIENDANUBE_REDIRECT_URI');
  if (!appId || !redirectUri) {
    throw new Error('Falta configurar TIENDANUBE_APP_ID o TIENDANUBE_REDIRECT_URI.');
  }

  const state = crypto.randomBytes(24).toString('hex');
  const secure = getEnv('NODE_ENV') === 'production';
  const cookieParts = [
    `tn_oauth_state=${encodeURIComponent(state)}`,
    'Max-Age=600',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) cookieParts.push('Secure');

  const authUrl = new URL(`https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  return { state, authUrl: authUrl.toString(), cookie: cookieParts.join('; ') };
}

export async function exchangeCodeForToken(code) {
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

  if (!response.ok || !String(payload.access_token || '').trim()) {
    throw new Error('No se pudo obtener el token de Tiendanube. Revisa App ID, Client Secret y Redirect URI.');
  }

  return payload;
}
