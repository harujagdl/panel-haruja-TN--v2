import crypto from 'crypto';

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

function buildRedirect(query = {}) {
  const url = new URL('/ventas', 'http://local');
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return `${url.pathname}${url.search}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  const appId = getEnv('TIENDANUBE_APP_ID');
  const redirectUri = getEnv('TIENDANUBE_REDIRECT_URI');

  if (!appId || !redirectUri) {
    return res.redirect(302, buildRedirect({
      oauth: 'error',
      message: 'Falta configurar TIENDANUBE_APP_ID o TIENDANUBE_REDIRECT_URI.',
    }));
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
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  const authUrl = new URL(`https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  return res.redirect(302, authUrl.toString());
}
