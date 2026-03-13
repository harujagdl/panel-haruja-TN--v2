const memory = globalThis.__HARUJA_LOYALTY_MEMORY__ || {
  customers: new Map(),
  history: new Map()
};
globalThis.__HARUJA_LOYALTY_MEMORY__ = memory;

const json = (res, status, payload) => res.status(status).json(payload);
const bad = (res, message, status = 400) => json(res, status, { ok: false, error: message });

const normalizeId = (value = '') => String(value || '').trim();

const nowIso = () => new Date().toISOString();

function getCustomerById(clientId) {
  const id = normalizeId(clientId);
  if (!id) return null;
  return memory.customers.get(id) || null;
}

function saveCustomer(customer = {}) {
  const clientId = normalizeId(customer.clientId || customer.id);
  if (!clientId) return null;
  const merged = {
    clientId,
    name: String(customer.name || ''),
    phone: String(customer.phone || ''),
    instagram: String(customer.instagram || ''),
    email: String(customer.email || ''),
    token: String(customer.token || clientId),
    points: Number(customer.points || 0),
    level: String(customer.level || 'Bronce'),
    totalPurchases: Number(customer.totalPurchases || 0),
    updatedAt: nowIso(),
    ...customer
  };
  memory.customers.set(clientId, merged);
  return merged;
}

function appendHistory(clientId, item) {
  const key = normalizeId(clientId);
  const current = memory.history.get(key) || [];
  current.unshift({ at: nowIso(), ...item });
  memory.history.set(key, current.slice(0, 200));
}

function listRewards() {
  return [
    { id: 'rw-100', name: 'Cupón $100', rewardPts: 100 },
    { id: 'rw-250', name: 'Cupón $250', rewardPts: 250 }
  ];
}

async function runAction(action, payload) {
  if (action === 'listRewards') return { rewards: listRewards() };

  if (action === 'listClients') {
    const limit = Math.max(1, Math.min(300, Number(payload.limit || 80) || 80));
    return { items: Array.from(memory.customers.values()).slice(0, limit) };
  }

  if (action === 'searchClients') {
    const q = String(payload.q || '').toLowerCase().trim();
    if (!q) return { items: Array.from(memory.customers.values()).slice(0, 80) };
    const items = Array.from(memory.customers.values()).filter((item) => {
      return [item.clientId, item.name, item.phone, item.email].some((value) => String(value || '').toLowerCase().includes(q));
    });
    return { items: items.slice(0, 80) };
  }

  if (action === 'getCustomer') {
    const client = getCustomerById(payload.clientId) || Array.from(memory.customers.values()).find((item) => item.token === String(payload.token || ''));
    if (!client) throw new Error('Cliente no encontrado.');
    return { customer: client, client };
  }

  if (action === 'getHistory') {
    const clientId = normalizeId(payload.clientId);
    return { items: memory.history.get(clientId) || [] };
  }

  if (action === 'registerClient') {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('name es obligatorio.');
    const clientId = normalizeId(payload.clientId || `CL-${Date.now().toString(36).toUpperCase()}`);
    const client = saveCustomer({ ...payload, clientId, token: payload.token || clientId });
    appendHistory(clientId, { type: 'register', points: 0, notes: 'Cliente registrado' });
    return { client };
  }

  if (action === 'addPoints' || action === 'addPurchase') {
    const clientId = normalizeId(payload.clientId);
    const amount = Number(payload.amount || 0);
    if (!clientId) throw new Error('clientId es obligatorio.');
    const client = getCustomerById(clientId);
    if (!client) throw new Error('Cliente no encontrado.');
    const earned = Math.max(0, Math.floor(amount));
    const updated = saveCustomer({ ...client, totalPurchases: Number(client.totalPurchases || 0) + amount, points: Number(client.points || 0) + earned });
    appendHistory(clientId, { type: 'purchase', amount, points: earned, notes: payload.notes || '' });
    return { client: updated };
  }

  if (action === 'redeemReward' || action === 'redeem') {
    const clientId = normalizeId(payload.clientId);
    const rewardPts = Math.max(0, Number(payload.rewardPts || 0));
    if (!clientId) throw new Error('clientId es obligatorio.');
    const client = getCustomerById(clientId);
    if (!client) throw new Error('Cliente no encontrado.');
    const updated = saveCustomer({ ...client, points: Math.max(0, Number(client.points || 0) - rewardPts) });
    appendHistory(clientId, { type: 'redeem', points: -rewardPts, notes: payload.notes || '' });
    return { client: updated };
  }

  if (action === 'updateClientPublic') {
    const clientId = normalizeId(payload.clientId);
    if (!clientId) throw new Error('clientId es obligatorio.');
    const current = getCustomerById(clientId);
    if (!current) throw new Error('Cliente no encontrado.');
    const updated = saveCustomer({ ...current, ...payload, clientId });
    return { client: updated };
  }

  if (action === 'addVisit') {
    const token = String(payload.token || '').trim();
    const client = Array.from(memory.customers.values()).find((item) => item.token === token);
    if (client) appendHistory(client.clientId, { type: 'visit', points: 0 });
    return { ok: true };
  }

  throw new Error('Acción loyalty no soportada.');
}

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST', 'PATCH'].includes(req.method || '')) return bad(res, 'Method not allowed.', 405);

    const action = String(req.query?.action || req.body?.action || '').trim();
    if (!action) return bad(res, 'action es obligatorio.');

    const payload = {
      ...(req.query || {}),
      ...(req.body || {})
    };

    const data = await runAction(action, payload);
    return json(res, 200, { ok: true, ...data });
  } catch (error) {
    return bad(res, error?.message || 'Error interno en /api/loyalty.', 400);
  }
}
