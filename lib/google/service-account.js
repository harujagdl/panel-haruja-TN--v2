function parseServiceAccountJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && parsed.client_email && parsed.private_key) return parsed;
  } catch (_error) {
    return null;
  }
  return null;
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

export function getGoogleServiceAccountCredentials() {
  const fromJson = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT);
  if (fromJson) {
    return {
      client_email: String(fromJson.client_email || '').trim(),
      private_key: normalizePrivateKey(fromJson.private_key),
    };
  }

  return {
    client_email: String(process.env.GOOGLE_CLIENT_EMAIL || '').trim(),
    private_key: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  };
}
