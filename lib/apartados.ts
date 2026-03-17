import { getApartadoDetail } from './api/apartados.js';

export async function getApartadoByFolio(folio: string) {
  const response = await getApartadoDetail(folio);

  if ('status' in response && Number(response.status) >= 400) {
    const message = response?.body?.message || `No se encontró el folio ${folio}.`;
    throw new Error(String(message));
  }

  return response?.apartado || response;
}
