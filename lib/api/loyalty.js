import crypto from 'node:crypto';
import { getAdminDb } from '../firestore/admin.js';

const COLLECTIONS = {
  clients: 'loyalty_clients',
  movements: 'loyalty_movements',
  visits: 'loyalty_visits',
  config: 'loyalty_config'
};

const DEFAULT_CONFIG = {
  pointsPerPeso: 1,
  rewardOptions: [
    { label: '150 pts', points: 150 },
    { label: '300 pts', points: 300 },
    { label: '500 pts', points: 500 },
    { label: '800 pts', points: 800 }
  ],
  levels: [
    { minPoints: 0, name: 'Bronce' },
    { minPoints: 300, name: 'Plata' },
    { minPoints: 700, name: 'Oro' }
  ],
  publicBaseUrl: 'https://haruja-panel.vercel.app'
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function buildQrLink(token, config = DEFAULT_CONFIG) {
  const base = String(config.publicBaseUrl || DEFAULT_CONFIG.publicBaseUrl).replace(/\/$/, '');
  return `${base}/tarjeta-lealtad.html?token=${encodeURIComponent(token)}`;
}

function mapClientForFrontend(client, config) {
  return {
    clientId: client.clientId,
    name: client.name || '',
    phone: client.phone || '',
    instagram: client.instagram || '',
    email: client.email || '',
    token: client.token || '',
    points: toNumber(client.points),
    level: client.level || 'Bronce',
    totalPurchases: toNumber(client.totalPurchases),
    qrLink: client.qrLink || buildQrLink(client.token || '', config)
  };
}

function getClientLevel(points, levels = []) {
  const safeLevels = Array.isArray(levels) && levels.length ? levels : DEFAULT_CONFIG.levels;
  const sorted = [...safeLevels].sort((a, b) => toNumber(a.minPoints) - toNumber(b.minPoints));
  let levelName = sorted[0]?.name || 'Bronce';
  for (const level of sorted) {
    if (points >= toNumber(level.minPoints)) levelName = level.name;
  }
  return levelName;
}

async function getConfig(db) {
  const docRef = db.collection(COLLECTIONS.config).doc('main');
  const snap = await docRef.get();
  if (!snap.exists) {
    await docRef.set({ ...DEFAULT_CONFIG, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true });
    return { ...DEFAULT_CONFIG };
  }
  const data = snap.data() || {};
  return {
    pointsPerPeso: toNumber(data.pointsPerPeso, DEFAULT_CONFIG.pointsPerPeso),
    rewardOptions: Array.isArray(data.rewardOptions) ? data.rewardOptions : DEFAULT_CONFIG.rewardOptions,
    levels: Array.isArray(data.levels) ? data.levels : DEFAULT_CONFIG.levels,
    publicBaseUrl: String(data.publicBaseUrl || DEFAULT_CONFIG.publicBaseUrl)
  };
}

async function getNextClientId(db) {
  const counterRef = db.collection('_counters').doc('loyalty_clients');
  const next = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const seq = toNumber(snap.exists ? snap.data()?.seq : 0) + 1;
    tx.set(counterRef, { seq, updatedAt: new Date().toISOString() }, { merge: true });
    return seq;
  });
  return `HCL-${String(next).padStart(4, '0')}`;
}

async function generateUniqueToken(db) {
  for (let i = 0; i < 8; i += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    const existing = await db.collection(COLLECTIONS.clients).where('token', '==', token).limit(1).get();
    if (existing.empty) return token;
  }
  throw new Error('No se pudo generar token único.');
}

export async function registerClient(payload = {}) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('name es obligatorio.');

  const now = new Date().toISOString();
  const clientId = await getNextClientId(db);
  const token = await generateUniqueToken(db);
  const docId = clientId;
  const client = {
    clientId,
    name,
    phone: normalizePhone(payload.phone),
    instagram: String(payload.instagram || '').trim(),
    email: String(payload.email || '').trim(),
    token,
    points: 0,
    level: getClientLevel(0, config.levels),
    totalPurchases: 0,
    visitCount: 0,
    active: true,
    qrLink: buildQrLink(token, config),
    createdAt: now,
    updatedAt: now
  };

  await db.collection(COLLECTIONS.clients).doc(docId).set(client);
  return mapClientForFrontend(client, config);
}

export async function searchClients(q = '') {
  const db = getAdminDb();
  const config = await getConfig(db);
  const query = String(q || '').trim().toLowerCase();

  let snaps = [];
  if (!query) {
    const listSnap = await db.collection(COLLECTIONS.clients).orderBy('updatedAt', 'desc').limit(50).get();
    snaps = listSnap.docs;
  } else if (query.startsWith('hcl-')) {
    const byId = await db.collection(COLLECTIONS.clients).doc(query.toUpperCase()).get();
    snaps = byId.exists ? [byId] : [];
  } else {
    const [byPhoneSnap, byNameSnap] = await Promise.all([
      db.collection(COLLECTIONS.clients).where('phone', '==', query).limit(50).get(),
      db.collection(COLLECTIONS.clients).orderBy('name').limit(300).get()
    ]);

    const docsById = new Map();
    byPhoneSnap.docs.forEach((d) => docsById.set(d.id, d));
    byNameSnap.docs.forEach((d) => {
      const data = d.data() || {};
      const name = String(data.name || '').toLowerCase();
      const clientId = String(data.clientId || '').toLowerCase();
      const phone = String(data.phone || '').toLowerCase();
      if (name.includes(query) || clientId.includes(query) || phone.includes(query)) docsById.set(d.id, d);
    });
    snaps = [...docsById.values()];
  }

  const items = snaps
    .map((snap) => mapClientForFrontend(snap.data() || {}, config))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { items };
}

