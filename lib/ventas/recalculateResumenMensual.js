import { rebuildVentasResumen } from '../api/core.js';

export async function recalculateResumenMensual(monthKey) {
  return rebuildVentasResumen(monthKey);
}
