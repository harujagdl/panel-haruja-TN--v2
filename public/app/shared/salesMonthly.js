import {
  collection,
  getDocs,
  limit,
  query,
  where
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const MONTH_ALIASES = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
  jan: 1, january: 1,
  february: 2,
  march: 3,
  apr: 4, april: 4,
  june: 6,
  july: 7,
  aug: 8, august: 8,
  september: 9,
  october: 10,
  november: 11,
  dec: 12, december: 12
};

const STATUS_CANCELLED = new Set([
  "cancelada", "cancelado", "cancelled", "canceled", "anulada", "anulado", "void"
]);

export const toYearNumber = (value, fallback = new Date().getFullYear()) => {
  const out = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(out) ? out : fallback;
};

export const toMonthNumber = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (MONTH_ALIASES[raw]) return MONTH_ALIASES[raw];
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  return fallback;
};

export const toAmountNumber = (value, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value ?? "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=.*\.)/g, "")
    .replace(",", ".");
  const out = Number.parseFloat(cleaned);
  return Number.isFinite(out) ? out : fallback;
};

const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

const fromDateLike = (value) => {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isCancelled = (row = {}) => {
  const status = String(row.status || row.estado || row.order_status || "").trim().toLowerCase();
  if (STATUS_CANCELLED.has(status)) return true;
  return Boolean(row.cancelled || row.isCancelled || row.anulada);
};

const resolveYearMonth = (row = {}, fallbackYear) => {
  const explicitYear = toYearNumber(row.year ?? row.anio ?? row.año, NaN);
  const explicitMonth = toMonthNumber(row.month ?? row.mes, null);
  if (Number.isFinite(explicitYear) && explicitMonth) {
    return { year: explicitYear, month: explicitMonth };
  }

  const monthKeyValue = String(row.month_key || row.monthKey || "").trim();
  if (/^\d{4}-\d{2}$/.test(monthKeyValue)) {
    const [yearRaw, monthRaw] = monthKeyValue.split("-");
    return { year: toYearNumber(yearRaw, fallbackYear), month: toMonthNumber(monthRaw, null) };
  }

  const date = fromDateLike(row.created_at || row.createdAt || row.fecha || row.date || row.paid_at || row.paidAt);
  if (date) return { year: date.getFullYear(), month: date.getMonth() + 1 };

  return { year: fallbackYear, month: explicitMonth || null };
};

export const emptyMonths = (year = new Date().getFullYear()) => {
  const out = {};
  for (let m = 1; m <= 12; m += 1) out[monthKey(year, m)] = 0;
  return out;
};

async function readVentasCollection(db, collectionName, year) {
  const out = [];
  const ref = collection(db, collectionName);
  const byYear = query(ref, where("year", "==", year), limit(3000));
  const [yearSnap, fullSnap] = await Promise.all([
    getDocs(byYear).catch(() => null),
    getDocs(ref).catch(() => null)
  ]);

  const picked = yearSnap && !yearSnap.empty ? yearSnap : fullSnap;
  if (!picked) return out;

  picked.forEach((docSnap) => out.push({ id: docSnap.id, ...(docSnap.data() || {}) }));
  return out;
}

const monthToken = (month) => String(Math.max(1, Math.min(12, Number(month) || 1))).padStart(2, "0");

async function readVentasResumenMonth(year, month) {
  try {
    const response = await fetch(`/api/core?action=ventas-resumen&month=${year}-${monthToken(month)}`);
    const payload = await response.json();
    if (!response.ok || !payload?.ok) return null;
    return toAmountNumber(payload?.data?.total_mes, null);
  } catch (_error) {
    return null;
  }
}

export async function getMonthlySalesMap(db, year, { startMonth = 1, endMonth = 12 } = {}) {
  const normalizedYear = toYearNumber(year);
  const start = Math.max(1, Math.min(12, toMonthNumber(startMonth, 1) || 1));
  const end = Math.max(start, Math.min(12, toMonthNumber(endMonth, 12) || 12));

  const monthlyTotals = emptyMonths(normalizedYear);

  const monthNumbers = [];
  for (let month = start; month <= end; month += 1) monthNumbers.push(month);

  const apiTotals = await Promise.all(monthNumbers.map((month) => readVentasResumenMonth(normalizedYear, month)));
  let hasApiData = false;
  monthNumbers.forEach((month, index) => {
    const total = apiTotals[index];
    if (!Number.isFinite(total)) return;
    hasApiData = true;
    monthlyTotals[monthKey(normalizedYear, month)] = total;
  });

  if (hasApiData) return monthlyTotals;

  const ventasRows = [
    ...(await readVentasCollection(db, "ventas", normalizedYear)),
    ...(await readVentasCollection(db, "ventas_tn", normalizedYear))
  ];

  for (const row of ventasRows) {
    if (isCancelled(row)) continue;
    const { year: rowYear, month } = resolveYearMonth(row, normalizedYear);
    if (rowYear !== normalizedYear || !month || month < start || month > end) continue;

    const key = monthKey(rowYear, month);
    const total = toAmountNumber(row.total ?? row.amount ?? row.monto ?? row.total_mes ?? row.totalMes, 0);
    monthlyTotals[key] = toAmountNumber(monthlyTotals[key], 0) + total;
  }

  return monthlyTotals;
}

export async function getMonthlySalesTotals(db, { year } = {}) {
  return { monthlyTotals: await getMonthlySalesMap(db, year) };
}

export async function getMonthlySalesTotal(db, year, month01) {
  const month = toMonthNumber(month01, 1) || 1;
  const monthlyTotals = await getMonthlySalesMap(db, year, { startMonth: month, endMonth: month });
  return Number(monthlyTotals[monthKey(toYearNumber(year), month)] || 0);
}
