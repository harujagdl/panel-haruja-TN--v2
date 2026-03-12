import { getCatalogos as getCatalogosRaw } from './catalogos.js';
import { archivePrenda, createPrenda, deletePrenda, listPrendas } from './prendas.js';
import { importCorrections, listArchivedPrendas, restorePrenda } from './prendasAdmin.js';

function getBaseUrl(reqLike = {}) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const headers = reqLike.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function safeJson(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error(text || `Respuesta inválida del backend (${response.status}).`);
  }
  return JSON.parse(text || '{}');
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  if (!month) return '';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Mes inválido. Usa formato YYYY-MM.');
  return month;
}

export async function getCatalogos() {
  return getCatalogosRaw();
}

export { listPrendas, createPrenda, deletePrenda, archivePrenda, listArchivedPrendas, restorePrenda, importCorrections };

export async function getVentasComisiones(params = {}, reqLike = {}) {
  const storeId = String(params.storeId || '').trim();
  const month = normalizeMonth(params.month);
  if (!storeId) throw new Error('storeId es requerido.');

  const baseUrl = getBaseUrl(reqLike);
  if (!baseUrl) throw new Error('No se pudo resolver la URL base de la app.');

  const url = new URL('/dashboard/sales-details', baseUrl);
  url.searchParams.set('storeId', storeId);
  if (month) url.searchParams.set('month', month);

  const response = await fetch(url.toString(), { method: 'GET' });
  const payload = await safeJson(response);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || 'No se pudieron cargar ventas.');
  }

  return {
    summary: {
      totalMes: Number(payload?.totalMes) || 0,
      totalSinAsignar: Number(payload?.totalSinAsignar) || 0,
      totalPorVendedora: Array.isArray(payload?.totalPorVendedora) ? payload.totalPorVendedora : [],
    },
    orders: Array.isArray(payload?.orders) ? payload.orders : [],
  };
}

export async function updateVentasComisiones(payload = {}, reqLike = {}) {
  const orderId = String(payload.orderId || '').trim();
  const seller = String(payload.seller || '').trim();
  if (!orderId) throw new Error('orderId es requerido.');

  const baseUrl = getBaseUrl(reqLike);
  if (!baseUrl) throw new Error('No se pudo resolver la URL base de la app.');

  const url = new URL('/dashboard/order-seller', baseUrl);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, seller }),
  });
  const result = await safeJson(response);
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || 'No se pudo guardar la vendedora.');
  }

  return { orderId, seller };
}
