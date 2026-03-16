export const APARTADOS_PDF_FOLDER_ID = "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If";

export const APARTADOS_PDF_DRIVE_ID = String(process.env.APARTADOS_PDF_SHARED_DRIVE_ID || "").trim();

export function normalizeApartadoFolio(value) {
  return String(value || "").trim().toUpperCase();
}

export function buildOfficialApartadoPdfFileName(folio) {
  const normalizedFolio = normalizeApartadoFolio(folio);
  return normalizedFolio ? `${normalizedFolio}.pdf` : "";
}
