import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { getLatestWebhookEvent } from '../lib/ventas/dedupeWebhookEvent.js';
import {
  archivePrenda,
  assignVentaSeller,
  createPrenda,
  deletePrenda,
  generarCodigoPrenda,
  getCatalogos,
  getMetaVsVentaData,
  getVentasComisiones,
  getVentasConfig,
  getVentasDetalle,
  getVentasResumen,
  getVentasSinAsignar,
  importCorrections,
  listArchivedPrendas,
  listPrendas,
  rebuildVentasResumen,
  restorePrenda,
  saveVentasConfig,
  registerTiendanubeWebhooks,
  updateVentasComisiones,
} from '../lib/api/core.js';
import {
  addAbono,
  cancelApartado,
  createApartado,
  getApartadoDetail,
  getHistorialApartado,
  getNextFolio,
  getApartadosMissingPdf,
  listApartados,
  regenerateApartadoPdf,
  searchApartados,
  updateApartadoStatus,
} from '../lib/api/apartados.js';
import { runApartadoPdfDriveWriteTest } from '../lib/apartados/pdf-sync.js';

const sendOk = (res, data) => res.status(200).json({ ok: true, data });
const sendErr = (res, status, message, error, code) =>
  res.status(status).json({
    ok: false,
    ...(code ? { code } : {}),
    message,
    ...(error ? { error: String(error?.message || error) } : {}),
  });

const HARUJA_ADMIN_COOKIE = 'HARUJA_ADMIN_SESSION';
const ADMIN_ALLOWLIST = [
  'yair.tenorio.silva@gmail.com',
  'harujagdl@gmail.com',
  'harujagdl.ventas@gmail.com',
].map((email) => String(email || '').trim().toLowerCase());
const ADMIN_ALLOWLIST_SET = new Set(ADMIN_ALLOWLIST);
const ADMIN_SESSION_SECRET = String(
  process.env.ADMIN_SESSION_SECRET ||
    process.env.HARUJA_ADMIN_SESSION_SECRET ||
    process.env.CORE_ADMIN_SESSION_SECRET ||
    'haruja-admin-session-v1'
);
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const SESSION_MAX_AGE_SECONDS = 15 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const ADMIN_SESSION_REQUIRED_MESSAGE =
  'La sesión admin expiró. Vuelve a autenticarte con Google.';
const CATALOGOS_CACHE_TTL_MS = 120 * 1000;
let cacheCatalogosData = null;
let cacheCatalogosAt = 0;
let cacheCatalogosPromise = null;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isAllowedAdminEmail = (email) => ADMIN_ALLOWLIST_SET.has(normalizeEmail(email));

const parseCookies = (req) => {
  const raw = String(req?.headers?.cookie || '');
  if (!raw) return {};
  return raw.split(';').reduce((acc, part) => {
    const [k, ...rest] = part.split('=');
    const key = String(k || '').trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('=').trim());
    return acc;
  }, {});
};

const googleOAuthClient = new OAuth2Client();

const buildSessionToken = (payload = {}) => {
  const now = Date.now();
  const sessionPayload = {
    email: normalizeEmail(payload.email),
    sub: String(payload.sub || '').trim() || null,
    isAdmin: true,
    iat: now,
    exp: now + SESSION_MAX_AGE_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(sessionPayload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(encodedPayload).digest('hex');
  return `${encodedPayload}.${signature}`;
};

const decodeAdminSessionToken = (token = '') => {
  if (!token || !token.includes('.')) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = createHmac('sha256', ADMIN_SESSION_SECRET).update(encodedPayload).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const email = normalizeEmail(parsed?.email);
    const exp = Number(parsed?.exp || 0);
    if (!email || !exp) return null;
    const now = Date.now();
    if (now > exp) {
      return {
        authenticated: false,
        email: null,
        sub: null,
        isAdmin: false,
        issuedAt: Number(parsed?.iat || 0),
        expiresAt: exp,
        expired: true,
      };
    }
    return {
      authenticated: true,
      email,
      sub: String(parsed?.sub || '').trim() || null,
      isAdmin: Boolean(parsed?.isAdmin) && isAllowedAdminEmail(email),
      issuedAt: Number(parsed?.iat || 0),
      expiresAt: exp,
      expired: false,
    };
  } catch (_error) {
    return null;
  }
};

const createAdminSession = (res, payload = {}) => {
  const token = buildSessionToken(payload);
  const secure = process.env.NODE_ENV === 'production';
  const decoded = decodeAdminSessionToken(token);
  if (decoded?.expiresAt) {
    console.log(`[admin-session] created expiresAt=${decoded.expiresAt}`);
  }
  res.setHeader(
    'Set-Cookie',
    `${HARUJA_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS};${secure ? ' Secure;' : ''}`
  );
};

const readAdminSession = (req) => {
  const cookies = parseCookies(req);
  const token = String(cookies[HARUJA_ADMIN_COOKIE] || '').trim();
  return decodeAdminSessionToken(token);
};

const clearAdminSession = (res) => {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    `${HARUJA_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secure ? ' Secure;' : ''}`
  );
};

