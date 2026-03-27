import { createSheetsClient, getSpreadsheetId } from "../google/sheetsClient.js";
import { calcularUtilidadYMargenDesdeBaseVenta, normalizeNumber as normalizePricingNumber } from "../../shared/pricing-utils.js";

const TARGET_SHEET_CANDIDATES = ["prendas_admin", "prendas_admin_activas"];
const TARGET_SHEET = "prendas_admin_activas";
const ARCHIVE_SHEET = "prendas_admin_archivo";
const CATEGORY_DICTIONARY_SHEET = "diccionario_tipos";
const COLOR_DICTIONARY_SHEET = "diccionario_colores";
const SIZE_DICTIONARY_SHEET = "diccionario_tallas";
const CODE_COLUMN_INDEX = 1;
const CODE_HEADER = "Código";
const ARCHIVED_AT_HEADER = "ArchivedAt";
const CODE_COLUMN_RANGE = "B2:B";
const GENERATE_CODE_CACHE_TTL_MS = 20 * 1000;
const SHEET_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const CREATE_DEDUPE_TTL_MS = 15 * 1000;

const ADMIN_COLUMNS = [
  "Orden", "Código", "Descripción", "Tipo", "Color", "Talla", "Proveedor", "TN", "Status", "Disponibilidad", "Existencia", "Fecha", "Precio", "Costo", "Margen", "Utilidad", "InventorySource", "LastInventorySyncAt"
];

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeValue = (value) => String(value ?? "").trim().toUpperCase();
const normalizeCodeBase = (code) => {
  const raw = normalizeValue(code);
  if (!raw) return "";
  return raw.split("/")[0].trim();
};

const compactContiguousDuplicateFragment = (value) => {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";

  const [base = "", detail = ""] = normalized.split(/\s+-\s+/, 2).map((part) => String(part || "").trim());
  if (base && detail) {
    const baseLower = base.toLowerCase();
    const detailLower = detail.toLowerCase();
    if (detailLower === baseLower || detailLower.startsWith(`${baseLower} `)) {
      return base;
    }
  }

  return normalized;
};
const parseCodeParts = (code) => {
  const rawCode = normalizeValue(code);
  if (!rawCode) return { tipo: "", color: "", talla: "" };

  const [base = "", suffix = ""] = rawCode.split("/");
  const tipoMatch = base.match(/^HA[A-Z0-9]([A-Z0-9])[A-Z0-9]{3}$/i);
  const suffixMatch = suffix.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/i);

  return {
    tipo: normalizeValue(tipoMatch?.[1] || ""),
    color: normalizeValue(suffixMatch?.[1] || ""),
    talla: normalizeValue(suffixMatch?.[2] || "")
  };
};

const normalizeDictionaryKey = (value) => normalizeValue(value);
const sheetsReadCounters = new Map();
let activeSheetNameCache = { value: "", at: 0 };
let codeColumnCache = { values: [], at: 0, promise: null };
let createPrendaLock = Promise.resolve();
let createPrendaQueueDepth = 0;
const recentCreateCache = new Map();

const trackSheetsRead = (action, details = {}) => {
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const key = `${action}:${minuteBucket}`;
  const count = (sheetsReadCounters.get(key) || 0) + 1;
  sheetsReadCounters.set(key, count);
  console.log("[prendas-sheets-read]", { action, count, minuteBucket, ...details });
};
const invalidateGenerateCodeCache = () => {
  codeColumnCache = { values: [], at: 0, promise: null };
};

const withCreatePrendaLock = async (callback) => {
  if (createPrendaQueueDepth > 0) {
    console.log("[create-prenda] order collision prevented/resolved", { queuedRequests: createPrendaQueueDepth + 1 });
  }
  createPrendaQueueDepth += 1;
  const run = createPrendaLock.then(() => callback());
  createPrendaLock = run.catch(() => {});
  try {
    return await run;
  } finally {
    createPrendaQueueDepth = Math.max(0, createPrendaQueueDepth - 1);
  }
};

const cleanupRecentCreateCache = () => {
  const now = Date.now();
  for (const [key, entry] of recentCreateCache.entries()) {
    if (!entry || (now - Number(entry.at || 0)) > CREATE_DEDUPE_TTL_MS) {
      recentCreateCache.delete(key);
    }
  }
};

const createStableCreateKey = (payload = {}) => {
  const normalize = (value) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const stableData = {
    tipo: normalize(payload.tipo),
    proveedor: normalize(payload.proveedor),
    color: normalize(payload.color),
    talla: normalize(payload.talla),
    detalles: normalize(payload.detalles),
    creadoPor: normalize(payload.creadoPor),
    codigo: normalize(payload.codigo),
  };
  return JSON.stringify(stableData);
};

