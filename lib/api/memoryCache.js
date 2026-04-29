function getStore() {
  if (!globalThis.__apiMemoryCacheStore) {
    globalThis.__apiMemoryCacheStore = new Map();
  }
  return globalThis.__apiMemoryCacheStore;
}

export async function getOrSetMemoryCache(cacheKey, ttlMs, loader) {
  const key = String(cacheKey || '').trim();
  if (!key) return loader();
  const ttl = Number(ttlMs || 0);
  const now = Date.now();
  const store = getStore();
  const current = store.get(key);

  if (current?.data !== undefined && Number(current.expiresAt || 0) > now) {
    return current.data;
  }
  if (current?.promise) {
    return current.promise;
  }

  const promise = (async () => {
    const data = await loader();
    store.set(key, {
      data,
      expiresAt: now + Math.max(0, ttl),
      promise: null,
    });
    return data;
  })();

  store.set(key, {
    data: current?.data,
    expiresAt: current?.expiresAt || 0,
    promise,
  });

  try {
    return await promise;
  } catch (error) {
    const latest = store.get(key);
    if (latest?.promise === promise) {
      store.delete(key);
    }
    throw error;
  }
}

export function invalidateMemoryCache(cacheKey = '') {
  const key = String(cacheKey || '').trim();
  const store = getStore();
  if (!key) {
    store.clear();
    return;
  }
  store.delete(key);
}
