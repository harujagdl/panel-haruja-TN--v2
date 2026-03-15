import crypto from 'crypto';

export function verifyTiendanubeWebhook(rawBody, signature, secret) {
  if (!secret) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signature || '', 'utf8')
    );
  } catch {
    return false;
  }
}
