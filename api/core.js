import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { getLatestWebhookEvent } from '../lib/ventas/dedupeWebhookEvent.js';
import {
  assignVentaSeller,
  createPrenda,
  generarCodigoPrenda,
  getCatalogos,
  getMetaVsVentaData,
  getVentasComisiones,
  getVentasConfig,
  getVentasDetalle,
  getVentasMiniPublic,
  getVentasResumen,
  getVentasSinAsignar,
  listPrendas,
  rebuildVentasResumen,
  repairVentasMonthKeys,
  saveVentasConfig,
  registerTiendanubeWebhooks,
  updateVentasComisiones,
  updatePrenda,
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
import {
  archiveCatalogoIADraft,
  createCatalogoIADraft,
  ensureCatalogoIASheets,
  generateCatalogoIAFicha,
  getCatalogoIABaseProducts,
  getCatalogoIADraft,
  listCatalogoIADrafts,
  repairCatalogoIARowsAlignment,
  updateCatalogoIADraft,
} from '../lib/api/catalogoIA.js';
import { AdminSessionConfigError, getAdminSessionSecret } from '../lib/security/adminSessionConfig.js';
import { createTraceId, getErrorMessage, logError, logInfo, logWarn } from '../lib/observability/logger.js';
import { getSpreadsheetId } from '../lib/google/sheetsClient.js';

export const sendOk = (res, data) => res.status(200).json({ ok: true, data });
export const sendErr = (res, status, message, _error, code) =>
  res.status(status).json({
    ok: false,
    ...(code ? { code } : {}),
    message,
  });

const HARUJA_ADMIN_COOKIE = 'HARUJA_ADMIN_SESSION';
const ADMIN_ALLOWLIST = [
  'yair.tenorio.silva@gmail.com',
  'harujagdl@gmail.com',
  'harujagdl.ventas@gmail.com',
].map((email) => String(email || '').trim().toLowerCase());
const ADMIN_ALLOWLIST_SET = new Set(ADMIN_ALLOWLIST);
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const SESSION_MAX_AGE_SECONDS = 15 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const ADMIN_SESSION_REFRESH_WINDOW_MS = 5 * 60 * 1000;
export const ADMIN_SESSION_REQUIRED_MESSAGE =
  'La sesión admin expiró. Vuelve a autenticarte con Google.';
const ADMIN_TEMP_UNAVAILABLE_MESSAGE = 'Admin temporalmente no disponible.';
const CATALOGOS_CACHE_TTL_MS = 120 * 1000;
let cacheCatalogosData = null;
let cacheCatalogosAt = 0;
let cacheCatalogosPromise = null;
const PUBLIC_ACTIONS = new Set([
  'catalogos',
  'diccionario',
  'prendas-list',
  'prendas-generar-codigo',
  'prendas-create',
  'apartados',
  'ventas-mini-public',
  'admin-session',
  'catalogo-ia-ensure-sheets',
  'catalogo-ia-base-products',
  'catalogo-ia-drafts-list',
  'catalogo-ia-draft-get',
  'catalogo-ia-draft-create',
  'catalogo-ia-draft-update',
  'catalogo-ia-draft-archive',
  'catalogo-ia-generate',
]);
const ADMIN_ACTIONS = new Set([
  'prendas-update',
  'prendas',
  'ventas-resumen',
  'resumen',
  'ventas-detalle',
  'detalle',
  'ventas-webhook-status',
  'ventas-comisiones',
  'meta-vs-venta',
  'ventas-config',
  'ventas-config-save',
  'ventas-sin-asignar',
  'assign-seller',
  'venta-asignar-vendedora',
  'ventas-rebuild',
  'ventas-repair-month-keys',
  'catalogo-ia-repair-alignment',
  'tiendanube-webhooks-register',
]);
const APARTADOS_PUBLIC_OPS = new Set(['list', 'next', 'search', 'detail', 'historial', 'create', 'abono', 'pdf-webapp-proxy']);
const APARTADOS_ADMIN_OPS = new Set(['update-status', 'missing-pdf', 'pdf-refresh', 'pdf-drive-test', 'cancel']);
const ADMIN_ALLOWED_METHODS_BY_ACTION = new Map([
  ['prendas-update', new Set(['POST'])],
  ['prendas', new Set(['GET', 'POST'])],
  ['ventas-resumen', new Set(['GET'])],
  ['resumen', new Set(['GET'])],
  ['ventas-detalle', new Set(['GET'])],
  ['detalle', new Set(['GET'])],
  ['ventas-webhook-status', new Set(['GET'])],
  ['ventas-comisiones', new Set(['GET', 'POST'])],
  ['meta-vs-venta', new Set(['GET', 'POST'])],
  ['ventas-config', new Set(['GET'])],
  ['ventas-config-save', new Set(['POST'])],
  ['ventas-sin-asignar', new Set(['GET'])],
  ['assign-seller', new Set(['POST'])],
  ['venta-asignar-vendedora', new Set(['POST'])],
  ['ventas-rebuild', new Set(['POST'])],
  ['ventas-repair-month-keys', new Set(['POST'])],
  ['catalogo-ia-repair-alignment', new Set(['GET', 'POST'])],
  ['tiendanube-webhooks-register', new Set(['POST'])],
]);
const PUBLIC_ALLOWED_METHODS_BY_ACTION = new Map([
  ['catalogos', new Set(['GET'])],
  ['diccionario', new Set(['GET'])],
  ['prendas-list', new Set(['GET'])],
  ['prendas-generar-codigo', new Set(['POST'])],
  ['prendas-create', new Set(['POST'])],
  ['ventas-mini-public', new Set(['GET'])],
  ['admin-session', new Set(['GET', 'POST'])],
  ['apartados', new Set(['GET', 'POST'])],
  ['catalogo-ia-ensure-sheets', new Set(['POST'])],
  ['catalogo-ia-base-products', new Set(['GET'])],
  ['catalogo-ia-drafts-list', new Set(['GET'])],
  ['catalogo-ia-draft-get', new Set(['GET'])],
  ['catalogo-ia-draft-create', new Set(['POST'])],
  ['catalogo-ia-draft-update', new Set(['POST'])],
  ['catalogo-ia-draft-archive', new Set(['POST'])],
  ['catalogo-ia-generate', new Set(['POST'])],
]);
const PUBLIC_PRENDA_FIELDS = [
  'Orden',
  'Código',
  'Descripción',
  'Tipo',
  'Color',
  'Talla',
  'Proveedor',
  'proveedor',
  'TN',
  'Status',
  'Disponibilidad',
  'Existencia',
  'Existencias',
  'Fecha',
  'fecha',
  'fechaTexto',
  'Precio',
  'Costo',
  'Margen',
  'Utilidad',
];
const PUBLIC_CREATE_ALLOWED_FIELDS = new Set([
  'codigo',
  'idempotencyKey',
  'descripcion',
  'detalles',
  'tipo',
  'color',
  'talla',
  'proveedor',
  'fecha',
  'tn',
]);
const PUBLIC_CREATE_BLOCKED_FIELDS = new Set([
  'costo',
  'precio',
  'margen',
  'utilidad',
  'status',
  'disponibilidad',
  'existencia',
  'inventorySource',
  'lastInventorySyncAt',
]);

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isAllowedAdminEmail = (email) => ADMIN_ALLOWLIST_SET.has(normalizeEmail(email));
const isPublicAction = (action) => PUBLIC_ACTIONS.has(String(action || '').trim());
const isAdminAction = (action) => ADMIN_ACTIONS.has(String(action || '').trim());
const toAction = (value) => String(value || '').trim();
const toOp = (value) => String(value || '').trim();
const sendMethodNotAllowed = (res, allowedMethods = []) =>
  res.status(405).json({
    ok: false,
    code: 'METHOD_NOT_ALLOWED',
    message: `Método no permitido. Usa: ${allowedMethods.join(', ') || 'N/A'}.`,
  });

const readTraceFromRequest = (req = {}) =>
  createTraceId(
    req?.headers?.['x-trace-id']
    || req?.headers?.['x-request-id']
    || req?.body?.operationId
    || req?.body?.traceId
    || req?.query?.traceId
  );

const sanitizePrendaPublicRow = (row = {}) => {
  const result = {};
  PUBLIC_PRENDA_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(row, field)) return;
    result[field] = row[field];
  });
  return result;
};

