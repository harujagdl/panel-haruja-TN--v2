import { google } from 'googleapis';
import { getGoogleServiceAccountCredentials } from '../google/service-account.js';

export const CATALOGO_IA_SPREADSHEET_ID = '16pqujWAAsrlmivy2YzsMizQOjms8MuqDWJVNUGESNv0';
export const BASE_PANEL_SPREADSHEET_ID = '1sGWRwLiyZD4gznruHvhgZ92KLZcaEjWww3zvypn7iA0';

export const TIENDANUBE_CSV_COLUMNS = [
  'Identificador de URL', 'Nombre', 'Categorías', 'Nombre de propiedad 1', 'Valor de propiedad 1',
  'Nombre de propiedad 2', 'Valor de propiedad 2', 'Nombre de propiedad 3', 'Valor de propiedad 3', 'Precio',
  'Precio promocional', 'Stock', 'SKU', 'Código de barras', 'Mostrar en tienda', 'Envío sin cargo', 'Descripción',
  'Tags', 'Título para SEO', 'Descripción para SEO', 'Marca', 'Producto Físico', 'Costo'
];

export const CATALOGO_IA_INTERNAL_COLUMNS = [
  'ID interno', 'SKU base', 'Foto principal URL', 'Foto principal ID', 'Estado', 'Estado IA', 'Estado CSV', 'Fuente',
  'Fecha creación', 'Última edición', 'Creado por', 'Editado por', 'Notas internas', 'Ruta local fotos',
  'Nombre ZIP sugerido', 'Archivado'
];

export const CATALOGO_IA_COLUMNS = [...CATALOGO_IA_INTERNAL_COLUMNS, ...TIENDANUBE_CSV_COLUMNS];

const CATALOGO_SHEETS = ['CatalogoIA', 'CatalogoIA_Fotos', 'CatalogoIA_Log', 'Config'];
const LOG_COLUMNS = ['Fecha', 'Acción', 'ID interno', 'Usuario', 'Data'];
const FOTO_COLUMNS = ['Fecha', 'ID ficha', 'SKU', 'File ID', 'URL foto', 'Nombre archivo', 'Tipo foto', 'Principal', 'Usuario'];
const CATALOGO_IA_EXT_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};
const DEFAULT_CATALOGO_IA_ROW = {
  'ID interno': '',
  'SKU base': '',
  'Foto principal URL': '',
  'Foto principal ID': '',
  'Estado': 'Pendiente imagen',
  'Estado IA': 'Sin generar',
  'Estado CSV': 'No listo',
  'Fuente': 'Base Panel Haruja TN v2',
  'Fecha creación': '',
  'Última edición': '',
  'Creado por': '',
  'Editado por': '',
  'Notas internas': '',
  'Ruta local fotos': '',
  'Nombre ZIP sugerido': '',
  'Archivado': 'NO',
  'Identificador de URL': '',
  'Nombre': '',
  'Categorías': '',
  'Nombre de propiedad 1': 'Talla',
  'Valor de propiedad 1': '',
  'Nombre de propiedad 2': 'Color',
  'Valor de propiedad 2': '',
  'Nombre de propiedad 3': '',
  'Valor de propiedad 3': '',
  'Precio': '',
  'Precio promocional': '',
  'Stock': '',
  'SKU': '',
  'Código de barras': '',
  'Mostrar en tienda': 'SÍ',
  'Envío sin cargo': 'NO',
  'Descripción': '',
  'Tags': '',
  'Título para SEO': '',
  'Descripción para SEO': '',
  'Marca': 'HarujaGdl',
  'Producto Físico': 'SÍ',
  'Costo': ''
};

const BASE_ALIASES = {
  sku: ['SKU', 'Código', 'Codigo', 'Código Haruja', 'codigo'],
  descripcion: ['Descripción', 'Descripcion', 'Nombre', 'Producto'],
  categoria: ['Categoría', 'Categoria', 'Tipo', 'Tipo de producto'],
  color: ['Color'],
  talla: ['Talla'],
  precio: ['Precio', 'P.Venta', 'Precio venta', 'Precio con IVA', 'precioConIva'],
  costo: ['Costo'],
  stock: ['Stock', 'Existencia', 'Existencias', 'Inventario'],
  disponibilidad: ['Disponibilidad'],
  status: ['Status', 'Estado'],
  fechaAlta: ['Fecha', 'Fecha de alta'],
  foto: ['Foto', 'Imagen', 'Foto URL']
};

