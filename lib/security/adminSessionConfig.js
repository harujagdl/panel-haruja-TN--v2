const ADMIN_SESSION_SECRET_MIN_LENGTH = 32;

export class AdminSessionConfigError extends Error {
  constructor(code) {
    super('Admin session secret is not configured correctly.');
    this.name = 'AdminSessionConfigError';
    this.code = code;
  }
}

export function getAdminSessionSecret() {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) {
    console.error('[admin-session] missing admin secret');
    throw new AdminSessionConfigError('ADMIN_SECRET_MISSING');
  }
  if (secret.length < ADMIN_SESSION_SECRET_MIN_LENGTH) {
    console.error('[admin-session] invalid admin secret length');
    throw new AdminSessionConfigError('ADMIN_SECRET_INVALID_LENGTH');
  }
  return secret;
}