const sanitizePrendasPublicRows = (rows = []) => (Array.isArray(rows) ? rows.map(sanitizePrendaPublicRow) : []);

const sanitizePublicCreatePayload = (payload = {}) => {
  const safePayload = {};
  const blockedKeys = [];
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (PUBLIC_CREATE_ALLOWED_FIELDS.has(key)) {
      safePayload[key] = value;
      return;
    }
    if (PUBLIC_CREATE_BLOCKED_FIELDS.has(key)) {
      blockedKeys.push(key);
      return;
    }
    // Campos no reconocidos se ignoran para no ampliar superficie de escritura pública.
  });

  safePayload.tn = String(safePayload.tn || 'N/A').trim();
  safePayload.status = 'No definido';
  safePayload.disponibilidad = 'No definido';
  safePayload.existencia = 0;
  safePayload.precio = '';
  safePayload.costo = '';
  safePayload.margen = '';
  safePayload.utilidad = '';
  safePayload.inventorySource = 'manual';
  safePayload.lastInventorySyncAt = '';

  return {
    payload: safePayload,
    blockedKeys,
  };
};

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

const isAdminSessionConfigError = (error) => error instanceof AdminSessionConfigError;
const isSheetsQuotaExceededError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 429
    || code.includes('resource_exhausted')
    || code.includes('quota')
    || message.includes('quota exceeded')
    || message.includes('resource_exhausted');
};