const normalize = (value) => String(value ?? '').trim();
const normalizeLower = (value) => normalize(value).toLowerCase();
const nowIso = () => new Date().toISOString();

const createSheetsClient = (readOnly = false) => {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: [
      readOnly ? 'https://www.googleapis.com/auth/spreadsheets.readonly' : 'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
  return google.sheets({ version: 'v4', auth });
};


const columnToLetter = (index) => {
  let n = Number(index) + 1;
  let result = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    result = String.fromCharCode(65 + r) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
};

const slugify = (value = '') => normalize(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ñ/gi, 'n')
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

async function getSheetMap(sheets, spreadsheetId) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const map = new Map();
  (metadata?.data?.sheets || []).forEach((sheet = {}) => {
    const title = normalize(sheet?.properties?.title);
    if (!title) return;
    map.set(title, sheet?.properties || {});
  });
  return map;
}

async function ensureHeaders(sheets, spreadsheetId, sheetName, headers) {
  const headerRow = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:ZZ1` });
  const existing = Array.isArray(headerRow?.data?.values?.[0]) ? headerRow.data.values[0].map(normalize) : [];
  const missing = headers.filter((header) => !existing.includes(header));
  if (!existing.length) {
    const end = columnToLetter(headers.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:${end}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
  if (existing.length && missing.length) {
    const startIndex = existing.length;
    const endIndex = startIndex + missing.length - 1;
    const start = columnToLetter(startIndex);
    const end = columnToLetter(endIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!${start}1:${end}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [missing] }
    });
  }
}

const toRowObject = (headers = [], row = []) => headers.reduce((acc, header, index) => {
  acc[header] = row?.[index] ?? '';
  return acc;
}, {});

const toRowValues = (record = {}, headers = []) => headers.map((header) => record?.[header] ?? '');

const getAliasValue = (row, headers = [], aliases = []) => {
  for (const alias of aliases) {
    const index = headers.findIndex((header) => normalizeLower(header) === normalizeLower(alias));
    if (index >= 0) return normalize(row?.[index]);
  }
  return '';
};

const isTruthyYes = (value) => ['si', 'sí', 's', 'yes', 'y', 'true', '1'].includes(normalizeLower(value));

const shouldShowCost = (context = {}) => Boolean(context?.isAdmin);

export async function ensureCatalogoIASheets() {
  const sheets = createSheetsClient(false);
  const map = await getSheetMap(sheets, CATALOGO_IA_SPREADSHEET_ID);
  const requests = [];
  CATALOGO_SHEETS.forEach((name) => {
    if (!map.has(name)) requests.push({ addSheet: { properties: { title: name } } });
  });
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
      requestBody: { requests }
    });
  }
  await ensureHeaders(sheets, CATALOGO_IA_SPREADSHEET_ID, 'CatalogoIA', CATALOGO_IA_COLUMNS);
  await ensureHeaders(sheets, CATALOGO_IA_SPREADSHEET_ID, 'CatalogoIA_Fotos', FOTO_COLUMNS);
  await ensureHeaders(sheets, CATALOGO_IA_SPREADSHEET_ID, 'CatalogoIA_Log', LOG_COLUMNS);
  return { ok: true };
}

async function getCatalogoRows() {
  const sheets = createSheetsClient(false);
  await ensureCatalogoIASheets();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
    range: 'CatalogoIA!A1:ZZ'
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  const headers = (values[0] || CATALOGO_IA_COLUMNS).map(normalize);
  const rows = values.slice(1).map((row) => toRowObject(headers, row));
  return { sheets, headers, rows };
}

export async function logCatalogoIA(action, data = {}, context = {}) {
  const sheets = createSheetsClient(false);
  await ensureCatalogoIASheets();
  const payload = [nowIso(), normalize(action), normalize(data?.id || data?.['ID interno']), normalize(context?.email || ''), JSON.stringify(data || {})];
  await sheets.spreadsheets.values.append({
    spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
    range: 'CatalogoIA_Log!A:E',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [payload] }
  });
}

export async function getCatalogoIABaseProducts(params = {}, context = {}) {
  const sheets = createSheetsClient(true);
  const query = normalizeLower(params?.q || params?.search || '');
  const categoryFilter = normalizeLower(params?.categoria || '');
  const statusFilter = normalizeLower(params?.status || '');
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: BASE_PANEL_SPREADSHEET_ID, includeGridData: false });
  const titles = (metadata?.data?.sheets || []).map((sheet) => normalize(sheet?.properties?.title)).filter(Boolean);

  for (const sheetName of titles) {
    const rowsResp = await sheets.spreadsheets.values.get({ spreadsheetId: BASE_PANEL_SPREADSHEET_ID, range: `${sheetName}!A1:ZZ` });
    const values = Array.isArray(rowsResp?.data?.values) ? rowsResp.data.values : [];
    if (values.length < 2) continue;
    const headers = (values[0] || []).map(normalize);
    const hasSkuOrDesc = getAliasValue([], headers, BASE_ALIASES.sku) || getAliasValue([], headers, BASE_ALIASES.descripcion);
    if (!hasSkuOrDesc && headers.length) {
      const aliasHeaders = Object.values(BASE_ALIASES).flat().map(normalizeLower);
      const matching = headers.filter((h) => aliasHeaders.includes(normalizeLower(h))).length;
      if (matching < 3) continue;
    }

    const items = [];
    for (const row of values.slice(1)) {
      const sku = getAliasValue(row, headers, BASE_ALIASES.sku);
      const descripcion = getAliasValue(row, headers, BASE_ALIASES.descripcion);
      const categoria = getAliasValue(row, headers, BASE_ALIASES.categoria);
      const color = getAliasValue(row, headers, BASE_ALIASES.color);
      const talla = getAliasValue(row, headers, BASE_ALIASES.talla);
      const precio = getAliasValue(row, headers, BASE_ALIASES.precio);
      const costo = shouldShowCost(context) ? getAliasValue(row, headers, BASE_ALIASES.costo) : '';
      const stock = getAliasValue(row, headers, BASE_ALIASES.stock);
      const disponibilidad = getAliasValue(row, headers, BASE_ALIASES.disponibilidad);
      const status = getAliasValue(row, headers, BASE_ALIASES.status);
      const fechaAlta = getAliasValue(row, headers, BASE_ALIASES.fechaAlta);
      const foto = getAliasValue(row, headers, BASE_ALIASES.foto);

      const searchable = normalizeLower([sku, descripcion, categoria, color, talla].join(' '));
      if (query && !searchable.includes(query)) continue;
      if (categoryFilter && normalizeLower(categoria) !== categoryFilter) continue;
      if (statusFilter && normalizeLower(status) !== statusFilter) continue;

      items.push({
        sku,
        descripcion,
        categoria,
        color,
        talla,
        precio,
        costo,
        stock,
        disponibilidad,
        status,
        fechaAlta,
        foto,
        sheetName
      });
      if (items.length >= 25) break;
    }

    return { items, sourceSheet: sheetName };
  }

  return { items: [], sourceSheet: '' };
}

export async function listCatalogoIADrafts(params = {}, context = {}) {
  const { rows } = await getCatalogoRows();
  const q = normalizeLower(params?.q || '');
  const sku = normalizeLower(params?.sku || '');
  const estado = normalizeLower(params?.estado || '');

  let items = rows.filter((row) => normalizeLower(row?.Archivado) !== 'sí');
  if (estado) items = items.filter((row) => normalizeLower(row?.Estado) === estado);
  if (sku) items = items.filter((row) => normalizeLower(row?.SKU).includes(sku) || normalizeLower(row?.['SKU base']).includes(sku));
  if (q) {
    items = items.filter((row) => normalizeLower([
      row?.SKU,
      row?.Nombre,
      row?.Categorías,
      row?.Descripción,
      row?.['Notas internas']
    ].join(' ')).includes(q));
  }

  items.sort((a, b) => normalize(b?.['Última edición']).localeCompare(normalize(a?.['Última edición'])));
  const safeItems = items.slice(0, 200).map((item) => ({ ...item, ...(shouldShowCost(context) ? {} : { Costo: "" }) }));
  return { items: safeItems };
}

export async function getCatalogoIADraft(id = '', context = {}) {
  const target = normalize(id);
  if (!target) throw new Error('id es obligatorio.');
  const { rows } = await getCatalogoRows();
  const found = rows.find((row) => normalize(row?.['ID interno']) === target);
  if (!found) throw new Error('No se encontró el borrador.');
  return shouldShowCost(context) ? found : { ...found, Costo: "" };
}

const generateInternalId = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CIA-${stamp}-${random}`;
};

