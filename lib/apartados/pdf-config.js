export const APARTADOS_PDF_FOLDER_ID = "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If";

export function normalizeApartadoFolio(value) {
  return String(value || "").trim().toUpperCase();
}

export function buildOfficialApartadoPdfFileName(folio) {
  const normalizedFolio = normalizeApartadoFolio(folio);
  return normalizedFolio ? `${normalizedFolio}.pdf` : "";
}
