import { getVentasResumen, rebuildVentasResumen } from '../api/core.js';

export async function getResumenMensual(month) {
  const startedAt = Date.now();
  const cached = await getVentasResumen(month);

  if (cached?.updated_at) {
    return {
      ok: true,
      month: cached.month_key,
      totalMes: Number(cached.total_mes || 0),
      sinAsignar: Number(cached.sin_asignar || 0),
      porVendedora: [
        { nombre: 'Haru', monto: Number(cached.total_haru || 0) },
        { nombre: 'Vendedora', monto: Number(cached.total_vendedora || 0) },
      ],
      ticketPromedio: Number(cached.ticket_promedio || 0),
      ventasCount: Number(cached.orders_count || 0),
      meta: {
        source: 'db_cache',
        durationMs: Date.now() - startedAt,
      },
    };
  }

  try {
    const rebuilt = await rebuildVentasResumen(month);
    return {
      ok: true,
      month: rebuilt.month_key,
      totalMes: Number(rebuilt.total_mes || 0),
      sinAsignar: Number(rebuilt.sin_asignar || 0),
      porVendedora: [
        { nombre: 'Haru', monto: Number(rebuilt.total_haru || 0) },
        { nombre: 'Vendedora', monto: Number(rebuilt.total_vendedora || 0) },
      ],
      ticketPromedio: Number(rebuilt.ticket_promedio || 0),
      ventasCount: Number(rebuilt.orders_count || 0),
      meta: {
        source: 'rebuild_once',
        durationMs: Date.now() - startedAt,
      },
    };
  } catch {
    return {
      ok: true,
      month: cached?.month_key || String(month || ''),
      totalMes: Number(cached?.total_mes || 0),
      sinAsignar: Number(cached?.sin_asignar || 0),
      porVendedora: [
        { nombre: 'Haru', monto: Number(cached?.total_haru || 0) },
        { nombre: 'Vendedora', monto: Number(cached?.total_vendedora || 0) },
      ],
      ticketPromedio: Number(cached?.ticket_promedio || 0),
      ventasCount: Number(cached?.orders_count || 0),
      meta: {
        source: 'fallback_cache',
        durationMs: Date.now() - startedAt,
      },
    };
  }
}
