export const IVA_RATE = 0.16;

export function normalizeNumber(value, { integer = false, fallback = null } = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    return integer ? Math.trunc(value) : value;
  }
  const cleaned = String(value)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!cleaned) return fallback;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return fallback;
  return integer ? Math.trunc(parsed) : parsed;
}

export const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));
export const roundMargin = (value) => Number((Number(value) || 0).toFixed(1));

// Regla oficial de negocio:
// La base de venta para utilidad/margen es el campo Precio (columna "Precio" en Sheets).
// pVenta / precioConIva se tratan como alias de compatibilidad cuando Precio no esté presente.
export function calcularUtilidadYMargenDesdeBaseVenta(baseVenta, costo) {
  const p = normalizeNumber(baseVenta, { fallback: 0 }) || 0;
  const c = normalizeNumber(costo, { fallback: 0 }) || 0;
  const utilidad = Math.max(0, p - c);
  const margen = p > 0 ? (utilidad / p) * 100 : 0;
  return {
    utilidad: roundMoney(utilidad),
    margen: roundMargin(margen),
  };
}

export function calcularUtilidadYMargen(precio, costo) {
  return calcularUtilidadYMargenDesdeBaseVenta(precio, costo);
}

export function calcularPrecioConIVA(precioSinIVA) {
  const base = normalizeNumber(precioSinIVA, { fallback: null });
  if (!Number.isFinite(base) || base <= 0) return null;

  const iva = roundMoney(base * IVA_RATE);
  const total = base + iva;
  const precioConIVA = Math.ceil(total / 10) * 10 - 1;

  return {
    precioSinIVA: base,
    iva,
    precioConIVA,
  };
}

export function ajustarDesdePrecioConIVA(precioConIVAIngresado) {
  const precioIngresado = normalizeNumber(precioConIVAIngresado, { fallback: null });
  if (!Number.isFinite(precioIngresado) || precioIngresado <= 0) return null;

  const totalObjetivo = Math.ceil(precioIngresado / 10) * 10 - 1;
  const totalMin = totalObjetivo - 10;
  const pMin = totalMin / (1 + IVA_RATE);
  const pMax = totalObjetivo / (1 + IVA_RATE);

  for (let p = Math.floor(pMin); p <= Math.ceil(pMax); p += 1) {
    if (p % 10 !== 9) continue;
    const calculado = calcularPrecioConIVA(p);
    if (calculado && calculado.precioConIVA === totalObjetivo) {
      return calculado;
    }
  }

  const mejorBase = Math.floor(pMax / 10) * 10 + 9;
  return calcularPrecioConIVA(mejorBase);
}