async function readDictionaryByKey(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!B2:C`
  });
  const rows = Array.isArray(response?.data?.values) ? response.data.values : [];
  const byKey = new Map();
  rows.forEach((row = []) => {
    const key = normalizeDictionaryKey(row?.[0]);
    const value = String(row?.[1] ?? "").trim();
    if (!key || !value || byKey.has(key)) return;
    byKey.set(key, value);
  });
  return byKey;
}

async function buildPrendaDescripcion(sheets, payload = {}) {
  const parsedFromCode = parseCodeParts(payload.codigo);
  const tipoInput = String(payload.tipo ?? payload.tipoNombre ?? payload.typeName ?? "").trim();
  const colorInput = String(payload.color ?? payload.colorNombre ?? payload.colorName ?? "").trim();
  const tallaInput = String(payload.talla ?? payload.tallaNombre ?? payload.tallaName ?? "").trim();
  const detallesLimpios = String(payload.detalles ?? "").trim().replace(/\s+/g, " ");

  if (!tipoInput && !colorInput && !tallaInput && !parsedFromCode.tipo && !parsedFromCode.color && !parsedFromCode.talla) {
    return compactContiguousDuplicateFragment(String(payload.descripcion || "").trim().replace(/\s+/g, " "));
  }

  const [categoriesByKey, colorsByKey, sizesByKey] = await Promise.all([
    readDictionaryByKey(sheets, CATEGORY_DICTIONARY_SHEET),
    readDictionaryByKey(sheets, COLOR_DICTIONARY_SHEET),
    readDictionaryByKey(sheets, SIZE_DICTIONARY_SHEET)
  ]);

  const resolveDisplayValue = (inputValue, dictionaryMap, fallbackKey) => {
    const cleanInput = String(inputValue || "").trim();
    const inputKey = normalizeDictionaryKey(cleanInput);
    if (inputKey && dictionaryMap.has(inputKey)) return dictionaryMap.get(inputKey);
    if (cleanInput) return cleanInput;
    const key = normalizeDictionaryKey(fallbackKey);
    if (key && dictionaryMap.has(key)) return dictionaryMap.get(key);
    return "";
  };

  const nombreCategoria = resolveDisplayValue(tipoInput, categoriesByKey, parsedFromCode.tipo);
  const nombreColor = resolveDisplayValue(colorInput, colorsByKey, parsedFromCode.color);
  const nombreTalla = resolveDisplayValue(tallaInput, sizesByKey, parsedFromCode.talla);

  const descripcionBase = [nombreCategoria, nombreColor, nombreTalla].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!descripcionBase) return compactContiguousDuplicateFragment(String(payload.descripcion || "").trim().replace(/\s+/g, " "));
  return compactContiguousDuplicateFragment(detallesLimpios ? `${descripcionBase} - ${detallesLimpios}` : descripcionBase);
}

const extractNextConsecutiveForPrefix = (prefix, baseCodigos) => {
  const normalizedPrefix = normalizeValue(prefix);
  const codigosArray = Array.isArray(baseCodigos) ? baseCodigos : [];
  const escapedPrefix = normalizedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const consecutiveRegex = new RegExp(`^${escapedPrefix}(\\d{3})`);

  const codigosCoincidentes = codigosArray
    .map((code) => normalizeCodeBase(code))
    .filter((baseCode) => baseCode.startsWith(normalizedPrefix));

  const consecutivos = codigosCoincidentes
    .map((baseCode) => {
      const match = baseCode.match(consecutiveRegex);
      return match ? Number.parseInt(match[1], 10) : 0;
    })
    .filter((value) => Number.isFinite(value));

  const maxConsecutivo = consecutivos.length ? Math.max(...consecutivos) : 0;
  return { codigosCoincidentes, maxConsecutivo, nextConsecutive: maxConsecutivo + 1 };
};

const getNextOrden = async (sheets) => {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A2:A` });
  const rows = response?.data?.values || [];
  const maxOrden = rows.reduce((acc, row) => Math.max(acc, asNumber(row?.[0], 0)), 0);
  return maxOrden + 1;
};

async function getSpreadsheetSheetNames(sheets) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  return (metadata?.data?.sheets || []).map((sheet) => String(sheet?.properties?.title || "").trim()).filter(Boolean);
}