const normalizeCatalogPayload = (payload = {}, context = {}) => {
  const now = nowIso();
  const base = { ...DEFAULT_CATALOGO_IA_ROW };
  CATALOGO_IA_COLUMNS.forEach((column) => {
    if (Object.prototype.hasOwnProperty.call(payload, column)) base[column] = normalize(payload[column]);
  });
  if (!shouldShowCost(context)) base.Costo = '';
  base['Última edición'] = now;
  if (!base['Fecha creación']) base['Fecha creación'] = now;
  if (!base['Nombre de propiedad 1']) base['Nombre de propiedad 1'] = 'Talla';
  if (!base['Nombre de propiedad 2']) base['Nombre de propiedad 2'] = 'Color';
  if (!base.Marca) base.Marca = 'HarujaGdl';
  if (!base['Mostrar en tienda']) base['Mostrar en tienda'] = 'SÍ';
  if (!base['Envío sin cargo']) base['Envío sin cargo'] = 'NO';
  if (!base['Producto Físico']) base['Producto Físico'] = 'SÍ';
  if (!base.Fuente) base.Fuente = 'Base Panel Haruja TN v2';
  if (!base['Identificador de URL']) base['Identificador de URL'] = slugify(base.Nombre || base.SKU || base['SKU base']);
  return base;
};