const requireAdminSession = (req, res) => {
  const session = readAdminSession(req);
  if (session?.expired) {
    console.warn('[admin-session] expired in backend');
    if (res) clearAdminSession(res);
    return null;
  }
  if (!session?.authenticated || !session?.isAdmin) {
    return null;
  }
  return session;
};

const verifyGoogleIdToken = async (credential) => {
  const idToken = String(credential || '').trim();
  if (!idToken) throw new Error('Credencial de Google requerida.');
  if (!GOOGLE_CLIENT_ID) throw new Error('Falta GOOGLE_CLIENT_ID en variables de entorno.');

  const ticket = await googleOAuthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload() || {};
  return {
    email: normalizeEmail(payload.email),
    email_verified: payload.email_verified === true,
    sub: String(payload.sub || '').trim(),
    aud: String(payload.aud || '').trim(),
    name: String(payload.name || '').trim() || null,
    picture: String(payload.picture || '').trim() || null,
  };
};

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;

  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function proxyApartadoPdfWebApp(req, res) {
  console.log('pdf_proxy:start');

  const webAppUrl = String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || '').trim();
  if (!webAppUrl) {
    console.error('pdf_proxy:missing_env');
    return res.status(500).json({
      ok: false,
      message: 'Falta HARUJA_APARTADOS_PDF_WEBAPP_URL en variables de entorno.',
    });
  }

  try {
    const response = await fetch(webAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('pdf_proxy:apps_script_invalid_json', {
        message: parseError?.message,
        raw: text?.slice?.(0, 400),
      });
      return res.status(502).json({
        ok: false,
        message: 'Respuesta no válida del Apps Script.',
        raw: String(text || '').slice(0, 400),
      });
    }

    if (!response.ok || !data?.ok) {
      console.error('pdf_proxy:error', {
        status: response.status,
        message: data?.message || data?.details || data?.error || `HTTP ${response.status}`,
      });
      return res.status(502).json({
        ok: false,
        message: data?.message || data?.details || data?.error || 'No se pudo procesar el PDF con Apps Script.',
        ...(data?.fileId ? { fileId: data.fileId } : {}),
        ...(data?.pdfUrl ? { pdfUrl: data.pdfUrl } : {}),
      });
    }

    console.log('pdf_proxy:apps_script_ok', {
      fileId: data?.fileId || '',
      pdfUrl: data?.pdfUrl || '',
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('pdf_proxy:error', {
      message: error?.message,
      stack: error?.stack,
    });
    return res.status(500).json({
      ok: false,
      message: error?.message || 'Error inesperado en proxy de PDF.',
    });
  }
}

async function handlePrendas(req, res) {
  const op = String(req.query?.op || req.body?.op || req.query?.mode || '').trim();
  const isSensitiveOp = ['create', 'delete', 'archive', 'restore', 'import-corrections'].includes(op);
  if (isSensitiveOp && !requireAdminSession(req, res)) {
    console.warn('[admin-session] reauth required');
    return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
  }

  if (req.method === 'GET' && (!op || op === 'list')) return sendOk(res, await listPrendas());
  if (req.method === 'GET' && op === 'archived') return sendOk(res, await listArchivedPrendas());
  if (req.method === 'POST' && op === 'create') return sendOk(res, await createPrenda(req.body || {}));

  if (req.method === 'POST' && op === 'delete') {
    const result = await deletePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'archive') {
    const result = await archivePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'restore') {
    const result = await restorePrenda(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  return sendErr(res, 400, 'Operación inválida para action=prendas.');
}

async function handleAdminSession(req, res) {
  const op = String(req.query?.op || req.body?.op || '').trim();
  if (req.method === 'GET' && op === 'status') {
    const session = readAdminSession(req);
    const now = Date.now();
    const isExpired = Boolean(session?.expired) || (Number(session?.expiresAt || 0) > 0 && now >= Number(session?.expiresAt));
    if (isExpired) {
      console.warn('[admin-session] expired in backend');
      clearAdminSession(res);
    }
    return res.status(200).json({
      ok: true,
      authenticated: Boolean(session?.authenticated) && !isExpired,
      email: isExpired ? null : session?.email || null,
      isAdmin: Boolean(session?.isAdmin) && !isExpired,
      expiresAt: isExpired ? null : Number(session?.expiresAt || 0) || null,
      now,
      googleClientId: GOOGLE_CLIENT_ID || null,
    });
  }

  if (req.method === 'POST' && op === 'google-login') {
    try {
      const verified = await verifyGoogleIdToken(req.body?.credential);
      const email = normalizeEmail(verified?.email);
      const emailVerified = verified?.email_verified === true;
      const aud = String(verified?.aud || '').trim();
      const isAdmin = isAllowedAdminEmail(email);

      if (!emailVerified || !email || aud !== GOOGLE_CLIENT_ID || !isAdmin) {
        clearAdminSession(res);
        return res.status(403).json({
          ok: false,
          message: 'Correo no autorizado para modo admin.',
        });
      }

      createAdminSession(res, { email, sub: verified?.sub });
      const now = Date.now();
      return res.status(200).json({
        ok: true,
        authenticated: true,
        email,
        isAdmin: true,
        expiresAt: now + SESSION_MAX_AGE_MS,
        now,
      });
    } catch (error) {
      clearAdminSession(res);
      return sendErr(res, 401, 'No se pudo validar la cuenta de Google.', error, 'GOOGLE_AUTH_FAILED');
    }
  }

  if (req.method === 'POST' && op === 'logout') {
    clearAdminSession(res);
    return res.status(200).json({ ok: true, authenticated: false, isAdmin: false, email: null, expiresAt: null, now: Date.now() });
  }

  return sendErr(res, 400, 'Operación inválida para action=admin-session.');
}

async function handleApartados(req, res) {
  const op = String(req.query?.op || req.body?.op || '').trim();
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  const action = String(req.query?.action || '').trim();

  if (req.method === 'GET' && (!op || op === 'list')) return sendOk(res, await listApartados(req.query || {}));
  if (req.method === 'GET' && op === 'next') return sendOk(res, await getNextFolio(req.query?.fecha || req.body?.fecha || ''));
  if (req.method === 'GET' && op === 'search') return sendOk(res, await searchApartados(req.query || {}));

  if (req.method === 'GET' && op === 'missing-pdf') {
    const result = await getApartadosMissingPdf(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'GET' && op === 'detail') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    const result = await getApartadoDetail(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'GET' && op === 'historial') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    const result = await getHistorialApartado(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'create') return sendOk(res, await createApartado(req.body || {}));
  if (req.method === 'POST' && op === 'abono') return sendOk(res, await addAbono(req.body || {}));

  if (req.method === 'POST' && op === 'update-status') {
    const result = await updateApartadoStatus(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  // ✅ Proxy real al Apps Script para evitar CORS desde navegador
  if (req.method === 'POST' && op === 'pdf-webapp-proxy') {
    return proxyApartadoPdfWebApp(req, res);
  }

  // 🔥 FORZAR SIEMPRE Apps Script (sin service account)
if (req.method === 'POST' && op === 'pdf-refresh') {
  console.log('pdf_refresh_redirect_to_webapp');
  return proxyApartadoPdfWebApp(req, res);
}

  if (req.method === 'POST' && op === 'pdf-drive-test') {
    const result = await runApartadoPdfDriveWriteTest();
    if (!result?.ok) return sendErr(res, 502, result?.error || 'No se pudo guardar el PDF en Drive.');
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'cancel') {
    const result = await cancelApartado(req.body || {});
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  return sendErr(res, 400, 'Operación inválida para action=apartados.');
}

async function getCatalogosCached({ force = false } = {}) {
  const now = Date.now();
  const cacheAlive = cacheCatalogosData && (now - cacheCatalogosAt) < CATALOGOS_CACHE_TTL_MS;
  if (!force && cacheAlive) {
    console.log('[catalogos] cache hit backend');
    return cacheCatalogosData;
  }
  if (!force && cacheCatalogosPromise) {
    console.log('[catalogos] request deduplicated');
    return cacheCatalogosPromise;
  }
  cacheCatalogosPromise = (async () => {
    console.log('[catalogos] fetch backend');
    const data = await getCatalogos();
    cacheCatalogosData = data;
    cacheCatalogosAt = Date.now();
    return data;
  })();
  try {
    return await cacheCatalogosPromise;
  } finally {
    cacheCatalogosPromise = null;
  }
}

export default async function handler(req, res) {
  const action = String(req.query?.action || '').trim();
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  try {
    if (action === 'ventas-resumen' || action === 'resumen') return sendOk(res, await getVentasResumen(req.query?.month));
    if (action === 'ventas-detalle' || action === 'detalle') return sendOk(res, await getVentasDetalle(req.query?.month, req.query?.q || req.query?.search));
    if (action === 'ventas-webhook-status') return sendOk(res, await getLatestWebhookEvent());
    if (action === 'catalogos') return sendOk(res, await getCatalogosCached());

    if (action === 'diccionario') {
      const data = await getCatalogosCached();
      return res.status(200).json({ ok: true, ...data });
    }

    if (action === 'prendas-list') return sendOk(res, await listPrendas());
    if (action === 'prendas-generar-codigo') return sendOk(res, await generarCodigoPrenda(req.body || {}));
    if (action === 'prendas-create') {
      const payload = req.body || {};
      if (!payload?.codigo) {
        return sendErr(res, 400, 'Datos incompletos');
      }
      return sendOk(res, await createPrenda(payload));
    }

    if (action === 'prendas-delete') {
      if (!requireAdminSession(req, res)) {
        console.warn('[admin-session] reauth required');
        return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
      }
      const result = await deletePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archive') {
      if (!requireAdminSession(req, res)) {
        console.warn('[admin-session] reauth required');
        return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
      }
      const result = await archivePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-archived-list') return sendOk(res, await listArchivedPrendas());

    if (action === 'prendas-restore') {
      if (!requireAdminSession(req, res)) {
        console.warn('[admin-session] reauth required');
        return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
      }
      const result = await restorePrenda(req.body || {});
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas-import-corrections') {
      if (!requireAdminSession(req, res)) {
        console.warn('[admin-session] reauth required');
        return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
      }
      return sendOk(res, await importCorrections(req.body || {}));
    }

    if (action === 'prendas') return await handlePrendas(req, res);

    if (action === 'prendas-admin') {
      if (!requireAdminSession(req, res)) {
        console.warn('[admin-session] reauth required');
        return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
      }
      if (req.method === 'GET') return sendOk(res, await listArchivedPrendas());
      return sendOk(res, await importCorrections(req.body || {}));
    }

    if (action === 'admin-session') return await handleAdminSession(req, res);

    if (action === 'apartados') return await handleApartados(req, res);

    if (action === 'ventas-comisiones') {
      if (req.method === 'GET') return sendOk(res, await getVentasComisiones(req.query || {}, req));
      if (req.method === 'POST') return sendOk(res, await updateVentasComisiones(req.body || {}, req));
    }

    if (action === 'meta-vs-venta') {
      const payload = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      return sendOk(res, await getMetaVsVentaData(payload));
    }

    if (action === 'ventas-config') return sendOk(res, await getVentasConfig());
    if (action === 'ventas-config-save') return sendOk(res, await saveVentasConfig(req.body || {}));
    if (action === 'ventas-sin-asignar') return sendOk(res, await getVentasSinAsignar(req.query?.month));
    if (action === 'assign-seller' || action === 'venta-asignar-vendedora') return sendOk(res, await assignVentaSeller(req.body || {}));
    if (action === 'ventas-rebuild') return sendOk(res, await rebuildVentasResumen(req.body?.month || req.query?.month));
    if (action === 'tiendanube-webhooks-register') return sendOk(res, await registerTiendanubeWebhooks(getBaseUrl(req)));

    return sendErr(res, 400, 'Acción inválida para /api/core.');
  } catch (error) {
    return sendErr(res, 400, error?.message || 'Error en /api/core.', error);
  }
}