async function getFirstExistingSheetName(sheets, candidates = []) {
  const now = Date.now();
  if (activeSheetNameCache.value && (now - activeSheetNameCache.at) < SHEET_NAME_CACHE_TTL_MS) {
    return activeSheetNameCache.value;
  }
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  for (const candidate of candidates) {
    if (sheetNames.includes(candidate)) {
      activeSheetNameCache = { value: candidate, at: now };
      return candidate;
    }
  }
  throw new Error(`No existe ninguna de las hojas esperadas: ${candidates.join(', ')}.`);
}

async function getPrendaCodesForGenerate(sheets) {
  const now = Date.now();
  if ((now - codeColumnCache.at) < GENERATE_CODE_CACHE_TTL_MS && Array.isArray(codeColumnCache.values)) {
    console.log("[generar-codigo] cache hit", { ttlMs: GENERATE_CODE_CACHE_TTL_MS });
    return codeColumnCache.values;
  }
  if (codeColumnCache.promise) {
    console.log("[generar-codigo] request deduplicated");
    return codeColumnCache.promise;
  }

  codeColumnCache.promise = (async () => {
    const sheetName = await getFirstExistingSheetName(sheets, TARGET_SHEET_CANDIDATES);
    const range = `${sheetName}!${CODE_COLUMN_RANGE}`;
    trackSheetsRead("generar-codigo", { range });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range });
    const values = Array.isArray(response?.data?.values) ? response.data.values : [];
    const codes = values
      .map((row) => normalizeValue(row?.[0] || ""))
      .filter(Boolean);
    codeColumnCache = { values: codes, at: Date.now(), promise: null };
    return codes;
  })();

  try {
    return await codeColumnCache.promise;
  } finally {
    if (codeColumnCache.promise) {
      codeColumnCache.promise = null;
    }
  }
}

async function getPrendaCodesSnapshot(sheets) {
  const sheetName = await getFirstExistingSheetName(sheets, TARGET_SHEET_CANDIDATES);
  const range = `${sheetName}!${CODE_COLUMN_RANGE}`;
  trackSheetsRead("create-prenda-codes", { range });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  return values.map((row) => normalizeValue(row?.[0] || "")).filter(Boolean);
}

const getSuffixFromCode = (code, fallbackColor = "", fallbackTalla = "") => {
  const normalized = normalizeValue(code);
  const match = normalized.match(/\/([A-Z0-9]+)-([A-Z0-9]+)$/);
  if (match) return `${match[1]}-${match[2]}`;
  const color = normalizeValue(fallbackColor);
  const talla = normalizeValue(fallbackTalla);
  if (!color || !talla) return "";
  return `${color}-${talla}`;
};

async function resolveAvailableCodigo(sheets, payload = {}) {
  const requestedCodigo = normalizeValue(payload.codigo || payload.codigoPreview || "");
  if (!requestedCodigo) throw new Error("El campo 'codigo' es obligatorio.");
  const existingCodes = await getPrendaCodesSnapshot(sheets);
  const existingSet = new Set(existingCodes.map((code) => normalizeValue(code)));
  if (!existingSet.has(requestedCodigo)) {
    return { codigoFinal: requestedCodigo, codigoChanged: false };
  }

  const requestedBase = normalizeCodeBase(requestedCodigo);
  const prefixMatch = requestedBase.match(/^(HA[A-Z0-9]{2})(\d{3})$/);
  if (!prefixMatch) {
    throw new Error("El código solicitado ya existe. Genera un nuevo código antes de guardar.");
  }

  const prefix = prefixMatch[1];
  const suffix = getSuffixFromCode(requestedCodigo, payload.color, payload.talla);
  const { nextConsecutive } = extractNextConsecutiveForPrefix(prefix, existingCodes);
  let consecutive = nextConsecutive;
  let attempts = 0;
  let codigoFinal = requestedCodigo;

  while (attempts < 1000) {
    const baseCode = `${prefix}${String(consecutive).padStart(3, "0")}`;
    const candidate = suffix ? `${baseCode}/${suffix}` : baseCode;
    if (!existingSet.has(candidate)) {
      codigoFinal = candidate;
      break;
    }
    consecutive += 1;
    attempts += 1;
  }

  if (normalizeValue(codigoFinal) === requestedCodigo) {
    throw new Error("No se encontró un código disponible para guardar.");
  }
  console.log("[create-prenda] code collision detected, recalculated", {
    requestedCodigo,
    codigoFinal
  });
  return { codigoFinal, codigoChanged: true };
}

async function getSheetHeaders(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A1:ZZ1` });
  return (response?.data?.values?.[0] || []).map((header) => String(header || "").trim());
}

async function readSheetRows(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A:ZZ` });
  const values = response?.data?.values || [];
  const headers = (values[0] || []).map((header) => String(header || "").trim());
  const rows = values.slice(1).map((row, index) => {
    const sourceRowObject = {};
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      sourceRowObject[header] = String(row?.[columnIndex] || "").trim();
    });
    return { rowNumber: index + 2, values: row, sourceRowObject };
  });
  return { headers, rows };
}

