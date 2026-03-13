(function initLoyaltyService(global) {
  const ensureFirebase = () => {
    const fb = global.loyaltyFirebase;
    if (!fb || !fb.db) {
      throw new Error('Firebase de loyalty no está inicializado');
    }
    return fb;
  };

  const normalizeText = (value) => String(value || '').trim();
  const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
  const safeLower = (value) => normalizeText(value).toLowerCase();

  const nowIso = () => new Date().toISOString();

  const buildSearchIndex = ({ clientId = '', name = '', phone = '', instagram = '', email = '' }) => {
    return [
      clientId,
      name,
      phone,
      instagram,
      email
    ]
      .map((v) => safeLower(v))
      .filter(Boolean)
      .join(' ');
  };

  const makeToken = () => {
    const partA = Math.random().toString(36).slice(2, 8);
    const partB = Date.now().toString(36);
    return `hly_${partA}${partB}`;
  };

  const makeClientId = async () => {
    const fb = ensureFirebase();
    const counterRef = fb.doc(fb.db, 'loyalty_config', 'counters');
    const snap = await fb.getDoc(counterRef);

    let next = 1;
    if (snap.exists()) {
      const data = snap.data() || {};
      next = Number(data.clientSeq || 0) + 1;
    }

    await fb.setDoc(counterRef, { clientSeq: next }, { merge: true });
    return `HCL-${String(next).padStart(4, '0')}`;
  };

  const defaultClientShape = (docId, data) => ({
    id: docId,
    clientId: data.clientId || docId,
    name: data.name || '',
    phone: data.phone || '',
    instagram: data.instagram || '',
    email: data.email || '',
    points: Number(data.points || 0),
    level: data.level || 'Bronce',
    totalPurchases: Number(data.totalPurchases || 0),
    visits: Number(data.visits || 0),
    token: data.token || '',
    qrLink: data.qrLink || '',
    active: data.active !== false,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  });

  const getConfig = async () => {
    const fb = ensureFirebase();
    const ref = fb.doc(fb.db, 'loyalty_config', 'main');
    const snap = await fb.getDoc(ref);

    if (!snap.exists()) {
      const base = {
        pointsPerPeso: 0.05,
        welcomePoints: 0,
        redemptionEnabled: true,
        updatedAt: nowIso()
      };
      await fb.setDoc(ref, base, { merge: true });
      return base;
    }

    return snap.data();
  };

  const saveMovement = async ({
    clientId,
    type,
    points = 0,
    amount = 0,
    notes = '',
    rewardPts = 0,
    token = '',
    source = 'panel'
  }) => {
    const fb = ensureFirebase();

    await fb.addDoc(fb.collection(fb.db, 'loyalty_movements'), {
      clientId,
      type,
      points: Number(points || 0),
      amount: Number(amount || 0),
      rewardPts: Number(rewardPts || 0),
      notes: normalizeText(notes),
      token: normalizeText(token),
      source,
      createdAt: nowIso(),
      serverCreatedAt: fb.serverTimestamp()
    });
  };

  const getClientByDocId = async (docId) => {
    const fb = ensureFirebase();
    const ref = fb.doc(fb.db, 'loyalty_customers', docId);
    const snap = await fb.getDoc(ref);
    if (!snap.exists()) return null;
    return defaultClientShape(snap.id, snap.data());
  };

  const getClientByClientId = async (clientId) => {
    const fb = ensureFirebase();
    const q = fb.query(
      fb.collection(fb.db, 'loyalty_customers'),
      fb.where('clientId', '==', normalizeText(clientId)),
      fb.limit(1)
    );
    const snap = await fb.getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return defaultClientShape(docSnap.id, docSnap.data());
  };

  const getClientByPhone = async (phone) => {
    const fb = ensureFirebase();
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return null;

    const q = fb.query(
      fb.collection(fb.db, 'loyalty_customers'),
      fb.where('phone', '==', cleanPhone),
      fb.limit(1)
    );
    const snap = await fb.getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return defaultClientShape(docSnap.id, docSnap.data());
  };

  const getClientByToken = async (token) => {
    const fb = ensureFirebase();
    const cleanToken = normalizeText(token);
    if (!cleanToken) return null;

    const q = fb.query(
      fb.collection(fb.db, 'loyalty_customers'),
      fb.where('token', '==', cleanToken),
      fb.limit(1)
    );
    const snap = await fb.getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return defaultClientShape(docSnap.id, docSnap.data());
  };

  const getCustomer = async (input = {}) => {
    const clientId = normalizeText(input.clientId);
    const phone = normalizePhone(input.phone);
    const token = normalizeText(input.token);

    let client = null;

    if (clientId) client = await getClientByClientId(clientId);
    if (!client && phone) client = await getClientByPhone(phone);
    if (!client && token) client = await getClientByToken(token);

    return { ok: true, client };
  };

  const listClients = async (maxItems = 80) => {
    const fb = ensureFirebase();
    const q = fb.query(
      fb.collection(fb.db, 'loyalty_customers'),
      fb.orderBy('createdAt', 'desc'),
      fb.limit(Number(maxItems || 80))
    );

    const snap = await fb.getDocs(q);
    const items = snap.docs.map((d) => defaultClientShape(d.id, d.data()));
    return { ok: true, items };
  };

  const searchClients = async (qText) => {
    const text = safeLower(qText);
    if (!text) return listClients(80);

    const base = await listClients(200);
    const items = base.items.filter((item) => {
      const haystack = buildSearchIndex(item);
      return haystack.includes(text);
    });

    return { ok: true, items };
  };

  const registerClient = async (payload = {}) => {
    const fb = ensureFirebase();

    const name = normalizeText(payload.name);
    const phone = normalizePhone(payload.phone);
    const instagram = normalizeText(payload.instagram);
    const email = normalizeText(payload.email);

    if (!name) throw new Error('El nombre es obligatorio');
    if (!phone) throw new Error('El teléfono es obligatorio');

    const existingByPhone = await getClientByPhone(phone);
    if (existingByPhone) {
      throw new Error('Ya existe un cliente con ese teléfono');
    }

    const config = await getConfig();
    const clientId = await makeClientId();
    const token = makeToken();
    const welcomePoints = Number(config.welcomePoints || 0);
    const qrBaseUrl = 'https://paneltn.harujagdl.com';
    const qrLink = `${qrBaseUrl}/tarjeta-lealtad.html?token=${encodeURIComponent(token)}`;

    const docRef = await fb.addDoc(fb.collection(fb.db, 'loyalty_customers'), {
      clientId,
      name,
      phone,
      instagram,
      email,
      points: welcomePoints,
      level: 'Bronce',
      totalPurchases: 0,
      visits: 0,
      token,
      qrLink,
      active: true,
      searchIndex: buildSearchIndex({ clientId, name, phone, instagram, email }),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      serverCreatedAt: fb.serverTimestamp(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    if (welcomePoints > 0) {
      await saveMovement({
        clientId,
        type: 'welcome',
        points: welcomePoints,
        notes: 'Puntos de bienvenida'
      });
    }

    const client = await getClientByDocId(docRef.id);
    return { ok: true, client };
  };

  const updateClientPublic = async (payload = {}) => {
    const fb = ensureFirebase();

    const clientId = normalizeText(payload.clientId);
    if (!clientId) throw new Error('clientId es obligatorio');

    const current = await getClientByClientId(clientId);
    if (!current) throw new Error('Cliente no encontrado');

    const name = normalizeText(payload.name);
    const phone = normalizePhone(payload.phone);
    const instagram = normalizeText(payload.instagram);
    const email = normalizeText(payload.email);

    if (!name) throw new Error('El nombre es obligatorio');

    if (phone && phone !== current.phone) {
      const existingByPhone = await getClientByPhone(phone);
      if (existingByPhone && existingByPhone.clientId !== clientId) {
        throw new Error('Ese teléfono ya está registrado en otro cliente');
      }
    }

    const ref = fb.doc(fb.db, 'loyalty_customers', current.id);

    await fb.updateDoc(ref, {
      name,
      phone,
      instagram,
      email,
      searchIndex: buildSearchIndex({
        clientId,
        name,
        phone,
        instagram,
        email
      }),
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const addPurchase = async (payload = {}) => {
    const fb = ensureFirebase();

    const clientId = normalizeText(payload.clientId);
    const amount = Number(payload.amount || 0);
    const notes = normalizeText(payload.notes);

    if (!clientId) throw new Error('clientId es obligatorio');
    if (!amount || amount <= 0) throw new Error('Monto inválido');

    const config = await getConfig();
    const current = await getClientByClientId(clientId);
    if (!current) throw new Error('Cliente no encontrado');

    const pointsPerPeso = Number(config.pointsPerPeso || 0);
    const pointsEarned = Math.max(0, Math.floor(amount * pointsPerPeso));

    const ref = fb.doc(fb.db, 'loyalty_customers', current.id);

    await fb.updateDoc(ref, {
      points: Number(current.points || 0) + pointsEarned,
      totalPurchases: Number(current.totalPurchases || 0) + amount,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({
      clientId,
      type: 'purchase',
      points: pointsEarned,
      amount,
      notes
    });

    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const redeemReward = async (payload = {}) => {
    const fb = ensureFirebase();

    const clientId = normalizeText(payload.clientId);
    const rewardPts = Number(payload.rewardPts || 0);
    const notes = normalizeText(payload.notes);

    if (!clientId) throw new Error('clientId es obligatorio');
    if (!rewardPts || rewardPts <= 0) throw new Error('Selecciona un canje válido');

    const config = await getConfig();
    if (config.redemptionEnabled === false) {
      throw new Error('El canje está deshabilitado');
    }

    const current = await getClientByClientId(clientId);
    if (!current) throw new Error('Cliente no encontrado');
    if (Number(current.points || 0) < rewardPts) {
      throw new Error('Puntos insuficientes');
    }

    const ref = fb.doc(fb.db, 'loyalty_customers', current.id);

    await fb.updateDoc(ref, {
      points: Number(current.points || 0) - rewardPts,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({
      clientId,
      type: 'redeem',
      points: -rewardPts,
      rewardPts,
      notes
    });

    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const getHistory = async (clientId) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(clientId);
    if (!cleanId) throw new Error('clientId es obligatorio');

    const q = fb.query(
      fb.collection(fb.db, 'loyalty_movements'),
      fb.where('clientId', '==', cleanId)
    );

    const snap = await fb.getDocs(q);
    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return { ok: true, items };
  };

  const getRewards = async () => {
    const fb = ensureFirebase();
    const snap = await fb.getDocs(fb.collection(fb.db, 'loyalty_rewards'));
    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((item) => item.activo !== false && item.active !== false);

    return { ok: true, items };
  };

  const addPoints = async (payload = {}) => {
    const fb = ensureFirebase();

    const clientId = normalizeText(payload.clientId);
    const points = Number(payload.points || 0);
    const notes = normalizeText(payload.notes);

    if (!clientId) throw new Error('clientId es obligatorio');
    if (!points || points <= 0) throw new Error('Puntos inválidos');

    const current = await getClientByClientId(clientId);
    if (!current) throw new Error('Cliente no encontrado');

    const ref = fb.doc(fb.db, 'loyalty_customers', current.id);

    await fb.updateDoc(ref, {
      points: Number(current.points || 0) + points,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({
      clientId,
      type: 'manual_points',
      points,
      notes
    });

    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const redeem = async (payload = {}) => redeemReward(payload);

  const addVisit = async (token) => {
    const fb = ensureFirebase();

    const cleanToken = normalizeText(token);
    if (!cleanToken) throw new Error('Token inválido');

    const current = await getClientByToken(cleanToken);
    if (!current) throw new Error('Cliente no encontrado');

    const ref = fb.doc(fb.db, 'loyalty_customers', current.id);

    await fb.updateDoc(ref, {
      visits: Number(current.visits || 0) + 1,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({
      clientId: current.clientId,
      type: 'visit',
      token: cleanToken,
      notes: 'Visita registrada desde tarjeta'
    });

    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  global.loyaltyService = {
    getCustomer,
    getSummary: async (clientId) => getCustomer({ clientId }),
    getHistory,
    getRewards,
    listClients,
    searchClients,
    registerClient,
    updateClientPublic,
    addPoints,
    addPurchase,
    redeemReward,
    redeem,
    addVisit
  };
})(window);
