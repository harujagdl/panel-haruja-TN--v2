const MEXICO_TZ = 'America/Mexico_City';

const PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: MEXICO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDateInput(input) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  const raw = String(input || '').trim();
  if (!raw) return null;

  const plainDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plainDate) {
    const year = Number(plainDate[1]);
    const month = Number(plainDate[2]);
    const day = Number(plainDate[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { plainDate: true, year, month, day };
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function getMexicoDateParts(input) {
  const parsed = parseDateInput(input);
  if (!parsed) return null;

  if (parsed.plainDate) {
    return {
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
    };
  }

  const parts = PARTS_FORMATTER.formatToParts(parsed);
  const year = Number(parts.find((part) => part.type === 'year')?.value || 0);
  const month = Number(parts.find((part) => part.type === 'month')?.value || 0);
  const day = Number(parts.find((part) => part.type === 'day')?.value || 0);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return { year, month, day };
}

export function getMexicoDateKey(input) {
  const parts = getMexicoDateParts(input);
  if (!parts) return '';
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function getMexicoMonthKey(input) {
  const parts = getMexicoDateParts(input);
  if (!parts) return '';
  return `${parts.year}-${pad2(parts.month)}`;
}

export function getCurrentMexicoMonthKey() {
  return getMexicoMonthKey(new Date());
}

export const HARUJA_OPERATIVE_TIME_ZONE = MEXICO_TZ;
