# Flujo de PDF de apartados en Google Drive (Apps Script)

Esta integración deja preparado el backend para persistir y reemplazar el PDF del ticket en Drive sin depender del frontend.

## Alcance actual (piloto)

- Folio habilitado por ahora: `HARUJA0001`.
- Carpeta destino Drive: `1y3l0r-4XnSsicnuSeVaATSh3rC89j-If`.
- Nombre esperado del archivo: `${folio}.pdf` (ej. `HARUJA26-002.pdf`).
- Estrategia de reemplazo: si existe un archivo previo con el mismo nombre, se elimina y se crea la versión nueva.

## Variables de entorno en Vercel

- `APARTADOS_PDF_SYNC_URL`: URL del Web App de Google Apps Script.
- `APARTADOS_PDF_SYNC_TOKEN`: token compartido opcional para validar requests (`Authorization: Bearer ...`).

## Cuándo se dispara

`api/apartados/[folio].js` ejecuta sincronización en:

1. Alta de apartado (`reason: create`)
2. Registro de abono (`reason: abono`)
3. Consulta de status (`reason: status_lookup`, útil para recuperar URL del PDF más reciente)

Además existe puente manual para regenerar:

- `POST /api/pdf-apartado/{folio}/refresh`

## Contrato esperado con Apps Script

Request `POST` JSON:

```json
{
  "action": "sync|get|refresh",
  "folio": "HARUJA0001",
  "reason": "create|abono|status_lookup|manual_refresh",
  "apartado": { "...": "datos del apartado" },
  "driveFolderId": "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If",
  "fileName": "HARUJA0001.pdf",
  "replaceExisting": true,
  "source": "panel-haruja",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Response esperada:

```json
{
  "ok": true,
  "folio": "HARUJA0001",
  "exists": true,
  "pdfUrl": "https://drive.google.com/file/d/.../view",
  "fileId": "...",
  "fileName": "HARUJA0001.pdf",
  "folderId": "1y3l0r-4XnSsicnuSeVaATSh3rC89j-If",
  "replaced": true,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## Función sugerida en Apps Script

Crear una función principal para el PDF oficial:

```javascript
function generarPdfPersistentePorFolio(folio) {
  // 1) validar folio piloto HARUJA0001
  // 2) leer datos del apartado desde Sheets
  // 3) construir ticket HTML actualizado
  // 4) generar blob PDF
  // 5) buscar en Drive por fileName dentro de driveFolderId
  // 6) si existe, eliminar archivo anterior
  // 7) crear nuevo archivo PDF
  // 8) devolver { ok, folio, fileName, pdfUrl, fileId, replaced }
}
```

Y para dejar preparado el disparador de cambios:

```javascript
function refreshPdfApartado(folio) {
  return generarPdfPersistentePorFolio(folio);
}
```

## Endpoints puente en Vercel

- `GET /api/pdf-apartado/{folio}`: consulta si existe el PDF persistente y regresa `pdfUrl`, `exists`, `updatedAt`, `fileId`, `fileName`, `replaced`.
- `POST /api/pdf-apartado/{folio}/refresh`: fuerza regeneración/reemplazo del PDF vigente y regresa la URL actualizada.

Ambos endpoints delegan en `lib/apartados/pdf-sync.js` y mantienen la lógica sensible fuera del frontend.

## Nota

Si no se definen variables de entorno, la app sigue funcionando sin bloquear el alta/abono; solo omite la sincronización de Drive.
