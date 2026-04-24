const ADMIN_ALLOWLIST = [
  "yair.tenorio.silva@gmail.com",
  "harujagdl@gmail.com",
  "harujagdl.ventas@gmail.com"
].map((email) => String(email || "").trim().toLowerCase());

const ADMIN_ALLOWLIST_SET = new Set(ADMIN_ALLOWLIST);
const ADMIN_SESSION_URL = "/api/core?action=admin-session";
const GOOGLE_GSI_SRC = "https://accounts.google.com/gsi/client";

let googleIdentityPromise = null;
let googleClientIdPromise = null;
let googleIdentityInitialized = false;
let googleTokenClient = null;
let googleTokenClientId = "";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const callAdminSession = async (op, { method = "GET", body } = {}) => {
  const params = new URLSearchParams({ action: "admin-session", op });
  const response = await fetch(`/api/core?${params.toString()}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.message || "No se pudo validar sesión admin.");
    error.status = response.status;
    error.code = payload?.code || "";
    error.payload = payload;
    throw error;
  }
  return payload;
};

const readGoogleClientIdFromWindow = () => {
  const fromGlobal = String(window.__HARUJA_GOOGLE_CLIENT_ID__ || "").trim();
  if (fromGlobal) return fromGlobal;
  const fromMeta = String(document.querySelector('meta[name="google-client-id"]')?.content || "").trim();
  return fromMeta;
};

const getGoogleClientId = async () => {
  if (!googleClientIdPromise) {
    googleClientIdPromise = (async () => {
      const hinted = readGoogleClientIdFromWindow();
      if (hinted) return hinted;
      const status = await getAdminSession();
      const fromBackend = String(status?.googleClientId || "").trim();
      if (!fromBackend) {
        throw new Error("Falta configurar GOOGLE_CLIENT_ID en el backend.");
      }
      return fromBackend;
    })();
  }
  return googleClientIdPromise;
};

export function loadGoogleIdentity() {
  if (window.google?.accounts?.id && window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (googleIdentityPromise) return googleIdentityPromise;

  googleIdentityPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GOOGLE_GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google), { once: true });
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar Google Identity Services.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = GOOGLE_GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("No se pudo cargar Google Identity Services."));
    document.head.appendChild(script);
  });

  return googleIdentityPromise;
}

const initGoogleIdentity = ({ clientId, callback }) => {
  if (googleIdentityInitialized) return;
  if (!window.google?.accounts?.id) return;

  googleIdentityInitialized = true;
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback,
    use_fedcm_for_prompt: false,
    cancel_on_tap_outside: false,
    auto_select: false,
    context: "signin"
  });
  console.info("[admin-auth] Google auth initialized once");
};

const fetchGoogleUserInfo = async (accessToken) => {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error("No se pudo validar la cuenta Google con userinfo.");
  }
  const payload = await response.json();
  return {
    email: normalizeEmail(payload?.email),
    email_verified: payload?.email_verified === true,
    sub: String(payload?.sub || "").trim(),
    name: String(payload?.name || "").trim() || null,
    picture: String(payload?.picture || "").trim() || null
  };
};

const initGoogleTokenClient = ({ clientId }) => {
  if (googleTokenClient && googleTokenClientId === clientId) return googleTokenClient;
  if (!window.google?.accounts?.oauth2) return null;

  googleTokenClientId = clientId;
  googleTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "openid email profile",
    callback: () => {},
    error_callback: (err) => {
      console.error("[admin-auth] Google login popup failed", err);
    }
  });

  return googleTokenClient;
};

const requestGoogleAccessToken = async (clientId) => {
  await loadGoogleIdentity();
  if (!window.google?.accounts?.oauth2) {
    throw new Error("Google Sign-In no está disponible todavía. Recarga la página e intenta de nuevo.");
  }

  initGoogleIdentity({ clientId, callback: () => {} });
  const tokenClient = initGoogleTokenClient({ clientId });
  if (!tokenClient) {
    throw new Error("Google Sign-In no está disponible todavía. Recarga la página e intenta de nuevo.");
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("No se recibió respuesta de Google. Intenta de nuevo."));
    }, 20000);

    tokenClient.callback = (response) => {
      window.clearTimeout(timeout);
      const accessToken = String(response?.access_token || "").trim();
      if (!accessToken) {
        reject(new Error("Google no devolvió un access token válido."));
        return;
      }
      resolve(accessToken);
    };

    try {
      tokenClient.requestAccessToken({ prompt: "consent" });
    } catch (error) {
      window.clearTimeout(timeout);
      reject(error);
    }
  });
};

export async function googleAdminSignIn() {
  const clientId = await getGoogleClientId();
  try {
    const accessToken = await requestGoogleAccessToken(clientId);
    const userInfo = await fetchGoogleUserInfo(accessToken);

    if (!userInfo.email || !ADMIN_ALLOWLIST_SET.has(userInfo.email)) {
      throw new Error("Tu cuenta Google no está autorizada para modo admin.");
    }

    return callAdminSession("google-login", {
      method: "POST",
      body: {
        accessToken,
        profile: userInfo
      }
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (/popup|closed_by_user|access_denied/i.test(message)) {
      throw new Error("No se pudo abrir el inicio de sesión de Google. Revisa pop-ups, cookies de terceros o intenta en incógnito.");
    }
    throw error;
  }
}

export async function getAdminSession() {
  return callAdminSession("status");
}

export async function adminSignOut() {
  const payload = await callAdminSession("logout", { method: "POST" });
  try {
    if (window.google?.accounts?.id?.disableAutoSelect) {
      window.google.accounts.id.disableAutoSelect();
    }
  } catch (_error) {
    // no-op
  }
  return payload;
}

export function isAdminUser(session) {
  return Boolean(session?.authenticated === true && session?.isAdmin === true);
}

export function isAdminSessionExpired(session) {
  const expiresAt = Number(session?.expiresAt || 0);
  if (!expiresAt) return !isAdminUser(session);
  return Date.now() >= expiresAt;
}

export { ADMIN_ALLOWLIST, ADMIN_SESSION_URL, normalizeEmail, ADMIN_ALLOWLIST_SET };
