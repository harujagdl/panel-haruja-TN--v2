const safeText = (value) => String(value ?? "").trim();

export const normalizeDictionaryValue = (value) => safeText(value);

const stripLeadingZeros = (value) => {
  if (!/^\d+$/.test(value)) return value;
  const stripped = value.replace(/^0+/, "");
  return stripped || "0";
};

export const normalizeKeyLoose = (value) => {
  const normalized = safeText(value).toLowerCase();
  if (!normalized) return "";
  return stripLeadingZeros(normalized);
};

const toEntries = (dictionaryByType, tipo) => {
  if (!dictionaryByType) return [];
  if (Array.isArray(dictionaryByType)) return dictionaryByType;
  const tipoKey = safeText(tipo).toLowerCase();
  if (!tipoKey) return [];
  return Array.isArray(dictionaryByType[tipoKey]) ? dictionaryByType[tipoKey] : [];
};

const getEntryParts = (entry) => {
  const rawClave = normalizeDictionaryValue(entry?.clave ?? entry?.codigo ?? "");
  const rawValor = normalizeDictionaryValue(entry?.valor ?? entry?.nombre ?? "");
  return {
    clave: rawClave,
    valor: rawValor,
    keyLoose: normalizeKeyLoose(rawClave),
    valueLoose: normalizeKeyLoose(rawValor)
  };
};

export const buscarDiccionarioFlexible = (diccionario, tipo, clave, devolverClave = false) => {
  const rawClave = normalizeDictionaryValue(clave);
  if (!rawClave) return devolverClave ? "" : "";

  const searchLoose = normalizeKeyLoose(rawClave);
  const entries = toEntries(diccionario, tipo);
  const found = entries
    .map(getEntryParts)
    .find((entry) => entry.keyLoose === searchLoose || entry.valueLoose === searchLoose);

  if (!found) {
    return devolverClave ? rawClave : rawClave;
  }

  if (devolverClave) {
    return `${found.clave} = ${found.valor}`;
  }

  return found.valor || found.clave || rawClave;
};

export const generarDescripcionSimple = (tipo, color, talla, diccionario) => {
  const producto = buscarDiccionarioFlexible(diccionario, "tipos", tipo) || normalizeDictionaryValue(tipo);
  const colorNom = buscarDiccionarioFlexible(diccionario, "colores", color) || normalizeDictionaryValue(color);
  const tallaNom = buscarDiccionarioFlexible(diccionario, "tallas", talla) || normalizeDictionaryValue(talla);
  return [producto, colorNom, tallaNom].filter(Boolean).join(" ").trim();
};

export const compactContiguousDuplicateFragment = (value) => {
  const normalized = safeText(value).replace(/\s+/g, " ");
  if (!normalized) return "";

  const parts = normalized.split(/\s+-\s+/).map((part) => safeText(part));
  if (parts.length >= 2) {
    const base = parts[0].toLowerCase();
    const detail = parts[1].toLowerCase();
    if (base && detail && (base === detail || detail.startsWith(`${base} `))) {
      return parts[0];
    }
  }

  return normalized;
};
