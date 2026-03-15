import { getVentasDetalle } from '../api/core.js';

export async function getDetalleVentas({ month, q, limit = 200 } = {}) {
  const startedAt = Date.now();
  const rows = await getVentasDetalle(month, q || '');
  const capped = rows.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)));

  return {
    ok: true,
    month: String(month || ''),
    q: String(q || ''),
    rows: capped,
    totalRows: capped.length,
    meta: {
      source: 'db',
      durationMs: Date.now() - startedAt,
    },
  };
}