async function appendSheetRow(sheets, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { majorDimension: "ROWS", values: [values] }
  });
}

async function getSheetId(sheets, sheetName) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId(), includeGridData: false });
  const targetSheet = (metadata?.data?.sheets || []).find((sheet) => sheet?.properties?.title === sheetName);
  return targetSheet?.properties?.sheetId;
}

async function deleteSheetRow(sheets, sheetName, rowNumber) {
  const sheetId = await getSheetId(sheets, sheetName);
  if (!Number.isInteger(sheetId)) throw new Error(`No se pudo resolver la hoja: ${sheetName}.`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }] }
  });
}

function buildRowByTargetHeaders(sourceRowObject, targetHeaders, extraValues = {}) {
  return (Array.isArray(targetHeaders) ? targetHeaders : []).map((header) => {
    const safeHeader = String(header || "").trim();
    if (!safeHeader) return "";
    if (Object.prototype.hasOwnProperty.call(extraValues, safeHeader)) return extraValues[safeHeader];
    if (Object.prototype.hasOwnProperty.call(sourceRowObject || {}, safeHeader)) return sourceRowObject[safeHeader];
    return "";
  });
}

export async function listPrendas() {
  const sheets = createSheetsClient({ readOnly: true });
  const sheetName = await getFirstExistingSheetName(sheets, TARGET_SHEET_CANDIDATES);
  console.log('[Sheets] hoja consultada prendas:', sheetName);
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${sheetName}!A1:R3000` });
  const rows = response?.data?.values || [];
  if (!rows.length) return [];
  const headers = rows[0];
  if (!headers.length) {
    throw new Error(`La hoja ${sheetName} no tiene encabezados.`);
  }
  const requiredHeaders = ["Código"];
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`Falta la columna ${missing[0]} en la hoja ${sheetName}.`);
  }
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => { obj[header] = row[i] ?? ""; });
    return obj;
  });
}

export async function createPrenda(payload = {}) {
  const sheets = createSheetsClient();
  const dedupeKey = createStableCreateKey(payload);
  cleanupRecentCreateCache();
  const cached = recentCreateCache.get(dedupeKey);
  if (cached?.result && (Date.now() - cached.at) < CREATE_DEDUPE_TTL_MS) {
    console.log("[create-prenda] duplicate create prevented", { dedupeKey });
    return { ...cached.result, duplicateRequest: true };
  }
  if (cached?.promise && (Date.now() - cached.at) < CREATE_DEDUPE_TTL_MS) {
    console.log("[create-prenda] duplicate create prevented (in-flight)", { dedupeKey });
    return cached.promise;
  }

  const createPromise = withCreatePrendaLock(async () => {
    const codigoPreview = normalizeValue(payload.codigoPreview || payload.codigo || "");
    const { codigoFinal, codigoChanged } = await resolveAvailableCodigo(sheets, payload);
    if (codigoChanged) {
      console.log("[create-prenda] preview code reused", { codigoPreview, codigoFinal });
    }
    const ordenFinal = await getNextOrden(sheets);
    const descripcion = await buildPrendaDescripcion(sheets, { ...payload, codigo: codigoFinal });
    const precioNormalizado = normalizePricingNumber(payload.precio);
    const costoNormalizado = normalizePricingNumber(payload.costo);
    const precioFinal = precioNormalizado === null ? "" : precioNormalizado;
    const costoFinal = costoNormalizado === null ? "" : costoNormalizado;
    const { utilidad, margen } = calcularUtilidadYMargenDesdeBaseVenta(precioNormalizado ?? 0, costoNormalizado ?? 0);
    const row = [
      ordenFinal, codigoFinal, descripcion, String(payload.tipo || "").trim(), String(payload.color || "").trim(), String(payload.talla || "").trim(), String(payload.proveedor || "").trim(), String(payload.tn || "N/A").trim(), String(payload.status || "No definido").trim(), String(payload.disponibilidad || "No definido").trim(), asNumber(payload.existencia, 0), String(payload.fecha || "").trim(), String(precioFinal), String(costoFinal), String(margen), String(utilidad), String(payload.inventorySource || "manual").trim(), String(payload.lastInventorySyncAt ?? "").trim()
    ];
    await sheets.spreadsheets.values.append({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A:R`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { majorDimension: "ROWS", values: [row] } });
    const result = {
      ok: true,
      codigo: codigoFinal,
      orden: ordenFinal,
      codigoFinal,
      ordenFinal,
      codigoChangedFromPreview: codigoChanged || (codigoPreview && codigoPreview !== codigoFinal),
      columns: ADMIN_COLUMNS
    };
    recentCreateCache.set(dedupeKey, { at: Date.now(), result });
    invalidateGenerateCodeCache();
    return result;
  });

  recentCreateCache.set(dedupeKey, { at: Date.now(), promise: createPromise });
  try {
    return await createPromise;
  } finally {
    const entry = recentCreateCache.get(dedupeKey);
    if (entry?.promise) {
      recentCreateCache.delete(dedupeKey);
    }
    cleanupRecentCreateCache();
  }
}