export async function createCatalogoIADraft(payload = {}, context = {}) {
  await ensureCatalogoIASheets();
  const sheets = createSheetsClient(false);
  const row = normalizeCatalogPayload(payload, context);
  row['ID interno'] = generateInternalId();
  row['Creado por'] = normalize(context?.email || payload?.['Creado por']);
  const values = toRowValues(row, CATALOGO_IA_COLUMNS);
  await sheets.spreadsheets.values.append({
    spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
    range: 'CatalogoIA!A:ZZ',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
  await logCatalogoIA('create', { id: row['ID interno'], sku: row.SKU }, context);
  return row;
}

export async function updateCatalogoIADraft(id = '', payload = {}, context = {}) {
  const target = normalize(id);
  if (!target) throw new Error('id es obligatorio.');
  const { sheets, headers, rows } = await getCatalogoRows();
  const index = rows.findIndex((row) => normalize(row?.['ID interno']) === target);
  if (index < 0) throw new Error('No se encontró el borrador.');

  const current = rows[index];
  const merged = normalizeCatalogPayload({ ...current, ...payload, 'ID interno': target, 'Fecha creación': current['Fecha creación'] }, context);
  merged['Editado por'] = normalize(context?.email || payload?.['Editado por']);

  const rowNumber = index + 2;
  const end = columnToLetter(headers.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
    range: `CatalogoIA!A${rowNumber}:${end}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [toRowValues(merged, headers)] }
  });
  await logCatalogoIA('update', { id: target, fields: Object.keys(payload || {}) }, context);
  return merged;
}

export async function archiveCatalogoIADraft(id = '', context = {}) {
  const updated = await updateCatalogoIADraft(id, { Archivado: 'SÍ', Estado: 'Archivado' }, context);
  await logCatalogoIA('archive', { id }, context);
  return updated;
}

export function sanitizeCatalogoIAFileNameFromSku(sku = '', mimeType = '') {
  const cleanSku = normalize(sku).replace(/[^a-z0-9]/gi, '');
  if (!cleanSku) throw new Error('Primero captura o selecciona un SKU para nombrar la foto.');
  const extension = CATALOGO_IA_EXT_BY_MIME_TYPE[normalizeLower(mimeType)];
  if (!extension) throw new Error('Formato no compatible. Usa JPG, JPEG, PNG o WEBP.');
  return `${cleanSku}${extension}`;
}

export async function appendCatalogoIAFoto(payload = {}, context = {}) {
  await ensureCatalogoIASheets();
  const sheets = createSheetsClient(false);
  const row = {
    'Fecha': nowIso(),
    'ID ficha': normalize(payload?.draftId || ''),
    'SKU': normalize(payload?.sku || ''),
    'File ID': normalize(payload?.fileId || ''),
    'URL foto': normalize(payload?.webViewLink || ''),
    'Nombre archivo': normalize(payload?.name || ''),
    'Tipo foto': normalize(payload?.tipoFoto || 'principal'),
    'Principal': normalize(payload?.principal || 'SÍ'),
    'Usuario': normalize(context?.email || payload?.usuario || '')
  };
  await sheets.spreadsheets.values.append({
    spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
    range: 'CatalogoIA_Fotos!A:I',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [toRowValues(row, FOTO_COLUMNS)] }
  });
  return row;
}

const SIZE_VALUE_RE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|ch|g|xg|u|m-l|s-m|l-xl|\d{1,2})$/i;
const SKU_LIKE_RE = /[a-z]{2,}[-_ ]?\d{2,}/i;
const CATEGORY_HINTS = ['conjuntos', 'blusas', 'vestidos', 'faldas', 'pantalones', 'playeras', 'blazer', 'sudaderas', 'shorts'];

const isYesNoValue = (value = '') => ['si', 'sí', 'no', 's', 'n'].includes(normalizeLower(value));
const isLikelySizeValue = (value = '') => SIZE_VALUE_RE.test(normalize(value));
const isLikelySku = (value = '') => SKU_LIKE_RE.test(normalize(value));
const isLikelyNumeric = (value = '') => /^-?\d+(?:[.,]\d+)?$/.test(normalize(value));

const inferCategoryFromText = (value = '') => {
  const lower = normalizeLower(value);
  return CATEGORY_HINTS.find((hint) => lower.includes(hint)) || '';
};

const detectShiftedCatalogoIARow = (row = {}) => {
  const prop1Name = normalize(row?.['Nombre de propiedad 1']);
  const nombre = normalize(row?.Nombre);
  const urlHandle = normalize(row?.['Identificador de URL']);
  return isLikelySizeValue(prop1Name) || /talla/i.test(nombre) || Boolean(inferCategoryFromText(urlHandle));
};

const repairShiftedCatalogoIARow = (row = {}) => {
  const repaired = { ...row };
  const source = { ...row };

  repaired.Nombre = normalize(source?.['Identificador de URL']);
  repaired['Nombre de propiedad 1'] = normalize(source?.Nombre);
  repaired['Valor de propiedad 1'] = normalize(source?.Categorías);
  repaired['Nombre de propiedad 2'] = normalize(source?.['Nombre de propiedad 1']);
  repaired['Valor de propiedad 2'] = normalize(source?.['Valor de propiedad 1']);
  repaired.Precio = normalize(source?.['Nombre de propiedad 3']);
  repaired.Stock = normalize(source?.Precio);

  const inferredCategory = inferCategoryFromText(source?.['Identificador de URL']);
  if (inferredCategory && (isLikelySizeValue(source?.Categorías) || !normalize(source?.Categorías))) {
    repaired.Categorías = inferredCategory;
  }

  if (!normalize(repaired.SKU)) {
    const skuCandidate = [source?.Stock, source?.['Precio promocional'], source?.['Valor de propiedad 3'], source?.['Código de barras']]
      .map((value) => normalize(value))
      .find((value) => isLikelySku(value));
    if (skuCandidate) repaired.SKU = skuCandidate;
  }

  if (isYesNoValue(source?.['Código de barras'])) {
    if (!normalize(source?.['Mostrar en tienda']) || !isYesNoValue(source?.['Mostrar en tienda'])) {
      repaired['Mostrar en tienda'] = normalize(source?.['Código de barras']);
    } else {
      repaired['Envío sin cargo'] = normalize(source?.['Código de barras']);
    }
    repaired['Código de barras'] = '';
  }

  if (!isLikelyNumeric(repaired.Precio) && isLikelyNumeric(source?.Precio)) repaired.Precio = normalize(source?.Precio);
  if (!isLikelyNumeric(repaired.Stock) && isLikelyNumeric(source?.Stock)) repaired.Stock = normalize(source?.Stock);

  repaired['Última edición'] = nowIso();
  return repaired;
};

export async function repairCatalogoIARowsAlignment({ dryRun = true } = {}, context = {}) {
  const runDry = String(dryRun).toLowerCase() !== 'false';
  const { sheets, headers, rows } = await getCatalogoRows();
  const detected = [];

  rows.forEach((row, index) => {
    if (!detectShiftedCatalogoIARow(row)) return;
    const repaired = repairShiftedCatalogoIARow(row);
    detected.push({
      rowNumber: index + 2,
      id: normalize(row?.['ID interno']),
      before: row,
      after: repaired
    });
  });

  if (runDry || !detected.length) {
    return { dryRun: runDry, updated: 0, detectedCount: detected.length, detected };
  }

  for (const item of detected) {
    const end = columnToLetter(headers.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: CATALOGO_IA_SPREADSHEET_ID,
      range: `CatalogoIA!A${item.rowNumber}:${end}${item.rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [toRowValues(item.after, headers)] }
    });
    await logCatalogoIA('repair-alignment', { id: item.id, rowNumber: item.rowNumber }, context);
  }

  return { dryRun: false, updated: detected.length, detectedCount: detected.length, detected };
}
