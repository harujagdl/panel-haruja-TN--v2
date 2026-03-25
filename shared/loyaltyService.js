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
  const LOYALTY_LEVEL_DEBUG =
    global?.localStorage?.getItem('haruja_loyalty_level_debug') === '1' ||
    global?.location?.search?.includes('debugLoyaltyLevel=1');
  const debugLevel = (...args) => {
    if (LOYALTY_LEVEL_DEBUG) console.debug('[loyalty-level]', ...args);
  };

  const buildSearchIndex = ({ clientId = '', name = '', phone = '', instagram = '', email = '' }) => {
    return [clientId, name, phone, instagram, email]
      .map((v) => safeLower(v))
      .filter(Boolean)
      .join(' ');
  };

  const makeToken = () => {
    const partA = Math.random().toString(36).slice(2, 8);
    const partB = Date.now().toString(36);
    return `hly_${partA}${partB}`;
  };

  const sortLevels = (items = []) => {
    return [...items].sort((a, b) => {
      const priorityDiff = Number(a.priority || 0) - Number(b.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      const minDiff = Number(a.minPoints || 0) - Number(b.minPoints || 0);
      if (minDiff !== 0) return minDiff;
      return normalizeText(a.name).localeCompare(normalizeText(b.name));
    });
  };

  const readLevelNumber = (level = {}, keys = []) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(level, key) && level[key] !== '' && level[key] !== null && level[key] !== undefined) {
        const value = Number(level[key]);
        if (!Number.isNaN(value)) return value;
      }
    }
    return null;
  };

  const normalizeLevelRange = (level = {}) => {
    const min = readLevelNumber(level, ['minPoints', 'minPts', 'min', 'puntosMin', 'rangoMin']);
    const max = readLevelNumber(level, ['maxPoints', 'maxPts', 'max', 'puntosMax', 'rangoMax']);
    const priority = readLevelNumber(level, ['priority', 'prioridad']) ?? 0;

    return {
      ...level,
      minPoints: min ?? 0,
      maxPoints: max ?? Number.MAX_SAFE_INTEGER,
      priority
    };
  };

  const normalizeBenefits = (benefits) => {
    if (!Array.isArray(benefits)) return [];
    return benefits.map((b) => normalizeText(b)).filter(Boolean);
  };

  const normalizeLevelShape = (docId, data = {}) => ({
    id: docId,
    key: normalizeText(data.key || docId),
    name: normalizeText(data.name),
    minPoints: Number(data.minPoints || 0),
    maxPoints: Number(data.maxPoints || 0),
    color: normalizeText(data.color) || '#A67C52',
    active: data.active !== false,
    priority: Number(data.priority || 0),
    benefits: normalizeBenefits(data.benefits),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  });

  const validateLevelPayload = (payload = {}, { allowEmptyBenefits = true } = {}) => {
    const name = normalizeText(payload.name);
    const minPoints = Number(payload.minPoints);
    const maxPoints = Number(payload.maxPoints);
    const priority = Number(payload.priority);
    const benefits = normalizeBenefits(payload.benefits);
    const color = normalizeText(payload.color) || '#A67C52';
    const active = payload.active !== false;

    if (!name) throw new Error('El nombre del nivel es obligatorio');
    if (Number.isNaN(minPoints)) throw new Error('minPoints debe ser numérico');
    if (Number.isNaN(maxPoints)) throw new Error('maxPoints debe ser numérico');
    if (maxPoints < minPoints) throw new Error('maxPoints debe ser mayor o igual a minPoints');
    if (Number.isNaN(priority)) throw new Error('priority debe ser numérico');
    if (!allowEmptyBenefits && !benefits.length) throw new Error('benefits no puede estar vacío');

    return { name, minPoints, maxPoints, color, active, priority, benefits };
  };

  const getNivelPorPuntos = (points, levels = []) => {
    const pts = Number(points);
    if (Number.isNaN(pts)) return null;
    const activeLevels = sortLevels(
      (levels || [])
        .filter((level) => level && level.active !== false)
        .map((level) => normalizeLevelRange(level))
        .filter((level) => level.maxPoints >= level.minPoints)
    );
    if (!activeLevels.length) return null;

    const inRange = activeLevels.filter((level) => pts >= Number(level.minPoints) && pts <= Number(level.maxPoints));
    if (inRange.length) {
      return [...inRange].sort((a, b) => {
        const spanDiff = Number(a.maxPoints - a.minPoints) - Number(b.maxPoints - b.minPoints);
        if (spanDiff !== 0) return spanDiff;
        const priorityDiff = Number(a.priority || 0) - Number(b.priority || 0);
        if (priorityDiff !== 0) return priorityDiff;
        return Number(b.minPoints || 0) - Number(a.minPoints || 0);
      })[0];
    }

    const reached = [...activeLevels]
      .filter((level) => pts >= Number(level.minPoints))
      .sort((a, b) => Number(b.maxPoints || 0) - Number(a.maxPoints || 0));
    if (reached.length) return reached[0];

    return null;
  };

  const listLevels = async () => {
    const fb = ensureFirebase();
    const snap = await fb.getDocs(fb.collection(fb.db, 'loyalty_levels'));
    const items = sortLevels(snap.docs.map((d) => normalizeLevelShape(d.id, d.data())));
    return { ok: true, items };
  };

  const getLevelById = async (id) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    const snap = await fb.getDoc(fb.doc(fb.db, 'loyalty_levels', cleanId));
    if (!snap.exists()) return { ok: true, level: null };
    return { ok: true, level: normalizeLevelShape(snap.id, snap.data()) };
  };

  const getActiveLevels = async () => {
    const base = await listLevels();
    const items = sortLevels(base.items.filter((level) => level.active !== false));
    return { ok: true, items };
  };

  const createLevel = async (payload = {}) => {
    const fb = ensureFirebase();
    const data = validateLevelPayload(payload, { allowEmptyBenefits: true });
    const docRef = await fb.addDoc(fb.collection(fb.db, 'loyalty_levels'), {
      ...data,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      serverCreatedAt: fb.serverTimestamp(),
      serverUpdatedAt: fb.serverTimestamp()
    });
    return getLevelById(docRef.id);
  };

  const updateLevel = async (payload = {}) => {
    const fb = ensureFirebase();
    const id = normalizeText(payload.id);
    if (!id) throw new Error('id es obligatorio');

    const current = await getLevelById(id);
    if (!current.level) throw new Error('Nivel no encontrado');

    const data = validateLevelPayload(payload, { allowEmptyBenefits: true });
    await fb.updateDoc(fb.doc(fb.db, 'loyalty_levels', id), {
      ...data,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });
    return getLevelById(id);
  };

  const deleteLevel = async (id) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    await fb.deleteDoc(fb.doc(fb.db, 'loyalty_levels', cleanId));
    return { ok: true };
  };

  const toggleLevel = async (id, active) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    await fb.updateDoc(fb.doc(fb.db, 'loyalty_levels', cleanId), {
      active: active === true,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });
    return getLevelById(cleanId);
  };

  const resolveLevelFields = async (points, fallbackLevel = 'Bronce') => {
    try {
      const activeLevels = await getActiveLevels();
      const level = getNivelPorPuntos(points, activeLevels.items);
      if (!level) {
        return {
          level: fallbackLevel,
          levelId: '',
          levelBenefits: [],
          levelName: fallbackLevel,
          levelColor: '',
          levelPriority: 0
        };
      }
      return {
        level: level.name,
        levelId: level.id,
        levelBenefits: normalizeBenefits(level.benefits),
        levelName: level.name,
        levelColor: normalizeText(level.color),
        levelPriority: Number(level.priority || 0)
      };
    } catch (_err) {
      return {
        level: fallbackLevel,
        levelId: '',
        levelBenefits: [],
        levelName: fallbackLevel,
        levelColor: '',
        levelPriority: 0
      };
    }
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
    levelName: data.levelName || data.nivelNombre || data.level || 'Bronce',
    levelId: data.levelId || '',
    levelColor: data.levelColor || data.nivelColor || '',
    levelPriority: Number(data.levelPriority || data.nivelPrioridad || 0),
    levelBenefits: normalizeBenefits(data.levelBenefits),
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

  const saveMovement = async ({ clientId, type, points = 0, amount = 0, notes = '', rewardPts = 0, token = '', source = 'panel' }) => {
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

  const getClientLevelSnapshot = (client = {}) => ({
    levelId: normalizeText(client.levelId || client.nivelId || client.tierId),
    levelName: normalizeText(client.levelName || client.nivelNombre || client.level || client.nivel || client.tierName),
    levelColor: normalizeText(client.levelColor || client.nivelColor),
    levelPriority: Number(client.levelPriority || client.nivelPrioridad || 0)
  });

  const persistClientLevelIfChanged = async (client, points, levels = null) => {
    const fb = ensureFirebase();
    if (!client?.id) return client;

    const resolvedLevels = Array.isArray(levels) ? levels : (await getActiveLevels()).items;
    const level = getNivelPorPuntos(points, resolvedLevels);
    const prev = getClientLevelSnapshot(client);

    debugLevel('cliente', client.clientId || client.id, 'puntos', points, 'niveles', resolvedLevels.length);
    debugLevel('nivel previo', prev, 'nivel por rango', level ? { id: level.id, name: level.name } : null);

    if (!level) return client;

    const next = {
      level: level.name,
      levelName: level.name,
      levelId: level.id,
      levelColor: normalizeText(level.color),
      levelPriority: Number(level.priority || 0),
      levelBenefits: normalizeBenefits(level.benefits),
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    };

    const changed =
      prev.levelId !== next.levelId ||
      prev.levelName !== next.levelName ||
      prev.levelColor !== next.levelColor ||
      Number(prev.levelPriority || 0) !== Number(next.levelPriority || 0);

    if (!changed) {
      debugLevel('sin cambios de nivel, no se escribe firestore');
      return { ...client, ...next };
    }

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', client.id), next);
    debugLevel('nivel actualizado en firestore', { clientId: client.clientId, ...next });
    return { ...client, ...next };
  };

  const getClientByClientId = async (clientId) => {
    const fb = ensureFirebase();
    const q = fb.query(fb.collection(fb.db, 'loyalty_customers'), fb.where('clientId', '==', normalizeText(clientId)), fb.limit(1));
    const snap = await fb.getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return defaultClientShape(docSnap.id, docSnap.data());
  };

  const getClientByPhone = async (phone) => {
    const fb = ensureFirebase();
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return null;

    const q = fb.query(fb.collection(fb.db, 'loyalty_customers'), fb.where('phone', '==', cleanPhone), fb.limit(1));
    const snap = await fb.getDocs(q);
    if (snap.empty) return null;
    const docSnap = snap.docs[0];
    return defaultClientShape(docSnap.id, docSnap.data());
  };

  const getClientByToken = async (token) => {
    const fb = ensureFirebase();
    const cleanToken = normalizeText(token);
    if (!cleanToken) return null;

    const q = fb.query(fb.collection(fb.db, 'loyalty_customers'), fb.where('token', '==', cleanToken), fb.limit(1));
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
    if (client) {
      const points = Number(client.points || 0);
      const activeLevels = await getActiveLevels();
      client = await persistClientLevelIfChanged(client, points, activeLevels.items);
    }

    return { ok: true, client };
  };

  const listClients = async (maxItems = 80) => {
    const fb = ensureFirebase();
    const q = fb.query(fb.collection(fb.db, 'loyalty_customers'), fb.orderBy('createdAt', 'desc'), fb.limit(Number(maxItems || 80)));
    const snap = await fb.getDocs(q);
    const levels = await getActiveLevels();
    const items = [];
    for (const docSnap of snap.docs) {
      const client = defaultClientShape(docSnap.id, docSnap.data());
      const synced = await persistClientLevelIfChanged(client, Number(client.points || 0), levels.items);
      items.push(synced);
    }
    return { ok: true, items };
  };

  const searchClients = async (qText) => {
    const text = safeLower(qText);
    if (!text) return listClients(80);

    const base = await listClients(200);
    const items = base.items.filter((item) => buildSearchIndex(item).includes(text));

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
    if (existingByPhone) throw new Error('Ya existe un cliente con ese teléfono');

    const config = await getConfig();
    const clientId = await makeClientId();
    const token = makeToken();
    const welcomePoints = Number(config.welcomePoints || 0);
    const levelFields = await resolveLevelFields(welcomePoints, 'Bronce');
    const qrBaseUrl = window.location.origin;
    const qrLink = `${qrBaseUrl}/tarjeta-lealtad?token=${encodeURIComponent(token)}`;

    const docRef = await fb.addDoc(fb.collection(fb.db, 'loyalty_customers'), {
      clientId,
      name,
      phone,
      instagram,
      email,
      points: welcomePoints,
      ...levelFields,
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
      await saveMovement({ clientId, type: 'welcome', points: welcomePoints, notes: 'Puntos de bienvenida' });
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

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', current.id), {
      name,
      phone,
      instagram,
      email,
      searchIndex: buildSearchIndex({ clientId, name, phone, instagram, email }),
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
    const nextPoints = Number(current.points || 0) + pointsEarned;
    const levelFields = await resolveLevelFields(nextPoints, current.level || 'Bronce');

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', current.id), {
      points: nextPoints,
      ...levelFields,
      totalPurchases: Number(current.totalPurchases || 0) + amount,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({ clientId, type: 'purchase', points: pointsEarned, amount, notes });
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
    if (config.redemptionEnabled === false) throw new Error('El canje está deshabilitado');

    const current = await getClientByClientId(clientId);
    if (!current) throw new Error('Cliente no encontrado');
    if (Number(current.points || 0) < rewardPts) throw new Error('Puntos insuficientes');

    const nextPoints = Number(current.points || 0) - rewardPts;
    const levelFields = await resolveLevelFields(nextPoints, current.level || 'Bronce');

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', current.id), {
      points: nextPoints,
      ...levelFields,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({ clientId, type: 'redeem', points: -rewardPts, rewardPts, notes });
    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const getHistory = async (clientId) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(clientId);
    if (!cleanId) throw new Error('clientId es obligatorio');

    const q = fb.query(fb.collection(fb.db, 'loyalty_movements'), fb.where('clientId', '==', cleanId));
    const snap = await fb.getDocs(q);
    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return { ok: true, items };
  };

  const getRewards = async () => {
    const fb = ensureFirebase();
    const snap = await fb.getDocs(fb.collection(fb.db, 'loyalty_rewards'));
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((item) => item.activo !== false && item.active !== false);
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

    const nextPoints = Number(current.points || 0) + points;
    const levelFields = await resolveLevelFields(nextPoints, current.level || 'Bronce');

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', current.id), {
      points: nextPoints,
      ...levelFields,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    await saveMovement({ clientId, type: 'manual_points', points, notes });
    const client = await getClientByDocId(current.id);
    return { ok: true, client };
  };

  const redeem = async (payload = {}) => redeemReward(payload);

  const normalizePromotionDates = ({ startAt, endAt }) => {
    const parsedStart = normalizeText(startAt) ? new Date(startAt) : null;
    const parsedEnd = normalizeText(endAt) ? new Date(endAt) : null;

    if (parsedStart && Number.isNaN(parsedStart.getTime())) throw new Error('startAt inválida');
    if (parsedEnd && Number.isNaN(parsedEnd.getTime())) throw new Error('endAt inválida');

    return {
      startAtIso: parsedStart ? parsedStart.toISOString() : null,
      endAtIso: parsedEnd ? parsedEnd.toISOString() : null
    };
  };

  const normalizePromotionLevels = (levels = []) => {
    if (!Array.isArray(levels)) return [];
    const values = levels.map((level) => normalizeText(level)).filter(Boolean);
    return Array.from(new Set(values));
  };

  const normalizePromotionShape = (docId, data = {}) => ({
    id: docId,
    title: normalizeText(data.title),
    description: normalizeText(data.description),
    tag: normalizeText(data.tag),
    levels: normalizePromotionLevels(data.levels),
    active: data.active === true,
    startAt: normalizeText(data.startAt) || null,
    endAt: normalizeText(data.endAt) || null,
    priority: Number(data.priority || 0),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  });

  const sortPromotions = (items = []) => {
    return [...items].sort((a, b) => {
      const priorityDiff = Number(a.priority || 0) - Number(b.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return String(b.startAt || '').localeCompare(String(a.startAt || ''));
    });
  };

  const listPromotions = async () => {
    const fb = ensureFirebase();
    const snap = await fb.getDocs(fb.collection(fb.db, 'loyalty_promotions'));
    const items = sortPromotions(snap.docs.map((d) => normalizePromotionShape(d.id, d.data())));
    return { ok: true, items };
  };

  const getPromotionById = async (id) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    const snap = await fb.getDoc(fb.doc(fb.db, 'loyalty_promotions', cleanId));
    if (!snap.exists()) return { ok: true, promotion: null };
    return { ok: true, promotion: normalizePromotionShape(snap.id, snap.data()) };
  };

  const createPromotion = async (payload = {}) => {
    const fb = ensureFirebase();
    const title = normalizeText(payload.title);
    const description = normalizeText(payload.description);
    const tag = normalizeText(payload.tag);
    const levels = normalizePromotionLevels(payload.levels);
    const priority = Number(payload.priority || 0);
    const active = payload.active !== false;
    const { startAtIso, endAtIso } = normalizePromotionDates(payload);

    if (!title) throw new Error('El título es obligatorio');
    if (!description) throw new Error('La descripción es obligatoria');
    if (!levels.length) throw new Error('Selecciona al menos un nivel');
    if (Number.isNaN(priority)) throw new Error('La prioridad debe ser numérica');
    if (startAtIso && endAtIso && endAtIso < startAtIso) throw new Error('La fecha final no puede ser menor a la inicial');

    const docRef = await fb.addDoc(fb.collection(fb.db, 'loyalty_promotions'), {
      title,
      description,
      tag,
      levels,
      active,
      startAt: startAtIso,
      endAt: endAtIso,
      priority,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      serverCreatedAt: fb.serverTimestamp(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    return getPromotionById(docRef.id);
  };

  const updatePromotion = async (payload = {}) => {
    const fb = ensureFirebase();
    const id = normalizeText(payload.id);
    if (!id) throw new Error('id es obligatorio');

    const current = await getPromotionById(id);
    if (!current.promotion) throw new Error('Promoción no encontrada');

    const title = normalizeText(payload.title);
    const description = normalizeText(payload.description);
    const tag = normalizeText(payload.tag);
    const levels = normalizePromotionLevels(payload.levels);
    const priority = Number(payload.priority || 0);
    const active = payload.active === true;
    const { startAtIso, endAtIso } = normalizePromotionDates(payload);

    if (!title) throw new Error('El título es obligatorio');
    if (!description) throw new Error('La descripción es obligatoria');
    if (!levels.length) throw new Error('Selecciona al menos un nivel');
    if (Number.isNaN(priority)) throw new Error('La prioridad debe ser numérica');
    if (startAtIso && endAtIso && endAtIso < startAtIso) throw new Error('La fecha final no puede ser menor a la inicial');

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_promotions', id), {
      title,
      description,
      tag,
      levels,
      active,
      startAt: startAtIso,
      endAt: endAtIso,
      priority,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });

    return getPromotionById(id);
  };

  const deletePromotion = async (id) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    await fb.deleteDoc(fb.doc(fb.db, 'loyalty_promotions', cleanId));
    return { ok: true };
  };

  const togglePromotion = async (id, active) => {
    const fb = ensureFirebase();
    const cleanId = normalizeText(id);
    if (!cleanId) throw new Error('id es obligatorio');
    await fb.updateDoc(fb.doc(fb.db, 'loyalty_promotions', cleanId), {
      active: active === true,
      updatedAt: nowIso(),
      serverUpdatedAt: fb.serverTimestamp()
    });
    return getPromotionById(cleanId);
  };

  const isPromotionCurrentlyValid = (promotion, nowDate = new Date()) => {
    if (!promotion || promotion.active !== true) return false;
    const nowTime = nowDate.getTime();
    const startTime = promotion.startAt ? new Date(promotion.startAt).getTime() : null;
    const endTime = promotion.endAt ? new Date(promotion.endAt).getTime() : null;
    if (startTime && nowTime < startTime) return false;
    if (endTime && nowTime > endTime) return false;
    return true;
  };

  const getActivePromotions = async () => {
    const base = await listPromotions();
    const nowDate = new Date();
    const items = base.items.filter((promotion) => isPromotionCurrentlyValid(promotion, nowDate));
    return { ok: true, items: sortPromotions(items) };
  };

  const getPromotionsForLevel = async (levelKey) => {
    const cleanLevel = normalizeText(levelKey);
    if (!cleanLevel) throw new Error('levelKey es obligatorio');
    const lowerLevel = cleanLevel.toLowerCase();
    const base = await getActivePromotions();
    const items = base.items.filter((promotion) => {
      return promotion.levels.some((value) => value === cleanLevel || safeLower(value) === lowerLevel);
    });
    return { ok: true, items: sortPromotions(items) };
  };

  const addVisit = async (token) => {
    const fb = ensureFirebase();
    const cleanToken = normalizeText(token);
    if (!cleanToken) throw new Error('Token inválido');

    const current = await getClientByToken(cleanToken);
    if (!current) throw new Error('Cliente no encontrado');

    await fb.updateDoc(fb.doc(fb.db, 'loyalty_customers', current.id), {
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
    getNivelPorPuntos,
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
    addVisit,
    listPromotions,
    createPromotion,
    updatePromotion,
    deletePromotion,
    togglePromotion,
    getPromotionById,
    getActivePromotions,
    getPromotionsForLevel,
    isPromotionCurrentlyValid,
    listLevels,
    createLevel,
    updateLevel,
    deleteLevel,
    toggleLevel,
    getLevelById,
    getActiveLevels,
    resolveLevel: getNivelPorPuntos
  };
})(window);
