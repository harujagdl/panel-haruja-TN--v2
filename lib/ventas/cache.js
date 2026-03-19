const TTL_MS = Number(process.env.VENTAS_FULL_CACHE_TTL_MS || 45_000);

function getStore() {
  if (!globalThis.__ventasFullCacheStore) {
    globalThis.__ventasFullCacheStore = new Map();
  }
  return globalThis.__ventasFullCacheStore;
}

export function getVentasFullCache(monthKey) {
  const key = String(monthKey || '').trim();
  if (!key) return { hit: false, stale: null };
  const entry = getStore().get(key);
  if (!entry) return { hit: false, stale: null };
  const age = Date.now() - Number(entry.timestamp || 0);
  if (age <= TTL_MS) return { hit: true, data: entry.data, stale: entry.data };
  return { hit: false, stale: entry.data };
}

export function setVentasFullCache(monthKey, data) {
  const key = String(monthKey || '').trim();
  if (!key) return;
  getStore().set(key, {
    data,
    timestamp: Date.now(),
  });
}

export function invalidateVentasFullCache(monthKey = '') {
  const key = String(monthKey || '').trim();
  if (!key) {
    getStore().clear();
    return;
  }
  getStore().delete(key);
}
