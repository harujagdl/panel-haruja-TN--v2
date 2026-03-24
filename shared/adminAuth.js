const ADMIN_ALLOWLIST = [
  "yair.tenorio.silva@gmail.com",
  "harujagdl@gmail.com",
  "harujagdl.ventas@gmail.com"
].map((email) => String(email || "").trim().toLowerCase());

const ADMIN_ALLOWLIST_SET = new Set(ADMIN_ALLOWLIST);

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
    throw new Error(payload?.message || "No se pudo validar sesión admin.");
  }
  return payload;
};

export async function getAdminSession() {
  return callAdminSession("status");
}

export async function adminSignIn(email) {
  return callAdminSession("login", {
    method: "POST",
    body: { email: normalizeEmail(email) }
  });
}

export async function adminSignOut() {
  return callAdminSession("logout", { method: "POST" });
}

export function isAdminUser(sessionOrEmail) {
  if (sessionOrEmail && typeof sessionOrEmail === "object") {
    if (sessionOrEmail.isAdmin === true) return true;
    const email = normalizeEmail(sessionOrEmail.email);
    return ADMIN_ALLOWLIST_SET.has(email);
  }
  return ADMIN_ALLOWLIST_SET.has(normalizeEmail(sessionOrEmail));
}

export { ADMIN_ALLOWLIST };
