(function initLoyaltyService(global) {
  const parseJson = async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || payload?.message || 'Error loyalty');
    return payload;
  };

  const callLoyalty = async (action, payload = {}, { method = 'GET' } = {}) => {
    const isGet = method === 'GET';
    const url = new URL('/api/loyalty', global.location.origin);
    url.searchParams.set('action', action);

    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (isGet) {
      Object.entries(payload || {}).forEach(([key, value]) => {
        if (value == null || value === '') return;
        url.searchParams.set(key, String(value));
      });
    } else {
      options.body = JSON.stringify({ action, ...(payload || {}) });
    }

    const response = await fetch(url.toString(), options);
    return parseJson(response);
  };

  global.loyaltyService = {
    getCustomer: (input = {}) => callLoyalty('getCustomer', input),
    getSummary: (clientId) => callLoyalty('getCustomer', { clientId }),
    getHistory: (clientId) => callLoyalty('getHistory', { clientId }),
    getRewards: () => callLoyalty('listRewards', {}),
    listClients: (limit = 80) => callLoyalty('listClients', { limit }),
    searchClients: (q) => callLoyalty('searchClients', { q }),
    registerClient: (payload) => callLoyalty('registerClient', payload, { method: 'POST' }),
    updateClientPublic: (payload) => callLoyalty('updateClientPublic', payload, { method: 'PATCH' }),
    addPoints: (payload) => callLoyalty('addPoints', payload, { method: 'POST' }),
    addPurchase: (payload) => callLoyalty('addPurchase', payload, { method: 'POST' }),
    redeemReward: (payload) => callLoyalty('redeemReward', payload, { method: 'POST' }),
    redeem: (payload) => callLoyalty('redeem', payload, { method: 'POST' }),
    addVisit: (token) => callLoyalty('addVisit', { token }, { method: 'POST' })
  };
})(window);