const sendAdminUnavailable = (res) =>
  sendErr(res, 503, ADMIN_TEMP_UNAVAILABLE_MESSAGE, null, 'ADMIN_TEMP_UNAVAILABLE');

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
  const signature = createHmac('sha256', getAdminSessionSecret()).update(encodedPayload).digest('hex');
  return `${encodedPayload}.${signature}`;
};

const decodeAdminSessionToken = (token = '') => {
  if (!token || !token.includes('.')) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = createHmac('sha256', getAdminSessionSecret()).update(encodedPayload).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn('[admin-session] admin session verification failed');
    return null;
  }

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
    console.warn('[admin-session] admin session verification failed');
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

const setAdminSessionResponseHeaders = (res, { session, refreshed = false } = {}) => {
  if (!res?.setHeader || !session?.authenticated || !session?.isAdmin) return;
  if (!refreshed) return;
  res.setHeader('X-Haruja-Admin-Session-Expires-At', String(Number(session?.expiresAt || 0) || ''));
  res.setHeader('X-Haruja-Admin-Session-Refreshed', refreshed ? '1' : '0');
};

const maybeRefreshAdminSession = (req, res, { reason = 'admin-activity', force = false, allowRefresh = true } = {}) => {
  try {
    const session = readAdminSession(req);
    if (session?.expired) {
      console.warn('[admin-session] admin session expired due to inactivity');
      if (res) clearAdminSession(res);
      return null;
    }
    if (!session?.authenticated || !session?.isAdmin) {
      return null;
    }
    const remainingMs = Math.max(0, Number(session?.expiresAt || 0) - Date.now());
    if (!allowRefresh) {
      console.log('[admin-session] admin session refresh skipped for passive check');
      return session;
    }
    if (!force && remainingMs > ADMIN_SESSION_REFRESH_WINDOW_MS) {
      console.log(`[admin-session] admin session refresh skipped reason=${reason} remainingMs=${remainingMs}`);
      return session;
    }
    createAdminSession(res, { email: session?.email, sub: session?.sub });
    const refreshedSession = {
      ...session,
      issuedAt: Date.now(),
      expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    };
    console.log(`[admin-session] admin session refreshed by real admin activity reason=${reason} expiresAt=${refreshedSession.expiresAt}`);
    setAdminSessionResponseHeaders(res, { session: refreshedSession, refreshed: true });
    return refreshedSession;
  } catch (error) {
    if (isAdminSessionConfigError(error)) return null;
    throw error;
  }
};

export const getValidatedAdminSession = (req, res, options = {}) =>
  maybeRefreshAdminSession(req, res, {
    reason: options?.reason || 'admin-validation',
    force: options?.touchActivity === true,
    allowRefresh: options?.touchActivity === true,
  });

