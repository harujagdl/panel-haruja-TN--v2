export const HARUJA_TIME_ZONE = 'America/Mexico_City';

const DATE_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: HARUJA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parseDateLikeInput(input) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }

  if (typeof input === 'number') {
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(input || '').trim();
  if (!raw) return null;

  const dayOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) {
    const y = Number(dayOnly[1]);
    const m = Number(dayOnly[2]) - 1;
    const d = Number(dayOnly[3]);
    const date = new Date(Date.UTC(y, m, d, 12, 0, 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getMexicoDateParts(input) {
  const parsed = parseDateLikeInput(input);
  if (!parsed) return null;

  const parts = DATE_PARTS_FORMATTER.formatToParts(parsed);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) return null;

  return {
    year,
    month,
    day,
    dateKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
    timeZone: HARUJA_TIME_ZONE,
  };
}

export function getMexicoDateKey(input) {
  return getMexicoDateParts(input)?.dateKey || '';
}

export function getMexicoMonthKey(input) {
  return getMexicoDateParts(input)?.monthKey || '';
}