export async function listClients({ limit = 80, orderBy = 'updatedAt', sort = 'desc' } = {}) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const safeLimit = Math.max(1, Math.min(200, toNumber(limit, 80)));
  const safeOrderBy = ['updatedAt', 'name', 'createdAt'].includes(orderBy) ? orderBy : 'updatedAt';
  const safeSort = sort === 'asc' ? 'asc' : 'desc';

  const snap = await db.collection(COLLECTIONS.clients).orderBy(safeOrderBy, safeSort).limit(safeLimit).get();
  const items = snap.docs.map((doc) => mapClientForFrontend(doc.data() || {}, config));
  return { items };
}

export async function updateClientPublic(payload = {}) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const clientId = String(payload.clientId || '').trim().toUpperCase();
  if (!clientId) throw new Error('clientId es obligatorio.');

  const ref = db.collection(COLLECTIONS.clients).doc(clientId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Cliente no encontrado.');

  const updates = {
    name: String(payload.name || '').trim(),
    phone: normalizePhone(payload.phone),
    instagram: String(payload.instagram || '').trim(),
    email: String(payload.email || '').trim(),
    updatedAt: new Date().toISOString()
  };

  if (!updates.name) throw new Error('name es obligatorio.');

  await ref.set(updates, { merge: true });
  const merged = { ...(snap.data() || {}), ...updates };
  return mapClientForFrontend(merged, config);
}

export async function addPurchase(payload = {}) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const clientId = String(payload.clientId || '').trim().toUpperCase();
  const amount = toNumber(payload.amount, NaN);
  if (!clientId) throw new Error('clientId es obligatorio.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount debe ser mayor a 0.');

  const ref = db.collection(COLLECTIONS.clients).doc(clientId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Cliente no encontrado.');
  const current = snap.data() || {};

  const gainedPts = Math.round(amount * toNumber(config.pointsPerPeso, 1));
  const points = toNumber(current.points) + gainedPts;
  const totalPurchases = toNumber(current.totalPurchases) + amount;
  const level = getClientLevel(points, config.levels);
  const updatedAt = new Date().toISOString();

  await ref.set({ points, totalPurchases, level, updatedAt }, { merge: true });
  await db.collection(COLLECTIONS.movements).add({
    clientId,
    type: 'purchase',
    amount,
    rewardPts: 0,
    pointsDelta: gainedPts,
    notes: String(payload.notes || '').trim(),
    createdAt: updatedAt,
    createdBy: 'system'
  });

  return mapClientForFrontend({ ...current, points, totalPurchases, level, updatedAt }, config);
}

export async function redeem(payload = {}) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const clientId = String(payload.clientId || '').trim().toUpperCase();
  const rewardPts = Math.round(toNumber(payload.rewardPts, NaN));
  if (!clientId) throw new Error('clientId es obligatorio.');
  if (!Number.isFinite(rewardPts) || rewardPts <= 0) throw new Error('rewardPts debe ser mayor a 0.');

  const ref = db.collection(COLLECTIONS.clients).doc(clientId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Cliente no encontrado.');
  const current = snap.data() || {};

  const currentPoints = toNumber(current.points);
  if (currentPoints < rewardPts) throw new Error('Saldo insuficiente.');

  const points = currentPoints - rewardPts;
  const level = getClientLevel(points, config.levels);
  const updatedAt = new Date().toISOString();

  await ref.set({ points, level, updatedAt }, { merge: true });
  await db.collection(COLLECTIONS.movements).add({
    clientId,
    type: 'redeem',
    amount: 0,
    rewardPts,
    pointsDelta: -rewardPts,
    notes: String(payload.notes || '').trim(),
    createdAt: updatedAt,
    createdBy: 'system'
  });

  return mapClientForFrontend({ ...current, points, level, updatedAt }, config);
}

export async function getByToken(token) {
  const db = getAdminDb();
  const config = await getConfig(db);
  const safeToken = String(token || '').trim();
  if (!safeToken) throw new Error('token es obligatorio.');

  const snap = await db.collection(COLLECTIONS.clients).where('token', '==', safeToken).where('active', '==', true).limit(1).get();
  if (snap.empty) throw new Error('Cliente no encontrado.');

  const client = snap.docs[0].data() || {};
  const points = toNumber(client.points);
  const rewardOptions = (config.rewardOptions || []).map((r) => {
    const rewardPoints = toNumber(r.points ?? r.rewardPts ?? r.value, 0);
    return {
      label: String(r.label || `${rewardPoints} pts`),
      points: rewardPoints,
      available: points >= rewardPoints,
      missingPoints: Math.max(0, rewardPoints - points)
    };
  });

  return {
    name: client.name || '',
    level: client.level || getClientLevel(points, config.levels),
    points,
    totalPurchases: toNumber(client.totalPurchases),
    rewardOptions
  };
}

export async function addVisit(payload = {}) {
  const db = getAdminDb();
  const token = String(payload.token || '').trim();
  if (!token) throw new Error('token es obligatorio.');

  const snap = await db.collection(COLLECTIONS.clients).where('token', '==', token).limit(1).get();
  if (snap.empty) throw new Error('Cliente no encontrado.');
  const doc = snap.docs[0];
  const client = doc.data() || {};
  const visitedAt = new Date().toISOString();

  await db.collection(COLLECTIONS.visits).add({
    clientId: client.clientId,
    token,
    visitedAt
  });

  await doc.ref.set({ visitCount: toNumber(client.visitCount) + 1, updatedAt: visitedAt }, { merge: true });

  return { recorded: true, clientId: client.clientId };
}
