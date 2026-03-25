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
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
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

const requestGoogleCredential = async (clientId) => {
  await loadGoogleIdentity();
  if (!window.google?.accounts?.id) {
    throw new Error("Google Identity Services no está disponible.");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timeout = window.setTimeout(() => {
      complete(reject, new Error("No se recibió credencial de Google. Intenta de nuevo."));
    }, 20000);

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        window.clearTimeout(timeout);
        const credential = String(response?.credential || "").trim();
        if (!credential) {
          complete(reject, new Error("Google no devolvió una credencial válida."));
          return;
        }
        complete(resolve, credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      context: "signin"
    });

    window.google.accounts.id.prompt((notification) => {
      if (settled) return;
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        window.clearTimeout(timeout);
        complete(reject, new Error("No se pudo abrir el inicio de sesión de Google en este navegador."));
      }
    });
  });
};

export async function googleAdminSignIn() {
  const clientId = await getGoogleClientId();
  const credential = await requestGoogleCredential(clientId);
  return callAdminSession("google-login", {
    method: "POST",
    body: { credential }
  });
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
