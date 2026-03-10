const normalizeValue = (value) => String(value ?? "").trim().toUpperCase();

export const normalizeCodeBase = (code) => {
  const raw = normalizeValue(code);
  if (!raw) return "";
  return raw.split("/")[0].trim();
};

export const extractNextConsecutiveForPrefix = (prefix, baseCodigos) => {
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
  return {
    codigosCoincidentes,
    maxConsecutivo,
    nextConsecutive: maxConsecutivo + 1
  };
};

export const generateHarujaCode = ({ proveedor, tipo, color, talla, baseCodigos, codigoBase = null }) => {
  const proveedorCode = normalizeValue(proveedor);
  const tipoCode = normalizeValue(tipo);
  const colorCode = normalizeValue(color);
  const tallaCode = normalizeValue(talla);
  const suffix = `/${colorCode}-${tallaCode}`;

  const normalizedCodigoBase = normalizeCodeBase(codigoBase);
  if (normalizedCodigoBase) {
    const codigoFinal = `${normalizedCodigoBase}${suffix}`;
    return {
      codigo: codigoFinal,
      codigoBase: normalizedCodigoBase,
      prefix: `${proveedorCode}${tipoCode}`,
      codigosCoincidentes: [],
      maxConsecutivo: null
    };
  }

  if (!proveedorCode || !tipoCode || !colorCode || !tallaCode) {
    throw new Error("Proveedor, tipo, color y talla son obligatorios para generar código HARUJA.");
  }

  const prefix = `HA${proveedorCode}${tipoCode}`;
  const { codigosCoincidentes, maxConsecutivo, nextConsecutive } = extractNextConsecutiveForPrefix(prefix, baseCodigos);
  const consecutivoStr = String(nextConsecutive).padStart(3, "0");
  const codigoBaseFinal = `${prefix}${consecutivoStr}`;

  return {
    codigo: `${codigoBaseFinal}${suffix}`,
    codigoBase: codigoBaseFinal,
    prefix,
    codigosCoincidentes,
    maxConsecutivo
  };
};