export const requireAdminSession = (req, res, options = {}) => {
  const session = getValidatedAdminSession(req, res, options);
  if (session) return session;
  if (options?.logDenied) {
    console.warn(options.logDenied);
  }
  return null;
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

const verifyGoogleAccessToken = async ({ accessToken, profile } = {}) => {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('Access token de Google requerido.');

  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error('No se pudo validar la cuenta de Google con access token.');
  }

  const payload = await response.json().catch(() => ({}));
  const requestProfile = profile && typeof profile === 'object' ? profile : {};

  return {
    email: normalizeEmail(payload.email || requestProfile.email),
    email_verified: payload.email_verified === true || requestProfile.email_verified === true,
    sub: String(payload.sub || requestProfile.sub || '').trim(),
    aud: GOOGLE_CLIENT_ID,
    name: String(payload.name || requestProfile.name || '').trim() || null,
    picture: String(payload.picture || requestProfile.picture || '').trim() || null,
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

async function proxyApartadoPdfWebApp(req, res, { traceId = '' } = {}) {
  logInfo('pdf.proxy.start', { action: 'apartados', op: 'pdf-webapp-proxy', traceId });

  const webAppUrl = String(process.env.HARUJA_APARTADOS_PDF_WEBAPP_URL || '').trim();
  if (!webAppUrl) {
    logError('pdf.proxy.error', {
      action: 'apartados',
      op: 'pdf-webapp-proxy',
      traceId,
      stage: 'validate_env',
      errorCode: 'ADMIN_TEMP_UNAVAILABLE',
      message: 'missing HARUJA_APARTADOS_PDF_WEBAPP_URL',
    });
    return res.status(500).json({
      ok: false,
      code: 'ADMIN_TEMP_UNAVAILABLE',
      traceId,
      message: 'No se pudo procesar el PDF oficial.',
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
      logError('pdf.proxy.invalid_response', {
        action: 'apartados',
        op: 'pdf-webapp-proxy',
        traceId,
        stage: 'parse_response',
        errorCode: 'PDF_PROXY_FAILED',
        message: getErrorMessage(parseError),
      });
      return res.status(502).json({
        ok: false,
        code: 'PDF_PROXY_FAILED',
        traceId,
        message: 'No se pudo procesar el PDF oficial.',
      });
    }

    if (!response.ok || !data?.ok) {
      logError('pdf.proxy.error', {
        action: 'apartados',
        op: 'pdf-webapp-proxy',
        traceId,
        stage: 'apps_script_response',
        status: response.status,
        errorCode: 'PDF_PROXY_FAILED',
        message: data?.message || data?.details || data?.error || `HTTP ${response.status}`,
      });
      return res.status(502).json({
        ok: false,
        code: 'PDF_PROXY_FAILED',
        traceId,
        message: 'No se pudo procesar el PDF oficial.',
      });
    }

    logInfo('pdf.proxy.success', {
      action: 'apartados',
      op: 'pdf-webapp-proxy',
      traceId,
      fileId: data?.fileId || '',
      pdfUrl: data?.pdfUrl || '',
    });

    return res.status(200).json({ ...data, traceId });
  } catch (error) {
    logError('pdf.proxy.error', {
      action: 'apartados',
      op: 'pdf-webapp-proxy',
      traceId,
      stage: 'fetch_proxy',
      errorCode: 'PDF_PROXY_FAILED',
      message: getErrorMessage(error),
    });
    return res.status(500).json({
      ok: false,
      code: 'PDF_PROXY_FAILED',
      traceId,
      message: 'Error inesperado en proxy de PDF.',
    });
  }
}

async function handlePrendas(req, res) {
  const op = toOp(req.query?.op || req.body?.op || req.query?.mode || '');
  const traceId = readTraceFromRequest(req);
  if (!['GET', 'POST'].includes(req.method)) return sendMethodNotAllowed(res, ['GET', 'POST']);

  if (!requireAdminSession(req, res, {
    logDenied: `[admin-session] prendas op denied: ${op || 'list'}`,
    touchActivity: true,
    reason: `prendas-${op || 'list'}`,
  })) {
    logWarn('api.core.denied', {
      action: 'prendas',
      op: op || 'list',
      traceId,
      result: 'denied',
      errorCode: 'ADMIN_SESSION_REQUIRED',
    });
    return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
  }

  const isSensitiveOp = ['create', 'delete', 'archive', 'restore', 'import-corrections'].includes(op);
  if (isSensitiveOp) console.log(`[security] prendas sensitive op by admin: ${op}`);

  if (req.method === 'GET' && (!op || op === 'list')) return sendOk(res, await listPrendas());
  if (req.method === 'GET' && op === 'archived') return sendOk(res, await listArchivedPrendas());
  if (req.method === 'POST' && op === 'create') return sendOk(res, await createPrenda({ ...(req.body || {}), traceId }));

  if (req.method === 'POST' && op === 'delete') {
    const result = await deletePrenda({ ...(req.body || {}), traceId });
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'archive') {
    const result = await archivePrenda({ ...(req.body || {}), traceId });
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'restore') {
    const result = await restorePrenda({ ...(req.body || {}), traceId });
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  return sendErr(res, 400, 'Operación inválida para action=prendas.');
}

async function handleAdminSession(req, res) {
  const op = String(req.query?.op || req.body?.op || '').trim();
  const traceId = readTraceFromRequest(req);
  if (req.method === 'GET' && op === 'status') {
    try {
      const session = getValidatedAdminSession(req, res, {
        touchActivity: false,
        reason: 'admin-status-check',
      });
      const now = Date.now();
      const isExpired = !session?.authenticated || !session?.isAdmin;
      if (!session?.authenticated || !session?.isAdmin || isExpired) {
        logWarn('admin.session.expired', {
          action: 'admin-session',
          op: 'status',
          traceId,
          result: 'denied',
          errorCode: 'ADMIN_SESSION_REQUIRED',
        });
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
    } catch (error) {
      if (isAdminSessionConfigError(error)) return sendAdminUnavailable(res);
      throw error;
    }
  }

  if (req.method === 'POST' && op === 'google-login') {
    let verifiedEmail = '';
    try {
      const hasCredential = Boolean(String(req.body?.credential || '').trim());
      const verified = hasCredential
        ? await verifyGoogleIdToken(req.body?.credential)
        : await verifyGoogleAccessToken({
          accessToken: req.body?.accessToken,
          profile: req.body?.profile,
        });
      const email = normalizeEmail(verified?.email);
      verifiedEmail = email;
      const emailVerified = verified?.email_verified === true;
      const aud = String(verified?.aud || '').trim();
      const isAdmin = isAllowedAdminEmail(email);

      if (!emailVerified || !email || aud !== GOOGLE_CLIENT_ID || !isAdmin) {
        logWarn('api.core.denied', {
          action: 'admin-session',
          op: 'google-login',
          traceId,
          userEmail: email,
          result: 'denied',
        });
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
      if (isAdminSessionConfigError(error)) {
        if (isAllowedAdminEmail(verifiedEmail)) {
          console.warn('[admin-session] allowlisted email but missing/invalid backend admin session');
        }
        return sendAdminUnavailable(res);
      }
      logError('admin.session.login_failed', {
        action: 'admin-session',
        op: 'google-login',
        traceId,
        errorCode: 'GOOGLE_AUTH_FAILED',
        message: getErrorMessage(error),
      });
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
  const op = toOp(req.query?.op || req.body?.op || '');
  const folio = String(req.query?.folio || req.body?.folio || '').trim();
  const traceId = readTraceFromRequest(req);
  if (!['GET', 'POST'].includes(req.method)) return sendMethodNotAllowed(res, ['GET', 'POST']);

  const isAdminOp = APARTADOS_ADMIN_OPS.has(op);
  if (isAdminOp && !requireAdminSession(req, res, {
    logDenied: `[admin-session] apartados op denied: ${op}`,
    touchActivity: true,
    reason: `apartados-${op}`,
  })) {
    logWarn('api.core.denied', {
      action: 'apartados',
      op,
      folio,
      traceId,
      result: 'denied',
      errorCode: 'ADMIN_SESSION_REQUIRED',
    });
    return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
  }
  if (op && !APARTADOS_PUBLIC_OPS.has(op) && !APARTADOS_ADMIN_OPS.has(op)) {
    return sendErr(res, 400, 'Operación inválida para action=apartados.');
  }

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
    const syncPdf = String(req.query?.syncPdf || req.body?.syncPdf || '').trim() === '1';
    const result = await getApartadoDetail(folio, { syncPdf });
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'GET' && op === 'historial') {
    if (!folio) return sendErr(res, 400, 'folio es obligatorio.');
    const result = await getHistorialApartado(folio);
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'create') return sendOk(res, await createApartado({ ...(req.body || {}), traceId }));
  if (req.method === 'POST' && op === 'abono') return sendOk(res, await addAbono({ ...(req.body || {}), traceId }));

  if (req.method === 'POST' && op === 'update-status') {
    const result = await updateApartadoStatus({ ...(req.body || {}), traceId });
    if (result?.status) return res.status(result.status).json(result.body);
    return sendOk(res, result);
  }

  // ✅ Proxy real al Apps Script para evitar CORS desde navegador
  if (req.method === 'POST' && op === 'pdf-webapp-proxy') {
    return proxyApartadoPdfWebApp(req, res, { traceId });
  }

  // 🔥 FORZAR SIEMPRE Apps Script (sin service account)
  if (req.method === 'POST' && op === 'pdf-refresh') {
    console.log('pdf_refresh_redirect_to_webapp');
    return proxyApartadoPdfWebApp(req, res, { traceId });
  }

  if (req.method === 'POST' && op === 'pdf-drive-test') {
    const result = await runApartadoPdfDriveWriteTest({ traceId });
    if (!result?.ok) return sendErr(res, 502, result?.error || 'No se pudo guardar el PDF en Drive.');
    return sendOk(res, result);
  }

  if (req.method === 'POST' && op === 'cancel') {
    const result = await cancelApartado({ ...(req.body || {}), traceId });
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
  const action = toAction(req.query?.action || '');
  const traceId = readTraceFromRequest(req);
  if (!action) return sendErr(res, 400, 'action es obligatorio.');

  try {
    const allowedMethods = ADMIN_ALLOWED_METHODS_BY_ACTION.get(action) || PUBLIC_ALLOWED_METHODS_BY_ACTION.get(action);
    if (allowedMethods && !allowedMethods.has(req.method)) {
      logWarn('api.core.method_not_allowed', {
        action,
        traceId,
        stage: 'method_guard',
        method: req.method,
        errorCode: 'METHOD_NOT_ALLOWED',
      });
      return sendMethodNotAllowed(res, [...allowedMethods]);
    }

    if (isAdminAction(action) && !requireAdminSession(req, res, {
      logDenied: '[admin-session] admin action denied without valid session',
      touchActivity: true,
      reason: `core-${action}`,
    })) {
      logWarn('api.core.denied', {
        action,
        traceId,
        result: 'denied',
        errorCode: 'ADMIN_SESSION_REQUIRED',
      });
      return sendErr(res, 401, ADMIN_SESSION_REQUIRED_MESSAGE, null, 'ADMIN_SESSION_REQUIRED');
    }
    if (isPublicAction(action)) {
      console.log(`[permissions] public action allowed: ${action}`);
    }

    if (action === 'ventas-resumen' || action === 'resumen') return sendOk(res, await getVentasResumen(req.query?.month));
    if (action === 'ventas-mini-public') return sendOk(res, await getVentasMiniPublic(req.query?.month));
    if (action === 'ventas-detalle' || action === 'detalle') return sendOk(res, await getVentasDetalle(req.query?.month, req.query?.q || req.query?.search));
    if (action === 'ventas-webhook-status') return sendOk(res, await getLatestWebhookEvent());
    if (action === 'catalogos') return sendOk(res, await getCatalogosCached());

    if (action === 'diccionario') {
      const data = await getCatalogosCached();
      return res.status(200).json({ ok: true, ...data });
    }

    if (action === 'prendas-list') {
      const rows = await listPrendas();
      console.info('[prendas-list] spreadsheetId', getSpreadsheetId?.() || process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
      console.info('[prendas-list] rows count', rows.length);
      console.info('[prendas-list] first raw row', rows[0]);
      console.info('[prendas-list] first raw keys', Object.keys(rows[0] || {}));
      return sendOk(res, sanitizePrendasPublicRows(rows));
    }
    if (action === 'prendas-generar-codigo') return sendOk(res, await generarCodigoPrenda(req.body || {}));
    if (action === 'prendas-create') {
      const { payload, blockedKeys } = sanitizePublicCreatePayload(req.body || {});
      if (blockedKeys.length) {
        console.warn('[permissions] blocked attempt to send admin fields through public create', {
          action,
          blockedFields: blockedKeys,
        });
      }
      if (!payload?.codigo) {
        return sendErr(res, 400, 'Datos incompletos');
      }
      return sendOk(res, await createPrenda(payload));
    }
    if (action === 'prendas-update') {
      const result = await updatePrenda({ ...(req.body || {}), traceId });
      if (result?.status) return res.status(result.status).json(result.body);
      return sendOk(res, result);
    }

    if (action === 'prendas') return await handlePrendas(req, res);

    if (action === 'admin-session') return await handleAdminSession(req, res);

    if (action === 'apartados') return await handleApartados(req, res);

    if (action === 'catalogo-ia-ensure-sheets') return sendOk(res, await ensureCatalogoIASheets());
    if (action === 'catalogo-ia-base-products') return sendOk(res, await getCatalogoIABaseProducts(req.query || {}, readAdminSession(req) || {}));
    if (action === 'catalogo-ia-drafts-list') return sendOk(res, await listCatalogoIADrafts(req.query || {}, readAdminSession(req) || {}));
    if (action === 'catalogo-ia-draft-get') return sendOk(res, await getCatalogoIADraft(req.query?.id || req.body?.id || '', readAdminSession(req) || {}));
    if (action === 'catalogo-ia-draft-create') return sendOk(res, await createCatalogoIADraft(req.body || {}, readAdminSession(req) || {}));
    if (action === 'catalogo-ia-draft-update') return sendOk(res, await updateCatalogoIADraft(req.body?.id || req.query?.id || '', req.body?.payload || req.body || {}, readAdminSession(req) || {}));
    if (action === 'catalogo-ia-draft-archive') return sendOk(res, await archiveCatalogoIADraft(req.body?.id || req.query?.id || '', readAdminSession(req) || {}));
    if (action === 'catalogo-ia-generate') return sendOk(res, await generateCatalogoIAFicha(req.body || {}, readAdminSession(req) || {}));
    if (action === 'catalogo-ia-repair-alignment') {
      const dryRun = String(req.body?.dryRun ?? req.query?.dryRun ?? 'true').toLowerCase() !== 'false';
      return sendOk(res, await repairCatalogoIARowsAlignment({ dryRun }, readAdminSession(req) || {}));
    }

    if (action === 'ventas-comisiones') {
      if (req.method === 'GET') return sendOk(res, await getVentasComisiones(req.query || {}, req));
      if (req.method === 'POST') return sendOk(res, await updateVentasComisiones(req.body || {}, req));
    }

    if (action === 'meta-vs-venta') {
      const payload = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      return sendOk(res, await getMetaVsVentaData(payload));
    }

    if (action === 'ventas-config') return sendOk(res, await getVentasConfig());
    if (action === 'ventas-config-save') return sendOk(res, await saveVentasConfig({ ...(req.body || {}), traceId }));
    if (action === 'ventas-sin-asignar') return sendOk(res, await getVentasSinAsignar(req.query?.month));
    if (action === 'assign-seller' || action === 'venta-asignar-vendedora') return sendOk(res, await assignVentaSeller({ ...(req.body || {}), traceId }));
    if (action === 'ventas-rebuild') return sendOk(res, await rebuildVentasResumen(req.body?.month || req.query?.month));
    if (action === 'ventas-repair-month-keys') return sendOk(res, await repairVentasMonthKeys({ dryRun: String(req.body?.dryRun ?? req.query?.dryRun ?? 'true').toLowerCase() !== 'false' }));
    if (action === 'tiendanube-webhooks-register') return sendOk(res, await registerTiendanubeWebhooks(getBaseUrl(req)));

    return sendErr(res, 400, 'Acción inválida para /api/core.');
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logError('api.core.failed', {
      action,
      traceId,
      method: req?.method,
      message: errorMessage,
      errorCode: String(error?.code || '').trim() || undefined,
    });
    if (isSheetsQuotaExceededError(error)) {
      return sendErr(
        res,
        429,
        'Demasiadas solicitudes. Intenta nuevamente en unos segundos.',
        null,
        'SHEETS_QUOTA_EXCEEDED',
      );
    }
    return res.status(400).json({
      ok: false,
      code: String(error?.code || '').trim() || 'ADMIN_TEMP_UNAVAILABLE',
      traceId,
      message: 'No se pudo completar la operación solicitada.',
    });
  }
}