export async function generarCodigoPrenda(payload = {}) {
  const proveedor = normalizeValue(payload.proveedor);
  const tipo = normalizeValue(payload.tipo);
  const color = normalizeValue(payload.color);
  const talla = normalizeValue(payload.talla);
  const codigoBaseInput = normalizeCodeBase(payload.codigoBase || "");
  const suffix = `/${color}-${talla}`;

  if (!color || !talla) throw new Error("Color y talla son obligatorios.");

  if (codigoBaseInput) {
    return {
      codigoBase: codigoBaseInput,
      codigo: `${codigoBaseInput}${suffix}`,
      usingExistingBase: true
    };
  }

  if (!proveedor || !tipo) {
    throw new Error("Proveedor y tipo son obligatorios para generar código.");
  }

  const sheets = createSheetsClient({ readOnly: true });
  const baseCodigos = await getPrendaCodesForGenerate(sheets);
  const prefix = `HA${proveedor}${tipo}`;
  const { maxConsecutivo, nextConsecutive } = extractNextConsecutiveForPrefix(prefix, baseCodigos);
  const consecutivoStr = String(nextConsecutive).padStart(3, "0");
  const codigoBase = `${prefix}${consecutivoStr}`;

  return {
    codigoBase,
    codigo: `${codigoBase}${suffix}`,
    usingExistingBase: false,
    maxConsecutivo
  };
}

export async function deletePrenda(payload = {}) {
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const sheets = createSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: `${TARGET_SHEET}!A2:R` });
  const rows = response?.data?.values || [];
  const rowIndex = rows.findIndex((row) => String(row?.[CODE_COLUMN_INDEX] || "").trim() === codigo);
  if (rowIndex === -1) return { status: 404, body: { ok: false, message: "Código no encontrado." } };
  const targetRowNumber = rowIndex + 2;
  await deleteSheetRow(sheets, TARGET_SHEET, targetRowNumber);
  invalidateGenerateCodeCache();
  return { ok: true, codigo, deleted: true };
}

export async function archivePrenda(payload = {}) {
  const codigo = String(payload.codigo || "").trim();
  if (!codigo) throw new Error("El campo 'codigo' es obligatorio.");
  const sheets = createSheetsClient();
  const sheetNames = await getSpreadsheetSheetNames(sheets);
  if (!sheetNames.includes(TARGET_SHEET)) throw new Error("No existe la hoja prendas_admin_activas");
  if (!sheetNames.includes(ARCHIVE_SHEET)) throw new Error("No existe la hoja prendas_admin_archivo");

  const activeData = await readSheetRows(sheets, TARGET_SHEET);
  const archiveHeaders = await getSheetHeaders(sheets, ARCHIVE_SHEET);
  if (!activeData.headers.includes(CODE_HEADER)) throw new Error('La hoja activa no contiene la columna "Código".');
  if (!archiveHeaders.includes(CODE_HEADER)) throw new Error('La hoja de archivo no contiene la columna "Código".');

  const rowEncontrada = activeData.rows.find((row) => String(row?.sourceRowObject?.[CODE_HEADER] || "").trim() === codigo);
  if (!rowEncontrada) return { status: 404, body: { ok: false, message: "Código no encontrado en activas." } };

  const extraValues = {};
  if (archiveHeaders.includes(ARCHIVED_AT_HEADER)) extraValues[ARCHIVED_AT_HEADER] = new Date().toISOString();
  const rowValuesArchivo = buildRowByTargetHeaders(rowEncontrada.sourceRowObject, archiveHeaders, extraValues);
  await appendSheetRow(sheets, ARCHIVE_SHEET, rowValuesArchivo);
  await deleteSheetRow(sheets, TARGET_SHEET, rowEncontrada.rowNumber);
  invalidateGenerateCodeCache();
  return { ok: true, codigo, archived: true };
}
